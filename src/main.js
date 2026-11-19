'use strict';
// Processus principal : fenêtre, connexion au simulateur, moteur du vol et sauvegardes.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { SimLink } = require('./sim');
const { FlightEngine, PHASES } = require('./flight');
const { fetchOfp } = require('./simbrief');
const { DemoFlight, demoPlan } = require('./demo');
const { autoUpdater } = require('electron-updater');
const { MaxVoice } = require('./voice');
const CHANGELOG = require('./changelog.json');

const VERSION = require('../package.json').version;
let win = null;
const sim = new SimLink();

// ---------- sauvegarde locale (dossier de l'utilisateur) ----------
const dataDir = () => app.getPath('userData');
const storeFile = () => path.join(dataDir(), 'donnees.json');
const defaults = {
  settings: { pilot: '', simbrief: '', announcements: true, volume: 0.8, hard1: 600, hard2: 900, maxVoice: true, maxVolume: 0.9 },
  fleet: [],
  sounds: {},
  feedback: []
};
let store = JSON.parse(JSON.stringify(defaults));
function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    store = Object.assign({}, defaults, raw, { settings: Object.assign({}, defaults.settings, raw.settings || {}) });
  } catch (e) { /* premier lancement */ }
}
function saveStore() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2));
}
const reportsDir = () => path.join(dataDir(), 'rapports');
const soundsDir = () => path.join(dataDir(), 'sons');

function listReports() {
  try {
    return fs.readdirSync(reportsDir()).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 50)
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(reportsDir(), f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// Remet en service les avions dont la réparation est terminée.
function refreshFleet() {
  const now = Date.now();
  let changed = false;
  for (const a of store.fleet) {
    if (a.repairUntil && a.repairUntil <= now) { a.repairUntil = null; a.reason = ''; a.health = 100; changed = true; }
  }
  if (changed) saveStore();
}

// ---------- vol en cours ----------
let flight = null; // { engine, plan, mode, aircraft, demo, timer, log }
let lastSent = 0;

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

function handleTelemetry(t) {
  if (!flight) {
    const now = Date.now();
    if (now - lastSent > 500) { lastSent = now; send('flight:tick', { t, phase: null }); }
    return;
  }
  const evs = flight.engine.update(t, t.time);
  for (const e of evs) {
    flight.log.push({ time: new Date().toISOString(), ...e });
    if (e.type === 'landing') onLanding(e);
    send('flight:event', e);
    if (e.type === 'phase' && e.phase === PHASES.length - 1) finishFlight();
  }
  const now = Date.now();
  if (now - lastSent > 200) {
    lastSent = now;
    send('flight:tick', { t, phase: flight.engine.phase, tod: flight.engine.todInfo, stats: flight.engine.report() });
  }
}

function onLanding(e) {
  if (!flight || !flight.aircraft || e.level === 'normal') return;
  const a = store.fleet.find((x) => x.reg === flight.aircraft);
  if (!a) return;
  const days = e.level === 'tres-dur' ? 5 : 2;
  a.repairUntil = Date.now() + days * 86400000;
  a.reason = 'Atterrissage dur (' + e.rate + ' ft/min)';
  a.health = e.level === 'tres-dur' ? 40 : 65;
  saveStore();
  send('fleet:changed', store.fleet);
  send('flight:event', { type: 'hangar', reg: a.reg, days });
}

function finishFlight() {
  if (!flight || flight.finished) return;
  flight.finished = true;
  const p = flight.plan;
  const rep = Object.assign({
    id: Date.now(),
    date: new Date().toISOString(),
    version: VERSION,
    pilot: store.settings.pilot,
    mode: flight.mode,
    callsign: p ? p.callsign : '',
    from: p ? p.origin.icao : '',
    to: p ? p.destination.icao : '',
    aircraft: flight.aircraft || (p ? p.aircraft : ''),
    simAircraft: flight.title || ''
  }, flight.engine.report(), { events: flight.log.filter((x) => x.type !== 'phase' || true).slice(-200) });
  fs.mkdirSync(reportsDir(), { recursive: true });
  const name = rep.date.slice(0, 19).replace(/[:T]/g, '-') + '_' + (rep.from || 'XXXX') + '-' + (rep.to || 'XXXX') + '.json';
  fs.writeFileSync(path.join(reportsDir(), name), JSON.stringify(rep, null, 2));
  send('flight:report', rep);
}

function stopFlight() {
  if (flight && flight.timer) clearInterval(flight.timer);
  flight = null;
}

// ---------- mises à jour automatiques (GitHub : air-france-virtuel/tracker) ----------
const upd = { state: 'idle', version: null, percent: 0, notes: '', error: '' };
function updSend() { send('update:status', upd); }
function setupUpdater() {
  if (!app.isPackaged) { upd.state = 'dev'; return; }
  autoUpdater.allowPrerelease = true; // canal bêta
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const notesOf = (info) => {
    const n = info && info.releaseNotes;
    if (!n) return '';
    if (Array.isArray(n)) return n.map((x) => (x.version ? x.version + '\n' : '') + (x.note || '')).join('\n\n');
    return String(n);
  };
  autoUpdater.on('checking-for-update', () => { upd.state = 'checking'; upd.error = ''; updSend(); });
  autoUpdater.on('update-available', (i) => { Object.assign(upd, { state: 'downloading', version: i.version, notes: notesOf(i), percent: 0 }); updSend(); });
  autoUpdater.on('update-not-available', () => { upd.state = 'uptodate'; upd.checkedAt = Date.now(); updSend(); });
  autoUpdater.on('download-progress', (p) => { upd.percent = Math.round(p.percent || 0); updSend(); });
  autoUpdater.on('update-downloaded', (i) => { Object.assign(upd, { state: 'ready', version: i.version, notes: notesOf(i) || upd.notes, percent: 100 }); updSend(); });
  autoUpdater.on('error', (e) => { upd.state = 'error'; upd.error = String((e && e.message) || e).split('\n')[0]; updSend(); });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 2 * 60 * 60 * 1000);
}

// ---------- fenêtre ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1100, minHeight: 720,
    title: 'Air France Virtuel – Tracker ' + VERSION,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    backgroundColor: '#F2F4F8',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  loadStore();
  refreshFleet();

  // ---------- voix de Max ----------
  const voice = new MaxVoice(path.join(dataDir(), 'voix'));
  voice.on('status', (s) => send('voice:status', s));
  ipcMain.handle('voice:status', () => voice.status());
  ipcMain.handle('voice:download', () => voice.download());
  ipcMain.handle('voice:remove', () => voice.remove());
  ipcMain.handle('voice:speak', async (_e, text, force) => {
    if (!force && !store.settings.maxVoice) return null;
    if (!voice.status().installed) return null;
    try { return await voice.speak(text); } catch (e) { console.error('voix de Max :', e); return null; }
  });
  ipcMain.handle('voice:preload', () => { if (store.settings.maxVoice && voice.status().installed) voice.load().catch(() => {}); return true; });

  ipcMain.handle('app:init', () => {
    refreshFleet();
    return { version: VERSION, showNews: !!store.lastSeenVersion && store.lastSeenVersion !== VERSION, firstRun: !store.lastSeenVersion, store, reports: listReports(), sim: { connected: sim.connected }, flight: flight ? { phase: flight.engine.phase, plan: flight.plan, mode: flight.mode } : null };
  });
  ipcMain.handle('update:get', () => upd);
  ipcMain.handle('update:check', () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); return upd; });
  ipcMain.handle('update:install', () => { if (upd.state === 'ready') { stopFlight(); setImmediate(() => autoUpdater.quitAndInstall(true, true)); } return true; });
  ipcMain.handle('changelog:get', () => CHANGELOG);
  ipcMain.handle('changelog:seen', () => { store.lastSeenVersion = VERSION; saveStore(); return true; });
  ipcMain.handle('settings:set', (_e, s) => { store.settings = Object.assign({}, store.settings, s); saveStore(); return store.settings; });
  ipcMain.handle('fleet:set', (_e, fleet) => { store.fleet = Array.isArray(fleet) ? fleet : []; saveStore(); return store.fleet; });
  ipcMain.handle('simbrief:load', async () => fetchOfp(store.settings.simbrief));
  ipcMain.handle('demo:plan', () => demoPlan());

  ipcMain.handle('flight:start', (_e, o) => {
    stopFlight();
    const plan = o.plan || null;
    flight = {
      mode: o.mode, plan, aircraft: o.aircraft || '', log: [],
      engine: new FlightEngine({ plan, hardLanding: store.settings.hard1, veryHardLanding: store.settings.hard2 })
    };
    if (o.mode === 'demo') {
      const demo = new DemoFlight({ hardLanding: !!o.demoHard });
      const speed = Math.max(1, Math.min(60, o.speed || 20));
      flight.title = 'Vol de démonstration';
      flight.timer = setInterval(() => {
        for (let i = 0; i < Math.ceil(speed / 10); i++) {
          if (!flight || demo.done) break;
          handleTelemetry(demo.step());
        }
        if (demo.done && flight) { clearInterval(flight.timer); flight.timer = null; }
      }, 100);
    }
    return { ok: true };
  });
  ipcMain.handle('flight:stop', () => { stopFlight(); return { ok: true }; });

  ipcMain.handle('sound:pick', async (_e, key) => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisir un son', properties: ['openFile'], filters: [{ name: 'Sons', extensions: ['mp3', 'wav', 'ogg'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const size = fs.statSync(src).size;
    if (size > 10 * 1024 * 1024) throw new Error('Fichier trop lourd (10 Mo maximum).');
    fs.mkdirSync(soundsDir(), { recursive: true });
    const dest = path.join(soundsDir(), key + path.extname(src).toLowerCase());
    for (const f of fs.readdirSync(soundsDir())) if (f.startsWith(key + '.')) fs.unlinkSync(path.join(soundsDir(), f));
    fs.copyFileSync(src, dest);
    store.sounds[key] = { file: dest, name: path.basename(src) };
    saveStore();
    return store.sounds;
  });
  ipcMain.handle('sound:reset', (_e, key) => {
    const s = store.sounds[key];
    if (s && s.file) { try { fs.unlinkSync(s.file); } catch (e) { /* déjà supprimé */ } }
    delete store.sounds[key];
    saveStore();
    return store.sounds;
  });

  ipcMain.handle('feedback:save', (_e, f) => {
    const item = Object.assign({ date: new Date().toISOString(), version: VERSION, pilot: store.settings.pilot }, f);
    store.feedback.unshift(item);
    store.feedback = store.feedback.slice(0, 100);
    saveStore();
    return store.feedback;
  });
  ipcMain.handle('reports:list', () => listReports());
  ipcMain.handle('folder:open', (_e, which) => {
    const dir = which === 'rapports' ? reportsDir() : dataDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  sim.on('status', (s) => send('sim:status', s));
  sim.on('data', (t) => { if (flight && flight.mode === 'demo') return; if (flight) flight.title = t.title; handleTelemetry(t); });
  sim.start();

  createWindow();
  setupUpdater();
});

app.on('window-all-closed', () => { sim.stop(); app.quit(); });

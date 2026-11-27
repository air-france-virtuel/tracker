'use strict';
// Processus principal : fenêtre, connexion au simulateur, moteur du vol et sauvegardes.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const { SimLink } = require('./sim');
const { FlightEngine, PHASES } = require('./flight');
const { fetchOfp } = require('./simbrief');
const { DemoFlight, demoPlan } = require('./demo');
const { autoUpdater } = require('electron-updater');
const { MaxVoice } = require('./voice');
const { MaxEcoute } = require('./ecoute');
const { Proc } = require('./proc');
const { Pistes } = require('./pistes');
const career = require('./career');
const { Liveries } = require('./liveries');
const ua = require('./ua');
const CHANGELOG = require('./changelog.json');
const achievements = require('./achievements');

const VERSION = require('../package.json').version;

// Filet de sécurité : une erreur imprévue (par exemple un paquet abîmé envoyé par le simulateur)
// est notée dans « erreurs.log » au lieu d'afficher une fenêtre d'erreur et de bloquer le tracker.
process.on('uncaughtException', (e) => {
  try {
    const f = path.join(app.getPath('userData'), 'erreurs.log');
    fs.appendFileSync(f, new Date().toISOString() + ' v' + VERSION + ' ' + ((e && e.stack) || e) + '\n');
  } catch (err) { /* rien */ }
  console.error(e);
});
let win = null;
const sim = new SimLink();

// ---------- sauvegarde locale (dossier de l'utilisateur) ----------
const dataDir = () => app.getPath('userData');
const storeFile = () => path.join(dataDir(), 'donnees.json');
const defaults = {
  settings: { pilot: '', simbrief: '', announcements: true, volume: 0.8, hard1: 600, hard2: 900, maxVoice: true, maxVolume: 0.9, closeToTray: true, discord: true, chat: true, liveShare: true, maxOverlay: true, maxPos: null, community: '', uaDir: '' },
  fleet: [],
  sounds: {},
  feedback: [],
  career: { accepted: [], active: null }
};
let store = JSON.parse(JSON.stringify(defaults));
function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    store = Object.assign({}, defaults, raw, { settings: Object.assign({}, defaults.settings, raw.settings || {}), career: Object.assign({ accepted: [], active: null }, raw.career || {}) });
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

// Tous les rapports (pour la carrière), du plus récent au plus ancien.
function allReports() {
  try {
    return fs.readdirSync(reportsDir()).filter((f) => f.endsWith('.json')).sort().reverse()
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(reportsDir(), f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}
let careerData = null;
const missionsList = () => (careerData && careerData.get('missions.json').data) || [];
const careerState = (now) => career.compute(allReports(), store.career, missionsList(), now || Date.now());

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
  saveFlightState(evs.some((e) => e.type === 'phase'));
  if (live && !flight.demo && flight.mode !== 'demo') {
    const p = flight.plan || {};
    live.update({ cs: p.callsign || '', from: (p.origin || {}).icao || '', to: (p.destination || {}).icao || '', ac: p.aircraft || '', reg: flight.aircraft || p.registration || '',
      lat: t.lat, lon: t.lon, alt: Math.round(t.alt || 0), gs: Math.round(t.gs || 0), hdg: Math.round(t.hdg || 0), ph: flight.engine.phase });
  }
  const now = Date.now();
  if (now - lastSent > 200) {
    lastSent = now;
    send('flight:tick', { t, phase: flight.engine.phase, tod: flight.engine.todInfo, stats: flight.engine.report() });
  }
}

// ---------- vol en cours gardé sur le disque : si le tracker est fermé en plein vol, il reprend là où il en était ----------
const resumeFile = () => path.join(dataDir(), 'vol-en-cours.json');
const RESUME_MAX_MS = 12 * 3600000;
let lastResumeSave = 0;
function saveFlightState(force) {
  if (!flight || flight.finished || flight.demo || flight.mode === 'demo') return;
  const now = Date.now();
  if (!force && now - lastResumeSave < 15000) return;
  lastResumeSave = now;
  const e = flight.engine;
  const state = { at: now, version: VERSION, mode: flight.mode, plan: flight.plan, aircraft: flight.aircraft, missionId: flight.missionId, title: flight.title || '', log: flight.log.slice(-200),
    engine: { phase: e.phase, flags: e.flags, warnAt: e.warnAt, last: e.last, lastAirborne: e.lastAirborne, stats: e.stats, todInfo: e.todInfo } };
  try { fs.writeFileSync(resumeFile() + '.tmp', JSON.stringify(state)); fs.renameSync(resumeFile() + '.tmp', resumeFile()); } catch (err) { /* disque plein ou protégé : tant pis */ }
}
function clearFlightState() { try { fs.unlinkSync(resumeFile()); } catch (e) { /* rien à effacer */ } }
function restoreFlightState() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(resumeFile(), 'utf8')); } catch (e) { return false; }
  if (!st || st.mode === 'demo' || !st.engine || Date.now() - st.at > RESUME_MAX_MS || st.engine.phase >= PHASES.length - 1) { clearFlightState(); return false; }
  const engine = new FlightEngine({ plan: st.plan, hardLanding: store.settings.hard1, veryHardLanding: store.settings.hard2 });
  Object.assign(engine, st.engine, { since: {} });
  flight = { mode: st.mode, plan: st.plan, aircraft: st.aircraft || '', log: st.log || [], missionId: st.missionId || null, title: st.title, engine, resumed: true };
  flight.log.push({ time: new Date().toISOString(), type: 'resume', text: 'Tracker relancé : vol repris' });
  return true;
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
  clearFlightState();
  if (live) live.update(null);
  const p = flight.plan;
  const rep = Object.assign({
    id: Date.now(),
    date: new Date().toISOString(),
    version: VERSION,
    pilot: store.settings.pilot,
    mode: flight.mode,
    callsign: p ? p.callsign : '',
    flightNumber: p ? p.flightNumber : '',
    registration: p ? p.registration : '',
    from: p ? p.origin.icao : '',
    to: p ? p.destination.icao : '',
    aircraft: flight.aircraft || (p ? p.aircraft : ''),
    simAircraft: flight.title || '',
    planAircraft: p ? p.aircraft : ''
  }, flight.engine.report(), { events: flight.log.filter((x) => x.type !== 'phase' || true).slice(-200) });
  if (flight.missionId) {
    const st = careerState(Date.now());
    const m = st.missions.find((x) => x.id === flight.missionId);
    rep.mission = career.judge(m, rep, m ? m.bonus : 1, store.settings.hard2);
    if (rep.mission && rep.mission.validated) {
      const left = m.gives && (m.validated + 1) < (m.repeat || 1);
      if (!left) {
        store.career.accepted = store.career.accepted.filter((id) => id !== m.id);
        if (store.career.active === m.id) store.career.active = null;
      }
      saveStore();
    }
  }
  fs.mkdirSync(reportsDir(), { recursive: true });
  const name = rep.date.slice(0, 19).replace(/[:T]/g, '-') + '_' + (rep.from || 'XXXX') + '-' + (rep.to || 'XXXX') + '.json';
  fs.writeFileSync(path.join(reportsDir(), name), JSON.stringify(rep, null, 2));
  send('flight:report', rep);
  if (rep.mission) send('career:changed', careerState());
  // succès débloqués par ce vol
  try {
    const list = achievements.compute(allReports(), careerState());
    const seen = new Set(store.achSeen || []);
    const fresh = list.filter((a) => a.done && !seen.has(a.id));
    if (fresh.length) { store.achSeen = list.filter((a) => a.done).map((a) => a.id); saveStore(); send('ach:new', fresh); }
  } catch (e) { console.error('succès :', e); }
}

function stopFlight(keep) {
  if (flight && flight.timer) clearInterval(flight.timer);
  if (keep) saveFlightState(true); else clearFlightState();
  if (live) live.update(null);
  flight = null;
}

// ---------- mises à jour automatiques (GitHub : air-france-virtuel/tracker) ----------
const upd = { state: 'idle', version: null, percent: 0, notes: '', error: '', failed: null, direct: 'https://github.com/air-france-virtuel/tracker/releases/latest/download/LesAilesTricolores-Tracker-Setup.exe' };
let updInstalling = false;
// Au démarrage : une mise à jour téléchargée lors de la session précédente aurait dû s'installer à la fermeture.
// Si la version n'a pas changé, l'installation a échoué (souvent bloquée par Windows Smart App Control).
function checkPendingUpdate() {
  const p = store.pendingUpdate;
  if (!p || !p.version) return;
  if (p.version !== VERSION) upd.failed = { version: p.version };
  delete store.pendingUpdate; saveStore();
}
function updSend() { send('update:status', upd); }
function setupUpdater() {
  if (!app.isPackaged) { upd.state = 'dev'; return; }
  autoUpdater.allowPrerelease = true; // les trackers bêta (0.x-beta) passent ainsi à la 1.0.0 et aux suivantes
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
  autoUpdater.on('update-downloaded', (i) => { Object.assign(upd, { state: 'ready', version: i.version, notes: notesOf(i) || upd.notes, percent: 100 }); store.pendingUpdate = { version: i.version, at: Date.now() }; saveStore(); updSend(); });
  autoUpdater.on('error', (e) => {
    if (updInstalling) { updInstalling = false; upd.state = 'blocked'; upd.failed = { version: upd.version }; upd.error = String((e && e.message) || e).split('\n')[0].slice(0, 300); updSend(); return; }
    upd.state = 'error'; upd.error = String((e && e.message) || e).split('\n')[0].slice(0, 300); updSend();
    clearTimeout(retryTimer); retryTimer = setTimeout(check, 15 * 60 * 1000); // nouvel essai dans 15 minutes
  });
  let retryTimer = null;
  function check() { return autoUpdater.checkForUpdates().catch(() => {}); }
  setTimeout(check, 5000);
  setInterval(check, 2 * 60 * 60 * 1000);
}


// ---------- icône près de l'horloge de Windows (zone de notification) ----------
let tray = null;
let quitting = false;
let chatUpdate = () => {};
let live = null; // pilotes en vol (positions partagées entre pilotes de la compagnie)
let trayState = { flying: false, callsign: '', route: '', phase: '', remaining: '', alt: '', aircraft: '', startedAt: 0, grade: '', plan: false, compact: false };
app.on('before-quit', () => { quitting = true; });
function showMain(tab, action) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (tab || action) {
    const go = () => send('tray:go', { tab: tab || null, action: action || null });
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(go, 300)); else go();
  }
}
function trayMenu() {
  const t = trayState;
  const login = process.platform === 'win32' ? app.getLoginItemSettings().openAtLogin : false;
  return Menu.buildFromTemplate([
    { label: 'Les Ailes Tricolores – Tracker ' + VERSION, enabled: false },
    { label: t.flying ? '✈  ' + [t.callsign, t.route, t.phase, t.remaining].filter(Boolean).join(' · ') : 'Aucun vol en cours', enabled: false },
    { label: sim.connected ? '●  Simulateur connecté' : '○  Simulateur non connecté', enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir le tracker', click: () => showMain() },
    { label: t.flying ? 'Revenir à mon vol' : 'Démarrer un vol', click: () => showMain('vol') },
    { label: 'Briefing de Max', enabled: !!t.plan, click: () => showMain('vol', 'briefing') },
    { label: 'Panneau compact', type: 'checkbox', checked: !!t.compact, click: () => showMain(null, 'compact') },
    { type: 'separator' },
    { label: 'Infos du jour', click: () => showMain('infos') },
    { label: 'Planning du jour', click: () => showMain('planning') },
    { label: 'Vols de la compagnie', click: () => showMain('reels') },
    { label: 'Ma carrière', click: () => showMain('carriere') },
    { label: 'Missions & rôles', click: () => showMain('missions') },
    { type: 'separator' },
    { label: 'Rechercher une mise à jour', click: () => { showMain('maj'); if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); } },
    { label: 'Réglages', click: () => showMain('reglages') },
    { label: 'Options', submenu: [
      { label: 'Garder le tracker ici quand je ferme la fenêtre', type: 'checkbox', checked: !!store.settings.closeToTray, click: (m) => { store.settings.closeToTray = m.checked; saveStore(); send('settings:changed', store.settings); } },
      { label: 'Lancer le tracker au démarrage de Windows', type: 'checkbox', checked: login, enabled: process.platform === 'win32' && app.isPackaged, click: (m) => { app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--cache'] }); } },
      { label: 'Afficher mon vol sur Discord', type: 'checkbox', checked: !!store.settings.discord, click: (m) => { store.settings.discord = m.checked; saveStore(); discordApply(); send('settings:changed', store.settings); } }
    ] },
    { type: 'separator' },
    { label: 'Quitter le tracker', click: async () => {
      if (t.flying) {
        const r = await dialog.showMessageBox({ type: 'warning', buttons: ['Quitter quand même', 'Annuler'], defaultId: 1, cancelId: 1, title: 'Vol en cours', message: 'Un vol est en cours de suivi.', detail: 'Si tu quittes maintenant, ce vol ne sera pas enregistré.' });
        if (r.response !== 0) return;
      }
      quitting = true; app.quit();
    } }
  ]);
}
function trayRefresh() {
  if (!tray) return;
  const t = trayState;
  const tip = 'Les Ailes Tricolores – Tracker\n' + (t.flying ? [t.callsign, t.route, t.phase, t.remaining].filter(Boolean).join(' · ') : (sim.connected ? 'Simulateur connecté' : 'Simulateur non connecté'));
  tray.setToolTip(tip.slice(0, 127));
  tray.setContextMenu(trayMenu());
}
function createTray() {
  try {
    const ico = path.join(__dirname, '..', 'renderer', 'assets', process.platform === 'win32' ? 'tray.ico' : 'icon.png');
    let img = nativeImage.createFromPath(ico);
    if (process.platform !== 'win32') img = img.resize({ width: 22, height: 22 });
    tray = new Tray(img);
    tray.on('click', () => showMain());
    tray.on('double-click', () => showMain());
    trayRefresh();
  } catch (e) { tray = null; }
}


// ---------- Discord : « Joue à Les Ailes Tricolores » ----------
const discordMod = require('./discord');
const discord = new discordMod.DiscordPresence({ log: (m) => console.log(m) });
const discordCfg = () => (careerData && careerData.get('discord.json').data) || {};
function discordApply() { discord.configure(discordCfg().clientId, store.settings.discord); discordUpdate(); }
let discordLast = '';
function discordUpdate() {
  if (!discord.enabled) return;
  const a = discordMod.buildActivity(trayState, discordCfg());
  const k = JSON.stringify(a);
  if (k !== discordLast) { discordLast = k; discord.set(a); }
}
function discordStop() { try { discord.stop(); } catch (e) { /* rien */ } }

// ---------- fenêtre ----------
function createWindow(hidden) {
  win = new BrowserWindow({
    show: !hidden,
    width: 1360, height: 860, minWidth: 1100, minHeight: 720,
    title: 'Les Ailes Tricolores – Tracker ' + VERSION,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    backgroundColor: '#F2F4F8',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // la croix range le tracker près de l'horloge de Windows (réglable depuis l'icône)
  win.on('close', (e) => {
    if (quitting || !tray || !store.settings.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!store.trayHintShown && process.platform === 'win32') {
      store.trayHintShown = true; saveStore();
      try { tray.displayBalloon({ iconType: 'info', title: 'Le tracker reste ouvert', content: 'Il continue près de l’horloge. Clic droit sur l’icône des Ailes Tricolores pour les raccourcis ou pour quitter.' }); } catch (err) { /* rien */ }
    }
  });
  // fermer la fenêtre principale ferme aussi le panneau compact
  win.on('closed', () => { win = null; for (const w of BrowserWindow.getAllWindows()) w.close(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => showMain());

app.whenReady().then(() => {
  loadStore();
  restoreFlightState();
  checkPendingUpdate();
  refreshFleet();

  // ---------- carrière ----------
  careerData = new career.CareerData(path.join(dataDir(), 'carriere'));
  ipcMain.handle('career:get', () => careerState());
  ipcMain.handle('career:accept', (_e, id) => {
    const m = careerState().missions.find((x) => x.id === id);
    if (!m || m.locked) return careerState();
    if (!store.career.accepted.includes(id)) store.career.accepted.push(id);
    store.career.active = id;
    saveStore();
    return careerState();
  });
  ipcMain.handle('career:drop', (_e, id) => {
    store.career.accepted = store.career.accepted.filter((x) => x !== id);
    if (store.career.active === id) store.career.active = null;
    saveStore();
    return careerState();
  });
  ipcMain.handle('career:active', (_e, id) => { store.career.active = id || null; saveStore(); return careerState(); });
  ipcMain.handle('infos:get', () => careerData.get('infos.json'));
  ipcMain.handle('metar:get', async (_e, ids) => {
    const list = [...new Set((ids || []).filter((x) => /^[A-Z]{4}$/.test(x)))].slice(0, 8);
    if (!list.length) return [];
    try {
      const r = await fetch('https://aviationweather.gov/api/data/metar?format=json&ids=' + list.join(','), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      return (Array.isArray(j) ? j : []).map((m) => ({ icao: m.icaoId, raw: m.rawOb, wdir: m.wdir, wspd: m.wspd, temp: m.temp, cat: m.fltCat, time: m.reportTime || m.obsTime }));
    } catch (e) { return null; }
  });
  careerData.refresh('discord.json').then(() => discordApply());

  // ---------- chat des pilotes (Supabase) ----------
  const { Chat } = require('./chat');
  const chat = new Chat(dataDir());
  const chatProfile = () => {
    let grade = ''; try { grade = careerState().gradeName || ''; } catch (e) { /* rien */ }
    chat.setProfile({ pseudo: store.settings.pilot || '', grade, flight: trayState.flying ? [trayState.callsign, trayState.route].filter(Boolean).join(' · ') : '' });
  };
  const { Live } = require('./live');
  live = new Live(chat);
  live.setShare(store.settings.liveShare !== false);
  live.on('list', (l) => send('live:list', l));
  const liveStart = () => { if ((store.settings.pilot || '').trim().length >= 2 && chatCfgOk()) live.start(); };
  setInterval(() => { if (live.ready) live.sync(); }, 30000); // retire les vols sans nouvelles
  chatUpdate = () => { chatProfile(); live.setShare(store.settings.liveShare !== false); liveStart(); if (chat.state === 'nopseudo' && (store.settings.pilot || '').trim().length >= 2) chat.start(); };
  chat.on('status', (st) => send('chat:status', st));
  chat.on('history', (list) => send('chat:history', list));
  chat.on('message', (m) => send('chat:message', m));
  chat.on('removed', (id) => send('chat:removed', id));
  const chatCfg = () => Object.assign({ rules: '' }, careerData.get('chat.json').data || {});
  const chatCfgOk = () => !!chat.cfg;
  const chatInit = () => { chat.configure(chatCfg()); chatProfile(); if (store.settings.chat !== false) chat.start(); liveStart(); };
  chatInit();
  careerData.refresh('chat.json').then(chatInit);
  ipcMain.handle('live:get', () => { liveStart(); return live.status(); });
  ipcMain.handle('chat:get', () => ({ status: chat.status(), messages: chat.visible(), rules: chatCfg().rules || '' }));
  ipcMain.handle('chat:start', () => { chatProfile(); return chat.start(); });
  ipcMain.handle('chat:send', (_e, t) => chat.send(String(t || '')));
  ipcMain.handle('chat:report', (_e, id, why) => chat.report(+id, String(why || '')));
  ipcMain.handle('chat:hide', (_e, id) => chat.hide(+id));
  ipcMain.handle('chat:ban', (_e, uid) => chat.ban(String(uid || '')));
  ipcMain.handle('chat:reports', () => chat.reports());
  // avions de la compagnie (réservation partagée entre pilotes)
  ipcMain.handle('fleet:bookings', () => { chatProfile(); return chat.aircraftList(); });
  ipcMain.handle('fleet:take', (_e, reg, until) => { chatProfile(); return chat.aircraftTake(String(reg || ''), +until || 0); });
  ipcMain.handle('hangar:get', () => { chatProfile(); return chat.hangarGet(); });
  ipcMain.handle('hangar:finish', (_e, o) => { chatProfile(); return chat.finishFlight(o || {}); });
  ipcMain.handle('hangar:admin', (_e, a, reg, v, t) => { chatProfile(); return chat.hangarAdmin(String(a || ''), String(reg || ''), v, t); });
  ipcMain.handle('fleet:release', (_e, reg, maint) => { chatProfile(); return chat.aircraftRelease(String(reg || ''), +maint || 0); });
  Promise.all([careerData.refresh('missions.json'), careerData.refresh('infos.json')])
    .then(() => { send('career:changed', careerState()); send('infos:changed', careerData.get('infos.json')); });

  // ---------- panneau compact (second écran) ----------
  let compact = null;
  ipcMain.handle('compact:open', () => {
    if (compact && !compact.isDestroyed()) { compact.show(); compact.focus(); return true; }
    compact = new BrowserWindow({
      width: 400, height: 840, minWidth: 340, minHeight: 560, alwaysOnTop: true,
      title: 'Les Ailes Tricolores – panneau compact', icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      backgroundColor: '#0A1E4A', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    compact.loadFile(path.join(__dirname, '..', 'renderer', 'compact.html'));
    compact.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    compact.on('closed', () => { compact = null; send('compact:state', false); });
    send('compact:state', true);
    return true;
  });
  ipcMain.handle('compact:close', () => { if (compact && !compact.isDestroyed()) compact.close(); return true; });
  ipcMain.handle('compact:pin', (_e, on) => { if (compact && !compact.isDestroyed()) compact.setAlwaysOnTop(!!on); return !!on; });
  ipcMain.on('compact:push', (_e, d) => { if (compact && !compact.isDestroyed()) compact.webContents.send('compact:data', d); });

  // ---------- Max par-dessus le simulateur (petite fenêtre toujours au premier plan) ----------
  let maxWin = null;
  ipcMain.handle('max:open', () => {
    if (maxWin && !maxWin.isDestroyed()) { maxWin.showInactive(); return true; }
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    const p = store.settings.maxPos || {};
    const w = 380, h = 470;
    const inside = p.x != null && screen.getAllDisplays().some((d) => p.x >= d.bounds.x - 50 && p.x < d.bounds.x + d.bounds.width - 50 && p.y >= d.bounds.y - 10 && p.y < d.bounds.y + d.bounds.height - 50);
    maxWin = new BrowserWindow({
      width: w, height: h, x: inside ? p.x : wa.x + wa.width - w - 16, y: inside ? p.y : wa.y + 80,
      frame: false, transparent: true, resizable: true, minWidth: 300, minHeight: 120, skipTaskbar: false, focusable: true,
      alwaysOnTop: true, show: false, hasShadow: false, title: 'Max – copilote', icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    maxWin.setAlwaysOnTop(true, 'screen-saver'); // au-dessus du simulateur (plein écran fenêtré)
    maxWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    maxWin.loadFile(path.join(__dirname, '..', 'renderer', 'max.html'));
    maxWin.once('ready-to-show', () => maxWin && maxWin.showInactive()); // ne vole pas le focus au simulateur
    maxWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const savePos = () => { if (maxWin && !maxWin.isDestroyed()) { const b = maxWin.getBounds(); store.settings.maxPos = { x: b.x, y: b.y }; saveStore(); } };
    maxWin.on('moved', savePos);
    maxWin.on('closed', () => { maxWin = null; send('max:state', false); });
    send('max:state', true);
    return true;
  });
  ipcMain.handle('max:close', () => { if (maxWin && !maxWin.isDestroyed()) maxWin.close(); return true; });
  ipcMain.on('max:push', (_e, d) => { if (maxWin && !maxWin.isDestroyed()) maxWin.webContents.send('max:data', d); });
  ipcMain.on('max:action', (_e, a) => {
    if (!a || typeof a.type !== 'string') return;
    if (a.type === 'close') { if (maxWin && !maxWin.isDestroyed()) maxWin.close(); return; }
    if (a.type === 'mini' && maxWin && !maxWin.isDestroyed()) { const b = maxWin.getBounds(); maxWin.setBounds({ x: b.x, y: b.y, width: b.width, height: a.on ? 132 : 470 }); }
    send('max:action', a); // la check-list et la voix sont gérées par le tracker principal
  });

  // ---------- radar météo (RainViewer, dernière image disponible) ----------
  let radarCache = null;
  ipcMain.handle('radar:get', async () => {
    if (radarCache && Date.now() - radarCache.at < 5 * 60 * 1000) return radarCache.data;
    try {
      const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const past = (j.radar && j.radar.past) || [];
      const last = past[past.length - 1];
      if (!last || !j.host) throw new Error('vide');
      radarCache = { at: Date.now(), data: { host: j.host, path: last.path, time: last.time * 1000 } };
      return radarCache.data;
    } catch (e) { return null; }
  });

  // ---------- vols de la compagnie Les Ailes Tricolores ----------
  const lat = require('./lat');
  const myDay = new lat.MyDay(path.join(dataDir(), 'planning'));
  let prog = { at: 0, list: lat.BUNDLED.flights, source: 'intégré', admin: false };
  async function program(force) {
    if (!force && Date.now() - prog.at < 10 * 60 * 1000) return prog;
    chatProfile();
    const r = await chat.flightsProgram();
    if (r.ok && r.list.length) prog = { at: Date.now(), list: lat.fromRows(r.list), rows: r.list, source: 'serveur', admin: r.admin };
    else prog = Object.assign({}, prog, { at: Date.now() - 8 * 60 * 1000, error: r.ok ? '' : r.error }); // nouvel essai dans 2 min
    return prog;
  }
  async function companyDay(force) {
    const p = await program(force);
    const now = Date.now();
    return { day: lat.dayKey(now), flights: lat.dayFlights(p.list, now), mine: myDay.get(now), airports: lat.BUNDLED.airports,
      source: { name: p.source === 'serveur' ? 'programme de la compagnie' : 'programme intégré au tracker', generatedAt: p.at || now }, admin: !!p.admin, error: p.error || '' };
  }
  ipcMain.handle('planning:get', (_e, refresh) => companyDay(!!refresh));
  ipcMain.handle('planning:toggle', async (_e, key) => { myDay.toggle(String(key || ''), Date.now()); return companyDay(false); });
  // direction : ajouter / modifier / retirer un vol du programme
  ipcMain.handle('flights:rows', async () => { const p = await program(true); return { admin: !!p.admin, rows: p.rows || [], source: p.source, error: p.error || '' }; });
  ipcMain.handle('flights:save', async (_e, f) => { const r = await chat.flightSave(f || {}); if (r.ok) await program(true); return r; });
  ipcMain.handle('flights:remove', async (_e, n) => { const r = await chat.flightRemove(String(n || '')); if (r.ok) await program(true); return r; });

  // ---------- voix de Max ----------
  const voice = new MaxVoice(path.join(dataDir(), 'voix'));
  voice.on('status', (s) => send('voice:status', s));
  ipcMain.handle('voice:status', () => voice.status());
  ipcMain.handle('voice:download', () => voice.download());
  // La voix tourne dans son propre processus, fermé après 3 minutes sans parler : la mémoire est rendue à Windows.
  const voiceProc = new Proc(path.join(__dirname, 'voice-worker.js'), [path.join(dataDir(), 'voix')], 3 * 60000, 'Voix de Max');
  ipcMain.handle('voice:speak', async (_e, text, force) => {
    if (!force && !store.settings.maxVoice) return null;
    if (!voice.status().installed) return null;
    try { return await voiceProc.call({ text: String(text || '').slice(0, 600) }); } catch (e) { console.error('voix de Max :', e); return null; }
  });
  ipcMain.handle('voice:preload', () => { if (store.settings.maxVoice && voice.status().installed) voiceProc.post({ warm: true }); return true; });
  ipcMain.handle('voice:remove', () => { voiceProc.stop(); return voice.remove(); });

  // ---------- pistes en service (trafic réel, NOTAM, vent) ----------
  const pistes = new Pistes(path.join(dataDir(), 'pistes'), (u, o) => require('electron').net.fetch(u, o));
  const pisteCache = new Map();
  ipcMain.handle('pistes:get', async (_e, plan, force) => {
    if (!plan || !plan.origin || !plan.destination) return null;
    const one = async (ap, metar, kind) => {
      const key = ap.icao + kind;
      const c = pisteCache.get(key);
      if (!force && c && Date.now() - c.at < 5 * 60000) return c;
      try { const d = await pistes.active(Object.assign({}, ap, { metar }), kind); pisteCache.set(key, d); return d; } catch (e) { return { icao: ap.icao, kind, rwy: null, error: String((e && e.message) || e) }; }
    };
    const [dep, arr] = await Promise.all([one(plan.origin, plan.metarDep, 'dep'), one(plan.destination, plan.metarArr, 'arr')]);
    return { dep, arr };
  });

  // ---------- écoute de Max (micro) ----------
  const ecoute = new MaxEcoute(path.join(dataDir(), 'ecoute'));
  // le panneau de Max (fenêtre à part) suit aussi le téléchargement
  ecoute.on('status', (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('ecoute:status', s); });
  ipcMain.handle('ecoute:status', () => ecoute.status());
  ipcMain.handle('ecoute:download', () => ecoute.download());
  ipcMain.handle('ecoute:remove', () => ecoute.remove());
  ipcMain.handle('ecoute:warm', () => { ecoute.warm(); return true; });
  ipcMain.handle('ecoute:text', async (_e, samples, rate) => {
    try { return { text: await ecoute.recognize(samples, rate) }; } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  app.on('will-quit', () => { ecoute.stop(); voiceProc.stop(); });
  app.on('before-quit', () => saveFlightState(true));

  ipcMain.handle('app:init', () => {
    refreshFleet();
    return { version: VERSION, showNews: !!store.lastSeenVersion && store.lastSeenVersion !== VERSION, firstRun: !store.lastSeenVersion, store, reports: listReports(), sim: { connected: sim.connected }, flight: flight ? { phase: flight.engine.phase, plan: flight.plan, mode: flight.mode, aircraft: flight.aircraft, missionId: flight.missionId, resumed: !!flight.resumed } : null };
  });
  ipcMain.handle('update:get', () => upd);
  ipcMain.handle('update:check', () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); return upd; });
  ipcMain.handle('update:install', () => {
    if (upd.state === 'ready') {
      stopFlight(true); updInstalling = true;
      setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { updInstalling = false; upd.state = 'blocked'; upd.failed = { version: upd.version }; upd.error = String((e && e.message) || e).slice(0, 300); updSend(); } });
    }
    return true;
  });
  ipcMain.handle('update:manual', () => { shell.openExternal(upd.direct); return true; });
  ipcMain.handle('update:failedSeen', () => { upd.failed = null; return true; });
  ipcMain.handle('changelog:get', () => CHANGELOG);
  ipcMain.handle('changelog:seen', () => { store.lastSeenVersion = VERSION; saveStore(); return true; });
  ipcMain.handle('settings:set', (_e, s) => { store.settings = Object.assign({}, store.settings, s); saveStore(); discordApply(); trayRefresh(); chatUpdate(); return store.settings; });
  ipcMain.handle('fleet:set', (_e, fleet) => { store.fleet = Array.isArray(fleet) ? fleet : []; saveStore(); return store.fleet; });
  ipcMain.handle('simbrief:load', async () => fetchOfp(store.settings.simbrief));
  ipcMain.handle('demo:plan', () => demoPlan());

  ipcMain.handle('flight:start', (_e, o) => {
    stopFlight();
    const plan = o.plan || null;
    flight = {
      mode: o.mode, plan, aircraft: o.aircraft || '', log: [], missionId: o.missionId || null,
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

  ipcMain.handle('feedback:save', (_e, f) => {
    const item = Object.assign({ date: new Date().toISOString(), version: VERSION, pilot: store.settings.pilot }, f);
    store.feedback.unshift(item);
    store.feedback = store.feedback.slice(0, 100);
    saveStore();
    return store.feedback;
  });
  ipcMain.handle('reports:list', () => listReports());
  ipcMain.handle('ach:get', () => {
    const list = achievements.compute(allReports(), careerState());
    // premier lancement : les succès déjà gagnés avant cette version ne déclenchent pas d'annonce
    if (!store.achSeen) { store.achSeen = list.filter((a) => a.done).map((a) => a.id); saveStore(); }
    return list;
  });
  // ---------- Universal Announcer ----------
  const uaState = { dir: null, auto: false, running: false };
  async function uaRefresh() {
    const manual = store.settings.uaDir && fs.existsSync(store.settings.uaDir) ? store.settings.uaDir : null;
    const auto = manual ? null : ua.findAnnouncements();
    const running = await ua.isRunning();
    const next = { dir: manual || auto, auto: !!auto, running };
    const changed = JSON.stringify(next) !== JSON.stringify(uaState);
    Object.assign(uaState, next);
    if (changed) send('ua:status', uaState);
    return uaState;
  }
  uaRefresh(); setInterval(uaRefresh, 30000);
  ipcMain.handle('ua:get', () => uaRefresh());
  ipcMain.handle('ua:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisir le dossier « Announcements » d’Universal Announcer', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return uaRefresh();
    store.settings.uaDir = r.filePaths[0]; saveStore(); return uaRefresh();
  });
  ipcMain.handle('ua:reset', () => { store.settings.uaDir = ''; saveStore(); return uaRefresh(); });
  ipcMain.handle('ua:file', (_e, key, aircraft) => (uaState.dir ? ua.fileFor(uaState.dir, ua.MAP[String(key || '')], aircraft) : null));
  ipcMain.handle('ua:files', (_e, aircraft) => {
    const out = {};
    for (const [key, name] of Object.entries(ua.MAP)) {
      const f = uaState.dir ? ua.fileFor(uaState.dir, name, aircraft) : null;
      out[key] = { ua: name, file: f, name: f ? path.basename(f) : '', folder: f ? path.basename(path.dirname(f)) : '' };
    }
    return out;
  });
  ipcMain.handle('ua:open', () => (uaState.dir ? shell.openPath(uaState.dir) : ''));

  // ---------- livrées de la compagnie ----------
  const liv = new Liveries({
    bundled: (() => { try { return require('./data/livrees.json').livrees || []; } catch (e) { return []; } })(),
    tmpDir: path.join(dataDir(), 'telechargements'),
    getCommunity: () => (store.settings.community && fs.existsSync(store.settings.community) ? store.settings.community : null),
    fetch: (u, o) => require('electron').net.fetch(u, o)
  });
  liv.on('job', (j) => send('livrees:job', j));
  ipcMain.handle('livrees:list', (_e, force) => liv.list(!!force));
  ipcMain.handle('livrees:install', (_e, id) => { liv.install(String(id || '')); return true; });
  ipcMain.handle('livrees:remove', async (_e, id) => liv.remove(String(id || ''), await liv.catalogue(false)));
  ipcMain.handle('livrees:pickCommunity', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisir le dossier Community de MSFS 2024', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.settings.community = r.filePaths[0]; saveStore();
    return liv.list(false);
  });
  ipcMain.handle('livrees:resetCommunity', () => { store.settings.community = ''; saveStore(); return liv.list(false); });
  ipcMain.handle('livrees:openCommunity', () => { const c = liv.community(); return c ? shell.openPath(c) : ''; });

  ipcMain.handle('folder:open', (_e, which) => {
    const dir = which === 'rapports' ? reportsDir() : dataDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  sim.on('status', (s) => send('sim:status', s));
  sim.on('log', (m) => console.warn(m));
  sim.on('data', (t) => { if (flight && flight.mode === 'demo') return; if (flight) flight.title = t.title; handleTelemetry(t); });
  sim.start();

  ipcMain.on('tray:status', (_e, st) => { trayState = Object.assign({}, trayState, st || {}); trayRefresh(); discordUpdate(); chatUpdate(); });
  sim.on('status', () => trayRefresh());
  const hidden = process.argv.includes('--cache');
  createWindow(hidden);
  createTray();
  discordApply();
  setupUpdater();
});

app.on('window-all-closed', () => { sim.stop(); discordStop(); app.quit(); });

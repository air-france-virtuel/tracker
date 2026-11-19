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
const career = require('./career');
const real = require('./realflights');
const newsMod = require('./news');
{ const { net } = require('electron'); if (net && typeof net.fetch === 'function') { real.setFetch((u, o) => net.fetch(u, o)); newsMod.setFetch((u, o) => net.fetch(u, o)); } }
const CHANGELOG = require('./changelog.json');

const VERSION = require('../package.json').version;
let win = null;
const sim = new SimLink();

// ---------- sauvegarde locale (dossier de l'utilisateur) ----------
const dataDir = () => app.getPath('userData');
const storeFile = () => path.join(dataDir(), 'donnees.json');
const defaults = {
  settings: { pilot: '', simbrief: '', announcements: true, volume: 0.8, hard1: 600, hard2: 900, maxVoice: true, maxVolume: 0.9, closeToTray: true, discord: true },
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
  autoUpdater.on('error', (e) => {
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
let trayState = { flying: false, callsign: '', route: '', phase: '', alt: '', aircraft: '', startedAt: 0, grade: '', plan: false, compact: false };
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
    { label: 'Air France Virtuel – Tracker ' + VERSION, enabled: false },
    { label: t.flying ? '✈  ' + [t.callsign, t.route, t.phase].filter(Boolean).join(' · ') : 'Aucun vol en cours', enabled: false },
    { label: sim.connected ? '●  Simulateur connecté' : '○  Simulateur non connecté', enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir le tracker', click: () => showMain() },
    { label: t.flying ? 'Revenir à mon vol' : 'Démarrer un vol', click: () => showMain('vol') },
    { label: 'Briefing de Max', enabled: !!t.plan, click: () => showMain('vol', 'briefing') },
    { label: 'Panneau compact', type: 'checkbox', checked: !!t.compact, click: () => showMain(null, 'compact') },
    { type: 'separator' },
    { label: 'Infos du jour', click: () => showMain('infos') },
    { label: 'Planning du jour', click: () => showMain('planning') },
    { label: 'Vols réels', click: () => showMain('reels') },
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
  const tip = 'Air France Virtuel – Tracker\n' + (t.flying ? [t.callsign, t.route, t.phase].filter(Boolean).join(' · ') : (sim.connected ? 'Simulateur connecté' : 'Simulateur non connecté'));
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


// ---------- Discord : « Joue à Air France Virtuel » ----------
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
    title: 'Air France Virtuel – Tracker ' + VERSION,
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
      try { tray.displayBalloon({ iconType: 'info', title: 'Le tracker reste ouvert', content: 'Il continue près de l’horloge. Clic droit sur l’icône AFV pour les raccourcis ou pour quitter.' }); } catch (err) { /* rien */ }
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
  Promise.all([careerData.refresh('missions.json'), careerData.refresh('infos.json')])
    .then(() => { send('career:changed', careerState()); send('infos:changed', careerData.get('infos.json')); });

  // ---------- panneau compact (second écran) ----------
  let compact = null;
  ipcMain.handle('compact:open', () => {
    if (compact && !compact.isDestroyed()) { compact.show(); compact.focus(); return true; }
    compact = new BrowserWindow({
      width: 400, height: 840, minWidth: 340, minHeight: 560, alwaysOnTop: true,
      title: 'AFV Tracker – panneau compact', icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
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

  ipcMain.handle('news:get', (_e, force) => newsMod.news(!!force));

  // ---------- vols réels ----------
  const { Planning } = require('./planning');
  const planning = new Planning(path.join(dataDir(), 'planning'));
  const typesFile = path.join(dataDir(), 'planning', 'avions.json');
  try { real.typeCacheLoad(JSON.parse(fs.readFileSync(typesFile, 'utf8'))); } catch (e) { /* premier lancement */ }
  let lastRecorded = 0;
  // À chaque relevé des vols en direct : on complète le type d'avion et on note les vols dans le planning du jour.
  async function liveAndRecord(force) {
    const r = await real.live(force);
    if (r && r.at && r.at !== lastRecorded && r.flights && r.flights.length) {
      lastRecorded = r.at;
      planning.record(r.flights, r.at); // tout de suite, sans les types d'avion
      // les types d'avion arrivent en arrière-plan (jusqu'à 120 nouveaux avions par relevé)
      recording = real.types(r.flights.filter((f) => f.from), 120).then((withTypes) => {
        planning.record(withTypes, r.at);
        fs.mkdirSync(path.dirname(typesFile), { recursive: true });
        fs.writeFileSync(typesFile, JSON.stringify(real.typeCacheDump()));
        mergedPlanning().then((d) => send('planning:changed', d));
      }).catch((e) => console.error('planning :', e));
    }
    return r;
  }
  let recording = null;
  ipcMain.handle('real:live', (_e, force) => liveAndRecord(!!force));
  // Programme officiel du jour, publié une fois par jour par GitHub (branche « donnees »)
  let sched = null;
  async function schedule() {
    if (sched && Date.now() - sched.at < 60 * 60 * 1000) return sched.data;
    try {
      const { net } = require('electron');
      const r = await net.fetch('https://raw.githubusercontent.com/air-france-virtuel/tracker/donnees/planning/latest.json?t=' + Date.now(), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(String(r.status));
      sched = { at: Date.now(), data: await r.json() };
    } catch (e) { sched = { at: Date.now() - 50 * 60 * 1000, data: sched ? sched.data : null }; } // nouvel essai dans 10 min
    return sched.data;
  }
  const liveNow = () => { const c = real.lastLive && real.lastLive(); return c && c.flights ? c.flights.map((f) => f.callsign) : []; };
  const mergedPlanning = async () => planning.merged(await schedule(), liveNow());
  ipcMain.handle('planning:get', async (_e, refresh) => { if (refresh) await liveAndRecord(false); return mergedPlanning(); });
  ipcMain.handle('planning:toggle', async (_e, key) => { planning.toggle(String(key || '')); return mergedPlanning(); });
  ipcMain.handle('real:details', (_e, cs, hex) => real.details(String(cs || ''), String(hex || '')));

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
  ipcMain.handle('settings:set', (_e, s) => { store.settings = Object.assign({}, store.settings, s); saveStore(); discordApply(); trayRefresh(); return store.settings; });
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

  ipcMain.on('tray:status', (_e, st) => { trayState = Object.assign({}, trayState, st || {}); trayRefresh(); discordUpdate(); });
  sim.on('status', () => trayRefresh());
  const hidden = process.argv.includes('--cache');
  createWindow(hidden);
  createTray();
  discordApply();
  setupUpdater();
});

app.on('window-all-closed', () => { sim.stop(); discordStop(); app.quit(); });

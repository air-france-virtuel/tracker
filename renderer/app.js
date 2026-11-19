'use strict';
/* global afv */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PHASES = ['Boarding', 'Roulage', 'Décollage', 'Montée', 'Croisière', 'Descente', 'Approche', 'Atterrissage', 'Parking'];

const S = { store: null, plan: null, flight: null, phase: null, simOk: false, muted: false, lastT: null, trail: [], stars: 0, tags: {} };

// ---------------- navigation ----------------
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.nav').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + name));
  if (name === 'vols') renderReports();
  if (name === 'carriere' || name === 'missions' || name === 'infos') refreshCareer();
  if (name === 'infos' && !S.metarAt) loadMetar();
}

// ---------------- voix et annonces ----------------
let curAudio = null;
function playFile(file) {
  return new Promise((resolve) => {
    const a = new Audio(afv.fileUrl(file));
    curAudio = a;
    a.volume = S.store ? S.store.settings.volume : 0.8;
    a.onended = resolve; a.onerror = resolve;
    a.play().catch(resolve);
  });
}
const queue = [];
let playing = false;
async function runQueue() {
  if (playing) return;
  playing = true;
  while (queue.length) {
    const item = queue.shift();
    if (item.kind === 'ann') {
      if (S.muted || !S.store.settings.announcements) continue;
      $('annNow').innerHTML = '<b>' + esc(item.title) + '</b><br>' + esc(item.text);
      const custom = S.store.sounds[item.key];
      if (custom && custom.file) await playFile(custom.file); // sans fichier : texte affiché, aucun son
      $('annNow').textContent = 'Dernière annonce : ' + item.title;
    }
  }
  playing = false;
}
function maxSays(text) {
  $('maxSay').textContent = text;
  maxSpeak(text);
}

// Voix de Max : l'audio est fabriqué sur le PC (hors ligne) puis joué ici.
const maxQueue = [];
let maxBusy = false;
let maxSrc = null;
let audioCtx = null;
S.maxMuted = false;
function maxSpeak(text, force) {
  if (!force && (S.maxMuted || !S.store || !S.store.settings.maxVoice || !S.voice || !S.voice.installed)) return Promise.resolve(false);
  maxQueue.push({ text, force });
  while (maxQueue.length > 2) maxQueue.shift(); // on garde les messages les plus récents
  return runMaxQueue();
}
async function runMaxQueue() {
  if (maxBusy) return true;
  maxBusy = true;
  try {
    while (maxQueue.length) {
      const it = maxQueue.shift();
      const r = await afv.voiceSpeak(it.text, it.force);
      if (!r || !r.samples || (!it.force && S.maxMuted)) continue;
      await playSamples(r);
    }
  } finally { maxBusy = false; }
  return true;
}
function playSamples(r) {
  return new Promise((resolve) => {
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const buf = audioCtx.createBuffer(1, r.samples.length, r.sampleRate);
      buf.copyToChannel(r.samples instanceof Float32Array ? r.samples : Float32Array.from(r.samples), 0);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = r.playbackRate || 1; // voix plus grave
      const gain = audioCtx.createGain();
      gain.gain.value = S.store ? (S.store.settings.maxVolume != null ? S.store.settings.maxVolume : 0.9) : 0.9;
      src.connect(gain).connect(audioCtx.destination);
      src.onended = () => { if (maxSrc === src) maxSrc = null; resolve(); };
      maxSrc = src;
      src.start();
    } catch (e) { resolve(); }
  });
}
function maxStop() { maxQueue.length = 0; if (maxSrc) { try { maxSrc.stop(); } catch (e) { /* déjà arrêté */ } maxSrc = null; } }

function destName() { return S.plan && S.plan.destination ? (S.plan.destination.name || S.plan.destination.icao) : '[destination]'; }
function ANNOUNCEMENTS() {
  const dest = destName();
  const fl = S.plan && S.plan.cruiseAlt ? Math.round(S.plan.cruiseAlt / 1000) * 1000 : 35000;
  return [
    { key: 'boarding_welcome', phase: 0, title: 'Bienvenue à bord', text: 'Mesdames et messieurs, bonjour et bienvenue à bord de ce vol Air France Virtuel à destination de ' + dest + '. Merci de ranger vos bagages et de prendre place.' },
    { key: 'boarding_safety', phase: 0, title: 'Consignes de sécurité', text: 'Nous allons vous présenter les consignes de sécurité. Merci de bien vouloir suivre la démonstration de l’équipage.' },
    { key: 'taxi_crew', phase: 1, title: 'Préparation au départ', text: 'Personnel navigant, préparation pour le départ. Mesdames et messieurs, veuillez attacher votre ceinture.' },
    { key: 'takeoff_crew', phase: 2, title: 'Décollage', text: 'Personnel navigant, à vos places pour le décollage.' },
    { key: 'cruise_seatbelt', phase: 4, title: 'Fin de la montée', text: 'Le signal lumineux vient de s’éteindre. Vous pouvez détacher votre ceinture, mais nous vous conseillons de la garder attachée lorsque vous êtes assis.' },
    { key: 'cruise_captain', phase: 4, title: 'Message du commandant', text: 'Ici votre commandant de bord. Nous volons à ' + fl.toLocaleString('fr-FR') + ' pieds. Le vol se déroule normalement. Bon voyage.' },
    { key: 'descent_start', phase: 5, title: 'Début de la descente', text: 'Mesdames et messieurs, nous avons commencé notre descente vers ' + dest + '. Merci de regagner votre siège et de relever votre tablette.' },
    { key: 'approach_crew', phase: 6, title: 'Atterrissage', text: 'Personnel navigant, à vos places pour l’atterrissage.' },
    { key: 'landing_welcome', phase: 7, title: 'Bienvenue à destination', text: 'Mesdames et messieurs, bienvenue à ' + dest + '. Merci de rester assis, ceinture attachée, jusqu’à l’arrêt complet de l’appareil.' },
    { key: 'parking_deplane', phase: 8, title: 'Débarquement', text: 'Nous sommes arrivés au parking. Merci d’avoir choisi Air France Virtuel. Nous vous souhaitons une excellente journée.' }
  ];
}
function playPhaseAnnouncements(phase) {
  ANNOUNCEMENTS().filter((a) => a.phase === phase).forEach((a) => queue.push({ kind: 'ann', ...a }));
  runQueue();
}

// ---------------- conseils de Max ----------------
function rwy(side) { return S.plan && S.plan[side] && S.plan[side].rwy ? 'piste ' + S.plan[side].rwy : 'la piste en service'; }
function windOf(metar) { const m = /\b(\d{3}|VRB)(\d{2,3})(G\d{2,3})?KT\b/.exec(metar || ''); return m ? (m[1] === 'VRB' ? 'vent variable ' : 'vent du ' + m[1] + '° ') + parseInt(m[2], 10) + ' kt' + (m[3] ? ', rafales ' + m[3].slice(1) + ' kt' : '') : ''; }
function adviceFor(p) {
  const pl = S.plan;
  const dep = pl ? pl.origin.icao : 'le départ';
  const arr = pl ? pl.destination.icao : 'l’arrivée';
  const fl = pl && pl.cruiseAlt ? 'FL' + Math.round(pl.cruiseAlt / 100) : 'ton niveau de croisière';
  const steps = pl && pl.steps && pl.steps.length ? ' Paliers prévus : ' + pl.steps.map((s) => 'FL' + Math.round(s.alt / 100) + ' à ' + s.ident).join(', ') + '.' : '';
  const wDep = pl ? windOf(pl.metarDep) : '';
  const wArr = pl ? windOf(pl.metarArr) : '';
  switch (p) {
    case 0: return 'Embarquement à ' + dep + '. Je lance les annonces. Départ prévu ' + rwy('origin') + (wDep ? ', ' + wDep : '') + '. Prépare ton FMS puis lâche le frein de parking quand tu es prêt.';
    case 1: return 'Roulage vers la ' + rwy('origin') + '. Reste sous 25 kt et vérifie volets et trim avant l’alignement.';
    case 2: return 'Décollage : poussée réglée, garde l’axe. Train rentré après la montée positive.';
    case 3: return 'Montée vers ' + fl + '. 250 kt maximum sous 10 000 ft.' + steps;
    case 4: return 'Croisière à ' + fl + '. Surveille le carburant et prépare l’arrivée à ' + arr + '.' + (pl && pl.tod ? ' Je te préviens 10 minutes avant le TOD.' : '');
    case 5: return 'Descente vers ' + arr + ', ' + rwy('destination') + (wArr ? ', ' + wArr : '') + '. Repasse le calage local à l’altitude de transition et 250 kt sous 10 000 ft.';
    case 6: return 'Approche : sors le train et les volets, sois stabilisé à 1 000 ft. Remets les gaz si ce n’est pas bon.';
    case 7: return 'Atterrissage. Dégage la piste puis roule doucement jusqu’au parking.';
    case 8: return 'Au parking. Frein de parking, moteurs coupés : ton rapport de vol est enregistré.';
    default: return 'Prêt quand tu l’es.';
  }
}
function addAlert(title, text, kind) {
  const d = document.createElement('div');
  d.className = 'alert' + (kind ? ' ' + kind : '');
  d.innerHTML = '<b>' + esc(title) + '</b>' + esc(text);
  $('alerts').prepend(d);
  while ($('alerts').children.length > 4) $('alerts').lastChild.remove();
}

// ---------------- affichage du vol ----------------
function renderPhases(p) {
  $('phases').innerHTML = PHASES.map((n, i) => '<div class="ph ' + (p == null ? '' : (i < p ? 'done' : (i === p ? 'cur' : ''))) + '"><i></i>' + n + '</div>').join('');
}
function fmt(n, d = 0) { return n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d }); }
function renderTelem(t) {
  if (!t) return;
  const alt = t.alt >= 18000 ? 'FL' + Math.round(t.alt / 100) : fmt(t.alt) + ' ft';
  const items = [
    ['Altitude', alt], ['Vitesse indiquée', fmt(t.ias) + ' kt'], ['Vitesse sol', fmt(t.gs) + ' kt'],
    ['Taux vertical', (t.vs > 0 ? '+' : '') + fmt(t.vs) + ' ft/min'], ['Cap', fmt(t.hdg) + '°'], ['Carburant', fmt(t.fuelKg / 1000, 1) + ' t']
  ];
  $('telem').innerHTML = items.map(([k, v]) => '<div class="tl"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
}
function renderMap(t) {
  const pl = S.plan;
  const svg = $('map');
  if (!pl) { svg.innerHTML = '<text x="300" y="150" text-anchor="middle" fill="#5B667D" font-size="14">Carte disponible avec un plan SimBrief</text>'; return; }
  const pts = (pl.route_points && pl.route_points.length ? pl.route_points : [pl.origin, pl.destination]).map((p) => ({ lat: p.lat, lon: p.lon }));
  const all = pts.concat(S.trail);
  let minLat = Math.min(...all.map((p) => p.lat)), maxLat = Math.max(...all.map((p) => p.lat));
  let minLon = Math.min(...all.map((p) => p.lon)), maxLon = Math.max(...all.map((p) => p.lon));
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = Math.max(0.5, (maxLon - minLon) * k), h = Math.max(0.5, maxLat - minLat);
  const sc = Math.min(540 / w, 240 / h);
  const ox = 300 - ((minLon + maxLon) / 2) * k * sc, oy = 150 + ((minLat + maxLat) / 2) * sc;
  const X = (p) => (p.lon * k * sc + ox).toFixed(1), Y = (p) => (oy - p.lat * sc).toFixed(1);
  const line = (arr) => arr.map((p, i) => (i ? 'L' : 'M') + X(p) + ' ' + Y(p)).join(' ');
  let h2 = '<path d="' + line(pts) + '" fill="none" stroke="#9AA6BF" stroke-width="2" stroke-dasharray="6 6"/>';
  if (S.trail.length > 1) h2 += '<path d="' + line(S.trail) + '" fill="none" stroke="#0A1E4A" stroke-width="3"/>';
  h2 += '<circle cx="' + X(pl.origin) + '" cy="' + Y(pl.origin) + '" r="6" fill="#fff" stroke="#0A1E4A" stroke-width="3"/>';
  h2 += '<circle cx="' + X(pl.destination) + '" cy="' + Y(pl.destination) + '" r="6" fill="#fff" stroke="#0A1E4A" stroke-width="3"/>';
  h2 += '<text x="' + X(pl.origin) + '" y="' + (Y(pl.origin) - 12) + '" text-anchor="middle" font-size="13" font-weight="700" fill="#0A1E4A">' + esc(pl.origin.icao) + '</text>';
  h2 += '<text x="' + X(pl.destination) + '" y="' + (+Y(pl.destination) + 22) + '" text-anchor="middle" font-size="13" font-weight="700" fill="#0A1E4A">' + esc(pl.destination.icao) + '</text>';
  if (pl.tod) h2 += '<circle cx="' + X(pl.tod) + '" cy="' + Y(pl.tod) + '" r="4" fill="#E0A800"/><text x="' + X(pl.tod) + '" y="' + (Y(pl.tod) - 8) + '" text-anchor="middle" font-size="11" fill="#7A5B00">TOD</text>';
  if (t) h2 += '<g transform="translate(' + X(t) + ' ' + Y(t) + ') rotate(' + ((t.hdg || 0) - 90).toFixed(0) + ')"><path d="M12 0 L-8 -8 L-4 0 L-8 8 Z" fill="#C8102E"/></g>';
  svg.innerHTML = h2;
  $('mapFrom').textContent = pl.origin.icao + (pl.origin.rwy ? ' · piste ' + pl.origin.rwy : '');
  $('mapTo').textContent = pl.destination.icao + (pl.destination.rwy ? ' · piste ' + pl.destination.rwy : '');
}
function renderTod(tod, phase) {
  const el = $('todText');
  if (!S.plan || !S.plan.tod) { el.textContent = 'Charge un plan SimBrief pour que Max calcule le TOD.'; return; }
  if (phase != null && phase >= 5) { el.textContent = 'TOD passé : descente en cours.'; return; }
  if (!tod) { el.textContent = 'Le calcul commence après le décollage.'; return; }
  el.textContent = 'TOD dans ' + fmt(tod.distNm) + ' NM' + (tod.minutes != null ? ' (environ ' + fmt(tod.minutes) + ' min)' : '') + '.';
}

// ---------------- préparation ----------------
function renderPlan() {
  const p = S.plan;
  const box = $('planBox');
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  const steps = p.steps && p.steps.length ? p.steps.map((s) => 'FL' + Math.round(s.alt / 100) + ' à ' + esc(s.ident)).join(', ') : 'aucun';
  box.innerHTML =
    '<div><div class="k">Vol</div><b>' + esc(p.callsign || '—') + '</b></div>' +
    '<div><div class="k">Appareil (SimBrief)</div><b>' + esc(p.aircraft || '—') + '</b></div>' +
    '<div><div class="k">Départ</div><b>' + esc(p.origin.icao) + '</b> · piste ' + esc(p.origin.rwy || '—') + '</div>' +
    '<div><div class="k">Arrivée</div><b>' + esc(p.destination.icao) + '</b> · piste ' + esc(p.destination.rwy || '—') + '</div>' +
    '<div><div class="k">Croisière</div><b>FL' + Math.round((p.cruiseAlt || 0) / 100) + '</b></div>' +
    '<div><div class="k">Paliers de montée</div>' + steps + '</div>' +
    (p.metarDep ? '<div class="full"><div class="k">Météo départ</div><div class="metar">' + esc(p.metarDep) + '</div></div>' : '') +
    (p.metarArr ? '<div class="full"><div class="k">Météo arrivée</div><div class="metar">' + esc(p.metarArr) + '</div></div>' : '') +
    (p.demo ? '<div class="full muted small">Plan de démonstration.</div>' : '');
}
function renderAircraftSelect() {
  const sel = $('selAircraft');
  const now = Date.now();
  const fleet = S.store.fleet;
  const opts = ['<option value="">Aucun (pas de suivi au hangar)</option>'];
  fleet.forEach((a) => {
    const busy = a.repairUntil && a.repairUntil > now;
    opts.push('<option value="' + esc(a.reg) + '"' + (busy ? ' disabled' : '') + '>' + esc(a.reg) + ' · ' + esc(a.type) + (busy ? ' (au hangar)' : '') + '</option>');
  });
  sel.innerHTML = opts.join('');
  $('fleetHint').textContent = fleet.length ? '' : 'Ta flotte est vide : ajoute tes avions dans « Hangar & flotte ».';
}

$('btnSimbrief').addEventListener('click', async () => {
  $('sbMsg').textContent = 'Chargement…';
  try {
    S.plan = await afv.loadSimbrief();
    $('sbMsg').textContent = 'Plan chargé.';
    renderPlan();
    renderMissionHint();
  } catch (e) {
    $('sbMsg').textContent = (e.message || String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});

async function startFlight(mode) {
  if (mode === 'sim' && !S.simOk) { $('startMsg').textContent = 'Lance d’abord Microsoft Flight Simulator.'; return; }
  if (mode === 'demo') S.plan = await afv.demoPlan();
  const aircraft = $('selAircraft').value;
  const missionId = mode === 'demo' ? null : ($('selMission').value || null);
  await afv.startFlight({ mode, plan: S.plan, aircraft, demoHard: $('demoHard').checked, speed: 20, missionId });
  S.flight = { mode, aircraft };
  S.phase = 0; S.trail = []; queue.length = 0;
  $('alerts').innerHTML = '';
  $('prep').hidden = true; $('live').hidden = false; $('btnStop').hidden = false;
  const curM = missionId && S.career ? S.career.missions.find((m) => m.id === missionId) : null;
  $('flightSub').textContent = (curM ? 'Mission : ' + curM.title + ' · ' : '') + (S.plan ? (S.plan.callsign || '') + ' · ' + S.plan.origin.icao + ' → ' + S.plan.destination.icao : 'Vol sans plan SimBrief') + (aircraft ? ' · ' + aircraft : '') + (mode === 'demo' ? ' · démonstration' : '');
  renderPhases(0); renderMap(null); renderTod(null, 0);
  afv.voicePreload();
  renderMaxVoiceHint();
  $('maxPhase').textContent = 'Phase : Boarding';
  maxSays(adviceFor(0));
  playPhaseAnnouncements(0);
}
$('btnStart').addEventListener('click', () => startFlight('sim'));
$('btnDemo').addEventListener('click', () => startFlight('demo'));
$('btnStop').addEventListener('click', async () => {
  await afv.stopFlight();
  if (curAudio) curAudio.pause();
  maxStop();
  queue.length = 0;
  S.flight = null; S.phase = null;
  $('prep').hidden = false; $('live').hidden = true; $('btnStop').hidden = true;
  $('flightSub').textContent = 'Prépare ton vol pour commencer';
  renderPlan(); renderAircraftSelect();
});
$('btnMute').addEventListener('click', () => {
  S.muted = !S.muted;
  if (S.muted && curAudio) curAudio.pause();
  $('btnMute').textContent = S.muted ? 'Remettre les annonces' : 'Couper les annonces';
  $('btnMute').setAttribute('aria-pressed', String(S.muted));
});
$('btnMaxMute').addEventListener('click', () => {
  S.maxMuted = !S.maxMuted;
  if (S.maxMuted) maxStop();
  $('btnMaxMute').textContent = S.maxMuted ? 'Rendre la voix à Max' : 'Couper Max';
  $('btnMaxMute').setAttribute('aria-pressed', String(S.maxMuted));
});
function renderMaxVoiceHint() {
  const s = S.store ? S.store.settings : {};
  const show = !!s.maxVoice && !(S.voice && S.voice.installed);
  $('maxVoiceHint').hidden = !show;
  $('btnMaxMute').hidden = !s.maxVoice || !(S.voice && S.voice.installed);
}

// ---------------- événements du tracker ----------------
afv.on('sim:status', (s) => setSim(s.connected, s.simulator));
function setSim(ok, name) {
  S.simOk = ok;
  $('simState').classList.toggle('ok', ok);
  $('simText').textContent = ok ? 'Simulateur connecté' + (name ? ' (' + name + ')' : '') : 'Simulateur non connecté';
}
afv.on('flight:tick', (d) => {
  if (!S.flight || !d.t) return;
  const t = d.t;
  S.lastT = t;
  const lastTr = S.trail[S.trail.length - 1];
  if (!lastTr || Math.abs(lastTr.lat - t.lat) + Math.abs(lastTr.lon - t.lon) > 0.02) S.trail.push({ lat: t.lat, lon: t.lon });
  renderTelem(t);
  renderMap(t);
  renderTod(d.tod, d.phase);
  if (S.plan) $('mapDist').textContent = '';
});
afv.on('flight:event', (e) => {
  if (!S.flight) return;
  if (e.type === 'phase') {
    S.phase = e.phase;
    renderPhases(e.phase);
    $('maxPhase').textContent = 'Phase : ' + e.name;
    maxSays(adviceFor(e.phase));
    if (e.phase === 7) setTimeout(() => playPhaseAnnouncements(7), 12000); else playPhaseAnnouncements(e.phase);
  } else if (e.type === 'warning') {
    addAlert('Max', e.text);
    maxSays(e.text);
  } else if (e.type === 'tod10') {
    const txt = 'TOD dans environ ' + fmt(e.minutes) + ' minutes. Prépare le briefing d’arrivée, la météo et la ' + rwy('destination') + '.';
    addAlert('TOD dans 10 minutes', txt);
    maxSays(txt);
  } else if (e.type === 'todNow') {
    const txt = 'TOD atteint : commence la descente maintenant.';
    addAlert('TOD atteint', txt, 'red');
    maxSays(txt);
  } else if (e.type === 'step') {
    const txt = 'Palier de montée : monte au FL' + Math.round(e.alt / 100) + ' à ' + e.ident + ', comme prévu sur SimBrief.';
    addAlert('Palier SimBrief', txt);
    maxSays(txt);
  } else if (e.type === 'landing') {
    const lvl = e.level === 'normal' ? '' : (e.level === 'dur' ? 'red' : 'red');
    const txt = e.level === 'normal' ? 'Bel atterrissage : ' + e.rate + ' ft/min.' : 'Atterrissage dur : ' + e.rate + ' ft/min.';
    addAlert('Atterrissage', txt, lvl || 'ok');
    maxSays(txt);
  } else if (e.type === 'hangar') {
    addAlert('Hangar', e.reg + ' part en maintenance pour ' + e.days + ' jours.', 'red');
  }
});
afv.on('flight:report', (r) => {
  showReport(r);
  if (r.mission) maxSays(r.mission.validated ? 'Bravo commandant ! Mission validée, ' + r.mission.points + ' points de plus pour ta carrière.' : 'Mission non validée cette fois. ' + (r.mission.reason || ''));
});
afv.on('fleet:changed', (f) => { S.store.fleet = f; renderFleet(); renderAircraftSelect(); });

function showReport(r) {
  const h = (m) => (m == null ? '—' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'));
  $('reportBody').innerHTML = '<div class="muted">' + esc(r.callsign || '') + ' ' + esc(r.from) + ' → ' + esc(r.to) + (r.aircraft ? ' · ' + esc(r.aircraft) : '') + '</div><div class="rep">' +
    [['Temps bloc', h(r.blockMinutes)], ['Temps de vol', h(r.flightMinutes)], ['Distance', fmt(r.distanceNm) + ' NM'], ['Carburant utilisé', r.fuelUsedKg == null ? '—' : fmt(r.fuelUsedKg) + ' kg'], ['Atterrissage', r.landingRate == null ? '—' : r.landingRate + ' ft/min'], ['Altitude max', 'FL' + Math.round(r.maxAlt / 100)]]
      .map(([k, v]) => '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('') + '</div>' + missionResult(r.mission) + '<p class="muted small">Rapport enregistré dans « Mes vols ».</p>';
  $('reportModal').hidden = false;
}
$('btnCloseReport').addEventListener('click', () => { $('reportModal').hidden = true; });
$('btnReportFb').addEventListener('click', () => { $('reportModal').hidden = true; showTab('avis'); });

// ---------------- hangar ----------------
function renderFleet() {
  const now = Date.now();
  const f = S.store.fleet;
  const busy = f.filter((a) => a.repairUntil && a.repairUntil > now).length;
  $('fleetCount').textContent = f.length ? (f.length - busy) + ' disponibles sur ' + f.length + ' appareils' : 'Aucun appareil pour le moment';
  $('r1').textContent = S.store.settings.hard1; $('r2').textContent = S.store.settings.hard2;
  if (!f.length) { $('fleet').innerHTML = '<div class="empty">Ta flotte est vide. Ajoute les avions que tu veux utiliser : ce sera ta flotte limitée.</div>'; return; }
  $('fleet').innerHTML = f.map((a, i) => {
    const m = a.repairUntil && a.repairUntil > now;
    const days = m ? Math.ceil((a.repairUntil - now) / 86400000) : 0;
    const health = a.health || 100;
    return '<div class="plane"><div class="row between"><span class="reg">' + esc(a.reg) + '</span><span class="badge' + (m ? ' red' : '') + '">' + (m ? 'Au hangar' : 'Disponible') + '</span></div>' +
      '<div>' + esc(a.type) + '</div><div class="bar"><i style="width:' + health + '%"></i></div>' +
      '<div class="muted small">' + (m ? esc(a.reason || 'Réparation') + ' · retour dans ' + days + ' jour' + (days > 1 ? 's' : '') : 'État ' + health + ' %') + '</div>' +
      '<div class="row">' + (m ? '<button class="btn small ghost" data-repair="' + i + '">Terminer la réparation</button>' : '') + '<button class="btn small ghost" data-del="' + i + '">Retirer</button></div></div>';
  }).join('');
}
$('fleet').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const f = S.store.fleet.slice();
  if (b.dataset.del != null) f.splice(+b.dataset.del, 1);
  if (b.dataset.repair != null) Object.assign(f[+b.dataset.repair], { repairUntil: null, reason: '', health: 100 });
  S.store.fleet = await afv.setFleet(f);
  renderFleet(); renderAircraftSelect();
});
$('btnAddPlane').addEventListener('click', async () => {
  const reg = $('newReg').value.trim().toUpperCase();
  if (!reg) { $('addMsg').textContent = 'Indique une immatriculation.'; return; }
  if (S.store.fleet.some((a) => a.reg === reg)) { $('addMsg').textContent = 'Cet avion est déjà dans la flotte.'; return; }
  S.store.fleet = await afv.setFleet(S.store.fleet.concat([{ reg, type: $('newType').value, health: 100, repairUntil: null }]));
  $('newReg').value = ''; $('addMsg').textContent = reg + ' ajouté.';
  renderFleet(); renderAircraftSelect();
});

// ---------------- mes vols ----------------
async function renderReports() {
  const list = await afv.listReports();
  if (!list.length) { $('reports').innerHTML = '<div class="empty">Aucun vol enregistré pour l’instant.</div>'; return; }
  $('reports').innerHTML = '<table><thead><tr><th>Date</th><th>Vol</th><th>Trajet</th><th>Appareil</th><th>Temps de vol</th><th>Atterrissage</th><th>Mission</th></tr></thead><tbody>' +
    list.map((r) => '<tr><td>' + esc(new Date(r.date).toLocaleString('fr-FR')) + (r.mode === 'demo' ? ' (démo)' : '') + '</td><td>' + esc(r.callsign) + '</td><td>' + esc(r.from) + ' → ' + esc(r.to) + '</td><td>' + esc(r.aircraft) + '</td><td>' + (r.flightMinutes == null ? '—' : Math.floor(r.flightMinutes / 60) + ' h ' + String(r.flightMinutes % 60).padStart(2, '0')) + '</td><td>' + (r.landingRate == null ? '—' : r.landingRate + ' ft/min') + '</td><td>' + (r.mission ? (r.mission.validated ? '✓ +' + r.mission.points + ' pts' : 'Non validée') : '—') + '</td></tr>').join('') + '</tbody></table>';
}
$('btnOpenReports').addEventListener('click', () => afv.openFolder('rapports'));

// ---------------- sons ----------------
function renderSounds() {
  const list = ANNOUNCEMENTS();
  $('sounds').innerHTML = list.map((a) => {
    const c = S.store.sounds[a.key];
    return '<div class="snd"><div class="t"><b>' + PHASES[a.phase] + ' · ' + esc(a.title) + '</b><div class="muted small">' + (c ? 'Ton fichier : ' + esc(c.name) : 'Aucun son : le texte s\u2019affiche dans le tracker. « ' + esc(a.text) + ' »') + '</div></div>' +
      (c ? '<button class="btn small ghost" data-play="' + a.key + '">Écouter</button>' : '') +
      '<button class="btn small red" data-pick="' + a.key + '">' + (c ? 'Remplacer' : 'Importer un fichier') + '</button>' +
      (c ? '<button class="btn small ghost" data-reset="' + a.key + '">Retirer le son</button>' : '') + '</div>';
  }).join('') + '<p class="muted small">Formats acceptés : MP3, WAV ou OGG, 10 Mo maximum. Utilise tes propres enregistrements.</p>';
}
$('sounds').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.pick) { const s = await afv.pickSound(b.dataset.pick); if (s) S.store.sounds = s; }
    if (b.dataset.reset) S.store.sounds = await afv.resetSound(b.dataset.reset);
    if (b.dataset.play) {
      const a = ANNOUNCEMENTS().find((x) => x.key === b.dataset.play);
      const c = S.store.sounds[a.key];
      if (curAudio) curAudio.pause();
      if (c) playFile(c.file);
    }
  } catch (e) { alertBox(e); }
  renderSounds();
  renderAnnHint();
});
function alertBox(e) { console.error(e); }

// ---------------- avis ----------------
const TAGS = ['Annonces sonores', 'Conseils de Max', 'Carte du vol', 'Alerte TOD', 'Détection des phases', 'Hangar et flotte', 'Rapport de vol', 'Autre'];
function renderFb() {
  $('stars').innerHTML = [1, 2, 3, 4, 5].map((n) => '<button class="star' + (n <= S.stars ? ' on' : '') + '" data-star="' + n + '" aria-label="' + n + ' sur 5">★</button>').join('');
  $('tags').innerHTML = TAGS.map((t) => '<button class="tag' + (S.tags[t] ? ' on' : '') + '" data-tag="' + esc(t) + '" aria-pressed="' + !!S.tags[t] + '">' + esc(t) + '</button>').join('');
  const fb = S.store.feedback || [];
  $('fbList').innerHTML = fb.length ? fb.map((f) => '<div class="card" style="margin-bottom:8px"><b>' + '★'.repeat(f.stars || 0) + '</b> <span class="muted small">' + esc(new Date(f.date).toLocaleString('fr-FR')) + ' · v' + esc(f.version) + '</span><div class="muted small">' + esc((f.tags || []).join(', ')) + '</div><div>' + esc(f.text) + '</div></div>').join('') : '<div class="muted">Aucun avis pour l’instant.</div>';
}
$('stars').addEventListener('click', (e) => { const b = e.target.closest('[data-star]'); if (b) { S.stars = +b.dataset.star; renderFb(); } });
$('tags').addEventListener('click', (e) => { const b = e.target.closest('[data-tag]'); if (b) { S.tags[b.dataset.tag] = !S.tags[b.dataset.tag]; renderFb(); } });
function fbText() {
  const tags = Object.keys(S.tags).filter((k) => S.tags[k]);
  return 'Avis bêta tracker Air France Virtuel v' + $('ver').textContent + '\nNote : ' + S.stars + '/5\nPoints à améliorer : ' + (tags.join(', ') || '—') + '\n' + $('fbText').value.trim();
}
$('btnSendFb').addEventListener('click', async () => {
  if (!S.stars && !$('fbText').value.trim()) { $('fbMsg').textContent = 'Mets au moins une note ou un commentaire.'; return; }
  S.store.feedback = await afv.saveFeedback({ stars: S.stars, tags: Object.keys(S.tags).filter((k) => S.tags[k]), text: $('fbText').value.trim() });
  S.stars = 0; S.tags = {}; $('fbText').value = '';
  $('fbMsg').textContent = 'Merci ! Ton avis est enregistré.';
  renderFb();
});
$('btnCopyFb').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(fbText()); $('fbMsg').textContent = 'Copié : colle-le sur le Discord de la compagnie.'; } catch (e) { $('fbMsg').textContent = 'Copie impossible.'; }
});

// ---------------- réglages ----------------
function renderSettings() {
  const s = S.store.settings;
  $('sPilot').value = s.pilot; $('sSimbrief').value = s.simbrief; $('sAnn').checked = s.announcements;
  $('sVol').value = s.volume; $('sHard1').value = s.hard1; $('sHard2').value = s.hard2;
  $('sMaxVoice').checked = s.maxVoice !== false; $('sMaxVol').value = s.maxVolume != null ? s.maxVolume : 0.9;
}

// ---------------- voix de Max (réglages) ----------------
function renderVoice() {
  const v = S.voice || {};
  let h;
  if (v.downloading) h = '<p class="muted">Installation de la voix… ' + (v.percent || 0) + ' %</p><div class="progress"><i style="width:' + (v.percent || 0) + '%"></i></div>';
  else if (v.installed) h = '<p class="muted"><b style="color:#1B5E32">Voix installée.</b> Max parle à chaque phase et pour ses alertes, sans connexion internet.</p>' +
    '<div class="row wrap"><button class="btn ghost" id="btnVoiceTest">Écouter Max</button><button class="btn ghost" id="btnVoiceRemove">Supprimer la voix</button></div>';
  else h = '<p class="muted">Pour que Max parle, installe sa voix une seule fois (' + (v.sizeMb || 326) + ' Mo à télécharger). Elle fonctionne ensuite sans internet.</p>' +
    (v.error ? '<p class="muted" style="color:#8A1026">' + esc(v.error) + '</p>' : '') +
    '<button class="btn red" id="btnVoiceDl">Installer la voix de Max</button>';
  $('voiceCard').innerHTML = h;
  const dl = $('btnVoiceDl'); if (dl) dl.addEventListener('click', () => { afv.voiceDownload(); S.voice = Object.assign({}, v, { downloading: true, percent: 0, error: '' }); renderVoice(); });
  const rm = $('btnVoiceRemove'); if (rm) rm.addEventListener('click', async () => { maxStop(); S.voice = await afv.voiceRemove(); renderVoice(); renderMaxVoiceHint(); });
  const ts = $('btnVoiceTest'); if (ts) ts.addEventListener('click', async () => {
    ts.disabled = true; ts.textContent = 'Max prépare sa phrase…';
    await maxSpeak('Salut commandant ! C’est Max, ton copilote. Je te préviendrai pour le TOD, les paliers et l’approche. Bon vol !', true);
    ts.disabled = false; ts.textContent = 'Écouter Max';
  });
}
afv.on('voice:status', (v) => { S.voice = v; renderVoice(); renderMaxVoiceHint(); });
$('btnSaveSettings').addEventListener('click', async () => {
  const h1 = Math.max(200, +$('sHard1').value || 600);
  const h2 = Math.max(h1 + 50, +$('sHard2').value || 900);
  S.store.settings = await afv.setSettings({ pilot: $('sPilot').value.trim(), simbrief: $('sSimbrief').value.trim(), announcements: $('sAnn').checked, volume: +$('sVol').value, hard1: h1, hard2: h2, maxVoice: $('sMaxVoice').checked, maxVolume: +$('sMaxVol').value });
  $('setMsg').textContent = 'Réglages enregistrés.';
  if (!S.store.settings.maxVoice) maxStop();
  renderSettings(); renderFleet(); renderMaxVoiceHint();
});
$('btnOpenData').addEventListener('click', () => afv.openFolder('donnees'));

// ---------------- mises à jour ----------------
let UPD = { state: 'idle' };
function changeList(v) {
  const li = (cls, lbl, arr) => (arr || []).map((x) => '<li><span class="tagc ' + cls + '">' + lbl + '</span>' + esc(x) + '</li>').join('');
  return '<ul>' + li('add', 'Ajouté', v.added) + li('rem', 'Retiré', v.removed) + li('fix', 'Corrigé', v.fixed) + '</ul>';
}
function stripHtml(h) { const d = document.createElement('div'); d.innerHTML = String(h || '').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li>/gi, '• '); return d.textContent.replace(/\n{3,}/g, '\n\n').trim(); }
function renderUpdate() {
  const u = UPD;
  const cur = $('ver').textContent;
  let h = '<div class="row between"><div><div class="muted small">Version installée</div><b style="font-size:18px;color:#0A1E4A">' + esc(cur) + '</b></div>';
  const st = {
    dev: 'Mode développement : les mises à jour sont désactivées.',
    idle: 'En attente de la première vérification…',
    checking: 'Recherche d\u2019une mise à jour…',
    uptodate: 'Tu as la dernière version.',
    downloading: 'Téléchargement de la version ' + esc(u.version) + '… ' + (u.percent || 0) + ' %',
    ready: 'La version ' + esc(u.version) + ' est prête. Elle s\u2019installera au prochain redémarrage du tracker.',
    error: 'Vérification impossible pour le moment. Réessaie plus tard.'
  }[u.state] || '';
  h += '<div style="text-align:right">' + (u.state === 'ready' ? '<button class="btn red" id="btnInstallNow">Redémarrer et installer</button>' : '') + '</div></div>';
  h += '<p class="muted">' + st + '</p>';
  if (u.state === 'error' && u.error) h += '<p class="muted small">Détail : ' + esc(u.error) + '</p>';
  if (u.state === 'downloading') h += '<div class="progress"><i style="width:' + (u.percent || 0) + '%"></i></div>';
  if ((u.state === 'ready' || u.state === 'downloading') && u.notes) h += '<div class="muted small">Ce qui change dans la version ' + esc(u.version) + ' :</div><div class="notes">' + esc(stripHtml(u.notes)) + '</div>';
  $('updCard').innerHTML = h;
  const b = $('btnInstallNow'); if (b) b.addEventListener('click', () => afv.installUpdate());
  $('updDot').hidden = u.state !== 'ready';
  $('updBanner').hidden = u.state !== 'ready';
  $('updBannerText').textContent = 'La version ' + (u.version || '') + ' du tracker est prête.' + (S.flight ? ' Installe-la après ton vol.' : '');
}
afv.on('update:status', (u) => { UPD = u; renderUpdate(); updPopup(); });

// Pop-up dès qu'une nouvelle version est trouvée (une fois par version).
S.updSeen = {};
function updPopup() {
  const u = UPD;
  if (!u || !u.version || (u.state !== 'downloading' && u.state !== 'ready')) return;
  const key = u.version + ':' + u.state; // réapparaît quand le téléchargement est terminé
  if (!S.updSeen[key]) { S.updSeen[key] = true; $('updModal').hidden = false; }
  if ($('updModal').hidden) return;
  $('updModalTitle').textContent = 'La version ' + u.version + ' est disponible !';
  let h = u.state === 'ready'
    ? '<p class="muted">Elle est téléchargée et prête à être installée' + (S.flight ? '. Tu es en vol : installe-la après ton atterrissage, ou elle s’installera quand tu fermeras le tracker.' : '. Clique sur « Redémarrer et installer » : le tracker redémarre tout seul en quelques secondes.') + '</p>'
    : '<p class="muted">Téléchargement en cours… ' + (u.percent || 0) + ' %</p><div class="progress"><i style="width:' + (u.percent || 0) + '%"></i></div>';
  if (u.notes) h += '<div class="muted small" style="margin-top:10px">Ce qui change :</div><div class="notes">' + esc(stripHtml(u.notes)) + '</div>';
  $('updModalBody').innerHTML = h;
  $('btnUpdModalInstall').hidden = u.state !== 'ready' || !!S.flight;
  $('btnUpdModalLater').textContent = S.flight ? 'Après mon vol' : 'Plus tard';
}
$('btnUpdModalLater').addEventListener('click', () => { $('updModal').hidden = true; });
$('btnUpdModalInstall').addEventListener('click', () => afv.installUpdate());
$('btnCheckUpd').addEventListener('click', async () => { UPD = await afv.checkUpdate(); renderUpdate(); });
$('btnBannerInstall').addEventListener('click', () => {
  if (S.flight && !confirmInstall()) return;
  afv.installUpdate();
});
function confirmInstall() { return window.confirm('Un vol est en cours. Installer maintenant arrête le suivi. Continuer ?'); }
async function renderChangelog() {
  const cl = await afv.getChangelog();
  $('changelog').innerHTML = cl.map((v) => '<div class="chg"><h4>Version ' + esc(v.version) + ' <span class="muted small">· ' + esc(new Date(v.date).toLocaleDateString('fr-FR')) + '</span></h4>' + changeList(v) + '</div>').join('');
  return cl;
}
$('btnNewsOk').addEventListener('click', () => { $('newsModal').hidden = true; afv.changelogSeen(); });

document.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b) showTab(b.dataset.goto); });
function renderAnnHint() { $('annHint').hidden = Object.keys((S.store && S.store.sounds) || {}).length > 0; }

// ---------------- démarrage ----------------
(async function init() {
  const d = await afv.init();
  S.store = d.store;
  $('ver').textContent = d.version;
  setSim(d.sim.connected);
  renderAircraftSelect(); renderFleet(); renderSounds(); renderFb(); renderSettings(); renderPhases(null); renderAnnHint();
  S.voice = await afv.voiceStatus(); renderVoice(); renderMaxVoiceHint();
  S.infos = await afv.getInfos(); await refreshCareer(); loadMetar();
  UPD = await afv.getUpdate(); renderUpdate(); updPopup();
  const cl = await renderChangelog();
  const now = cl.find((v) => v.version === d.version);
  if (d.showNews && now) {
    $('newsTitle').textContent = 'Nouveautés de la version ' + d.version;
    $('newsBody').innerHTML = changeList(now);
    $('newsModal').hidden = false;
  } else if (d.firstRun) afv.changelogSeen();
})();

// ---------------- carrière, missions et infos du jour ----------------
const fmtH = (h) => fmt(h) + ' h';
async function refreshCareer(c) {
  S.career = c || await afv.getCareer();
  renderCareer(); renderMissions(); renderMissionSelect(); renderInfos();
}
afv.on('career:changed', (c) => refreshCareer(c));
afv.on('infos:changed', (i) => { S.infos = i; renderInfos(); });

function missionResult(m) {
  if (!m) return '';
  return '<div class="mres' + (m.validated ? '' : ' ko') + '"><b>' + (m.validated ? 'Mission validée : +' + m.points + ' points' : 'Mission non validée') + '</b><br>' + esc(m.title) + (m.reason ? '<br>' + esc(m.reason) : '') + '</div>';
}

function renderCareer() {
  const c = S.career; if (!c) return;
  $('carSub').textContent = (S.store.settings.pilot || 'Pilote') + ' · ' + c.points + ' points';
  $('carGrade').textContent = c.gradeName;
  $('carNext').textContent = c.next ? 'Prochain grade : ' + c.next + (c.todo.length ? ' · il reste ' + c.todo.join(', ') : ' · conditions remplies') : 'Tu as atteint le plus haut grade de la compagnie.';
  const prevH = [0, 100, 250, 600, 1200][c.grade];
  $('carBar').style.width = c.next ? Math.max(2, Math.min(100, Math.round(((c.hours - prevH) / (c.nextHours - prevH)) * 100))) + '%' : '100%';
  $('carStats').innerHTML = [['Heures de vol', fmtH(c.hours)], ['Vols effectués', c.flights], ['Missions validées', c.training + c.regular], ['Atterrissage moyen', c.avgLanding == null ? '—' : c.avgLanding + ' ft/min']]
    .map(([k, v]) => '<div class="tl"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
  $('carLadder').innerHTML = c.grades.map((g, i) => '<li class="' + g.state + '"><span class="dotg">' + (g.state === 'done' ? '✓' : i + 1) + '</span><div><b>' + esc(g.name) + '</b>' + (g.state === 'current' ? ' · <span style="color:var(--red);font-weight:700">ton grade</span>' : '') +
    '<div class="muted small">' + esc(g.req) + '</div><div class="small">Débloque : ' + esc(g.unlock) + '</div></div></li>').join('');
  const acc = c.missions.filter((m) => m.accepted);
  $('carActive').innerHTML = acc.length ? acc.map((m) => '<div class="am"><div class="t">' + esc(m.title) + '</div><div class="muted small">' + esc(m.role) + ' · ' + esc(m.from) + ' → ' + esc(m.to) + ' · ' + esc(m.aircraft) +
    (m.repeat > 1 ? ' · ' + m.validated + '/' + m.repeat + ' vols validés' : '') + '</div></div>').join('') : '<p class="muted">Aucune mission acceptée. Choisis-en une dans « Missions & rôles ».</p>';
  const all = ['A220', 'A320', 'A350', 'B777'];
  $('carQuals').innerHTML = all.map((q) => '<span class="qual' + (c.quals.includes(q) ? '' : ' off') + '">' + q + (c.quals.includes(q) ? '' : ' (verrouillée)') + '</span>').join('');
}

S.misFilter = 'all';
function renderMissions() {
  const c = S.career; if (!c) return;
  $('misSub').textContent = 'Grade actuel : ' + c.gradeName;
  const byId = Object.fromEntries(c.missions.map((m) => [m.id, m]));
  $('misDaily').innerHTML = c.daily.length ? c.daily.map((id, i) => { const m = byId[id]; return '<button class="dm' + (i === 0 ? ' first' : '') + '" data-mis="' + id + '">' + (i === 0 ? '<span class="x2">Vol du jour · points ×2</span>' : '') +
    '<span class="r">' + esc(m.from) + ' → ' + esc(m.to) + '</span><span class="small">' + esc(m.title) + '</span><span class="muted small">' + esc(m.aircraft) + ' · ' + esc(m.duration) + ' · +' + m.reward * m.bonus + ' pts</span></button>'; }).join('')
    : '<p class="muted">Aucune mission disponible pour ton grade aujourd’hui.</p>';
  const filters = [['all', 'Toutes'], ['pass', 'Passagers'], ['cargo', 'Cargo'], ['charter', 'Charter / VIP'], ['human', 'Humanitaire'], ['form', 'Formation']];
  $('misFilters').innerHTML = filters.map(([k, l]) => '<button class="tag' + (S.misFilter === k ? ' on' : '') + '" data-filter="' + k + '" aria-pressed="' + (S.misFilter === k) + '">' + l + '</button>').join('');
  const shown = c.missions.filter((m) => S.misFilter === 'all' || m.cat === S.misFilter);
  if (!S.misSel || !byId[S.misSel]) S.misSel = (c.active || (shown[0] && shown[0].id));
  $('misList').innerHTML = shown.map((m) => '<button class="mi' + (m.id === S.misSel ? ' on' : '') + '" data-mis="' + m.id + '"><span class="r">' + esc(m.category) + ' · ' + esc(m.from) + ' → ' + esc(m.to) + '</span><span class="t">' + esc(m.title) + '</span>' +
    '<span class="muted small">' + esc(m.role) + ' · ' + esc(m.aircraft) + ' · ' + esc(m.duration) + '</span><span class="st' + (m.locked ? ' lock' : m.accepted ? ' run' : '') + '">' + esc(m.status) + '</span></button>').join('');
  const m = byId[S.misSel];
  if (!m) { $('misDetail').innerHTML = ''; return; }
  const btn = m.locked ? '<p class="muted"><b>Verrouillée :</b> ' + esc(m.locked) + '</p>'
    : m.accepted ? '<div class="row wrap"><button class="btn red" data-fly="' + m.id + '">Voler cette mission</button><button class="btn ghost" data-sb="' + m.id + '">Préparer dans SimBrief</button><button class="btn ghost" data-drop="' + m.id + '">Abandonner</button></div>'
      : '<div class="row wrap"><button class="btn red" data-accept="' + m.id + '">Accepter la mission</button><button class="btn ghost" data-sb="' + m.id + '">Préparer dans SimBrief</button></div>';
  $('misDetail').innerHTML = '<div class="muted small">' + esc(m.category) + (m.daily ? ' · mission du jour' : '') + '</div><h2>' + esc(m.from) + ' → ' + esc(m.to) + '</h2><div style="font-weight:600;margin-bottom:10px">' + esc(m.title) + '</div>' +
    '<div class="am"><div class="t">Rôle à tenir : ' + esc(m.role) + '</div><div class="muted">' + esc(m.roleDesc) + '</div></div>' +
    '<div class="kv"><div><div class="k">Appareil</div><div class="v">' + esc(m.aircraft) + '</div></div><div><div class="k">Durée estimée</div><div class="v">' + esc(m.duration) + '</div></div>' +
    '<div><div class="k">Grade minimum</div><div class="v">' + esc(m.gradeName) + '</div></div><div><div class="k">Récompense</div><div class="v">+' + m.reward * m.bonus + ' points' + (m.gives ? ' · qualif. ' + esc(m.gives) : '') + '</div></div></div>' +
    (m.repeat > 1 ? '<p class="muted">Progression : ' + m.validated + ' / ' + m.repeat + ' vols validés.</p>' : '') +
    '<p class="muted"><b>Briefing :</b> ' + esc(m.brief) + '</p>' +
    '<p class="muted small">Pour valider : charge le plan SimBrief ' + esc(m.from) + ' → ' + esc(m.to) + ' dans le tracker, choisis cette mission et vole jusqu’au parking sans atterrissage trop dur.</p>' + btn;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mis],[data-filter],[data-accept],[data-drop],[data-fly],[data-sb]');
  if (!b) return;
  if (b.dataset.filter) { S.misFilter = b.dataset.filter; renderMissions(); return; }
  if (b.dataset.mis) { S.misSel = b.dataset.mis; if (!$('tab-missions').classList.contains('on')) showTab('missions'); renderMissions(); return; }
  if (b.dataset.accept) { await refreshCareer(await afv.acceptMission(b.dataset.accept)); return; }
  if (b.dataset.drop) { await refreshCareer(await afv.dropMission(b.dataset.drop)); return; }
  if (b.dataset.sb) { const m = S.career.missions.find((x) => x.id === b.dataset.sb); if (m) window.open(m.simbrief); return; }
  if (b.dataset.fly) { await refreshCareer(await afv.setActiveMission(b.dataset.fly)); $('selMission').value = b.dataset.fly; renderMissionHint(); showTab('vol'); }
});

function renderMissionSelect() {
  const c = S.career; if (!c) return;
  const sel = $('selMission');
  const cur = sel.value || c.active || '';
  const acc = c.missions.filter((m) => m.accepted);
  sel.innerHTML = '<option value="">Vol libre (sans mission)</option>' + acc.map((m) => '<option value="' + m.id + '">' + esc(m.from + ' → ' + m.to + ' · ' + m.title) + '</option>').join('');
  sel.value = acc.some((m) => m.id === cur) ? cur : '';
  renderMissionHint();
}
function renderMissionHint() {
  const m = S.career && S.career.missions.find((x) => x.id === $('selMission').value);
  if (!m) { $('missionHint').textContent = S.career && S.career.missions.some((x) => x.accepted) ? '' : 'Accepte une mission dans « Missions & rôles » pour faire avancer ta carrière.'; return; }
  const ok = S.plan && S.plan.origin && S.plan.origin.icao === m.from && S.plan.destination.icao === m.to;
  $('missionHint').innerHTML = esc(m.role) + ' · ' + esc(m.aircraft) + ' · +' + m.reward * m.bonus + ' pts. ' +
    (ok ? '<b style="color:#1B5E32">Le plan SimBrief correspond à la mission.</b>' : 'Charge un plan SimBrief ' + esc(m.from) + ' → ' + esc(m.to) + ' pour que la mission soit validée. <button class="linkbtn" data-sb="' + m.id + '">Préparer dans SimBrief</button>');
}
$('selMission').addEventListener('change', () => { afv.setActiveMission($('selMission').value || null); renderMissionHint(); });

function renderInfos() {
  const i = (S.infos && S.infos.data) || {};
  const msg = i.message || {};
  $('infosDate').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('infoTitle').textContent = msg.title || 'Bienvenue';
  $('infoText').textContent = msg.text || '';
  $('infoAuthor').textContent = msg.author ? '— ' + msg.author : '';
  $('infoEvents').innerHTML = (i.events || []).map((e) => '<div class="ev"><b>' + esc(e.title) + '</b><div class="muted">' + esc(e.note) + '</div></div>').join('') || '<p class="muted">Aucun événement aujourd’hui.</p>';
  $('infoAlerts').innerHTML = (i.alerts || []).map((a) => '<div class="ev"><b>' + esc(a.kind) + '</b><div class="muted">' + esc(a.text) + '</div></div>').join('') || '<p class="muted">Aucune alerte.</p>';
  const c = S.career;
  const m = c && c.daily.length ? c.missions.find((x) => x.id === c.daily[0]) : null;
  $('dayFlight').innerHTML = m ? '<div class="muted small">Vol du jour proposé par Max</div><h2>' + esc(m.from) + ' → ' + esc(m.to) + '</h2><p class="muted">' + esc(m.title) + ' · ' + esc(m.aircraft) + ' · ' + esc(m.duration) + '</p>' +
    '<p><span class="x2">Points doublés aujourd’hui</span></p><button class="btn ghost" data-mis="' + m.id + '">Voir la mission</button>' : '<div class="muted small">Vol du jour</div><p class="muted">Aucune mission disponible pour ton grade.</p>';
}

async function loadMetar() {
  const c = S.career;
  const ids = ['LFPG', 'LFPO'];
  if (c) for (const id of c.daily.slice(0, 2)) { const m = c.missions.find((x) => x.id === id); if (m) ids.push(m.from, m.to); }
  $('metar').innerHTML = '<p class="muted">Chargement de la météo…</p>';
  const list = await afv.getMetar(ids);
  S.metarAt = Date.now();
  if (!list) { $('metar').innerHTML = '<p class="muted">Météo indisponible pour le moment (pas de connexion ?).</p>'; return; }
  const cat = { VFR: 'Conditions VFR', MVFR: 'VFR marginal', IFR: 'Conditions IFR', LIFR: 'IFR basses' };
  $('metar').innerHTML = list.map((w) => '<div class="wxi"><div class="row between"><span class="c">' + esc(w.icao) + '</span><span class="muted small">' + esc(cat[w.cat] || '') + '</span></div>' +
    '<div class="small">' + (w.wspd != null ? 'Vent ' + (w.wdir === 'VRB' ? 'variable' : esc(w.wdir) + '°') + ' · ' + esc(w.wspd) + ' kt' : '') + (w.temp != null ? ' · ' + esc(w.temp) + ' °C' : '') + '</div>' +
    '<div class="metar" style="margin-top:6px">' + esc(w.raw) + '</div></div>').join('') || '<p class="muted">Aucune observation reçue.</p>';
}
$('btnMetar').addEventListener('click', loadMetar);

// ---------------- vols réels (en cours) ----------------
S.real = { flights: [], sel: null, det: {} };
let realTimer = null;
async function loadReal(force) {
  $('realSub').textContent = 'Chargement des vols Air France en cours…';
  const r = await afv.realLive(force);
  S.real.flights = r.flights || [];
  S.real.at = r.at;
  const when = r.at ? new Date(r.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  $('realSub').textContent = r.error && !S.real.flights.length ? r.error
    : S.real.flights.length + ' vols Air France en l’air' + (when ? ' · mis à jour à ' + when : '') + (r.error ? ' · ' + r.error : '');
  const aps = [...new Set(S.real.flights.flatMap((f) => [f.from, f.to]).filter(Boolean))].sort();
  const cur = $('realAirport').value || 'all';
  $('realAirport').innerHTML = '<option value="all">Tous</option>' + aps.map((a) => '<option>' + esc(a) + '</option>').join('');
  $('realAirport').value = aps.includes(cur) ? cur : 'all';
  renderReal();
}
function realShown() {
  const ap = $('realAirport').value;
  const q = $('realSearch').value.trim().toUpperCase().replace(/\s+/g, '');
  return S.real.flights.filter((f) => (ap === 'all' || f.from === ap || f.to === ap) &&
    (!q || [f.callsign, f.number, f.from, f.to, f.fromName, f.toName, f.fromIata, f.toIata].some((x) => String(x || '').toUpperCase().replace(/\s+/g, '').includes(q))));
}
function renderReal() {
  const list = realShown();
  renderRealMap(list);
  $('realList').innerHTML = list.length ? list.slice(0, 200).map((f) => '<button class="rt' + (f.callsign === S.real.sel ? ' on' : '') + '" data-real="' + esc(f.callsign) + '">' +
    '<span class="n">' + esc(f.number || f.callsign) + '</span><span><b>' + (f.from ? esc(f.from) + ' → ' + esc(f.to) : 'Route inconnue') + '</b><br><span class="c">' + esc(f.from ? (f.fromName || '') + ' – ' + (f.toName || '') : f.callsign) + '</span></span>' +
    '<span class="a">FL' + (f.altFt != null ? Math.round(f.altFt / 100) : '—') + '<br>' + (f.gsKt != null ? f.gsKt + ' kt' : '') + '</span></button>').join('')
    : '<div class="empty">' + (S.real.flights.length ? 'Aucun vol ne correspond à ces filtres.' : 'Aucun vol à afficher pour le moment.') + '</div>';
  renderRealDetail();
}
function renderRealDetail() {
  const f = S.real.flights.find((x) => x.callsign === S.real.sel);
  if (!f) { $('realDetail').innerHTML = '<p class="muted">Choisis un vol dans la liste.</p>'; return; }
  const d = S.real.det[f.callsign] || {};
  const from = f.from || d.from; const to = f.to || d.to;
  const type = d.type || '';
  const kv = (k, v) => '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  const sb = from && to ? 'https://dispatch.simbrief.com/options/custom?' + new URLSearchParams(Object.assign({ orig: from, dest: to, airline: 'AFR', fltnum: (f.number || '').replace(/\D/g, '') }, type ? { type } : {})).toString() : '';
  $('realDetail').innerHTML = '<div class="muted small">' + esc(f.callsign) + ' · en vol</div><h2>' + (from ? esc(from) + ' → ' + esc(to) : 'Route inconnue') + '</h2>' +
    '<div style="font-weight:600">' + esc(from ? (f.fromName || d.fromName || '') + ' – ' + (f.toName || d.toName || '') : '') + '</div>' +
    '<div class="kv">' + kv('Vol', esc(f.number || f.callsign)) + kv('Appareil', d.pending ? '…' : esc(type ? type + (d.reg ? ' · ' + d.reg : '') : 'Inconnu')) +
    kv('Altitude', f.altFt != null ? 'FL' + Math.round(f.altFt / 100) : '—') + kv('Vitesse sol', f.gsKt != null ? f.gsKt + ' kt' : '—') +
    kv('Cap', f.track != null ? f.track + '°' : '—') + kv('Vario', f.vsFpm != null ? f.vsFpm + ' ft/min' : '—') + '</div>' +
    '<p class="muted small"><b>Ce qui sera copié vers SimBrief :</b> départ, arrivée, numéro de vol' + (type ? ' et type d’avion' : '') + '. SimBrief calcule ensuite la route, le carburant et le devis de masse.</p>' +
    (sb ? '<a class="btn red" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(sb) + '" target="_blank" rel="noopener">Copier vers SimBrief</a>' : '<p class="muted">Route inconnue : impossible de préparer le plan.</p>');
}
$('realList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-real]'); if (!b) return;
  const f = S.real.flights.find((x) => x.callsign === b.dataset.real); if (!f) return;
  S.real.sel = f.callsign;
  if (!S.real.det[f.callsign]) {
    S.real.det[f.callsign] = { pending: true };
    renderReal();
    S.real.det[f.callsign] = await afv.realDetails(f.callsign, f.icao24);
  }
  renderReal();
});
$('realAirport').addEventListener('change', renderReal);
$('realSearch').addEventListener('input', renderReal);
$('btnRealRefresh').addEventListener('click', () => loadReal(true));
document.querySelector('[data-tab=reels]').addEventListener('click', () => {
  if (!S.real.at || Date.now() - S.real.at > 5 * 60 * 1000) loadReal(false);
  clearInterval(realTimer);
  realTimer = setInterval(() => { if ($('tab-reels').classList.contains('on')) loadReal(false); else clearInterval(realTimer); }, 5 * 60 * 1000);
});

// ---------------- carte des vols réels ----------------
const VIEWS = { monde: [0, 0, 360, 150], europe: [165, 15, 50, 32], atlantique: [95, 20, 120, 60], antilles: [100, 60, 30, 20] };
let mapVB = VIEWS.monde.slice();
const MX = (lon) => lon + 180; const MY = (lat) => 90 - lat;
const PLANE = 'M0 -5 L1 -1.5 L5 1 L5 2 L1 1 L0.8 3.6 L2 4.6 L2 5.2 L0 4.6 L-2 5.2 L-2 4.6 L-0.8 3.6 L-1 1 L-5 2 L-5 1 L-1 -1.5 Z';
function renderRealMap(list) {
  const svg = $('realMap'); if (!svg) return;
  const [x, y, w, h] = mapVB;
  svg.setAttribute('viewBox', x + ' ' + y + ' ' + w + ' ' + h);
  const k = Math.pow(w / 360, 0.6); // les symboles rétrécissent moins vite que la carte au zoom
  let g = '';
  for (let lon = -150; lon <= 180; lon += 30) g += '<line class="grid" x1="' + MX(lon) + '" y1="0" x2="' + MX(lon) + '" y2="150" stroke-width="' + (0.1 * k * 3) + '"/>';
  for (let lat = 60; lat >= -60; lat -= 30) g += '<line class="grid" x1="0" y1="' + MY(lat) + '" x2="360" y2="' + MY(lat) + '" stroke-width="' + (0.1 * k * 3) + '"/>';
  let h2 = '<path class="land" d="' + (window.WORLD_PATH || '') + '" stroke-width="' + (0.25 * k) + '"/>' + g;
  const sel = S.real.flights.find((f) => f.callsign === S.real.sel);
  if (sel) {
    const d = S.real.det[sel.callsign] || {};
    const fp = sel.fromPos || d.fromPos; const tp = sel.toPos || d.toPos;
    const pts = [fp, [sel.lat, sel.lon], tp].filter(Boolean);
    if (pts.length > 1) h2 += '<polyline class="rte" stroke-width="' + (0.35 * k) + '" stroke-dasharray="' + (1.6 * k) + ' ' + (1 * k) + '" points="' + pts.map((p) => MX(p[1]) + ',' + MY(p[0])).join(' ') + '"/>';
    for (const [p, code] of [[fp, sel.from || d.from], [tp, sel.to || d.to]]) if (p) {
      h2 += '<circle class="ap" cx="' + MX(p[1]) + '" cy="' + MY(p[0]) + '" r="' + (1 * k) + '" stroke-width="' + (0.35 * k) + '"/>' +
        '<text class="lbl" x="' + (MX(p[1]) + 1.6 * k) + '" y="' + (MY(p[0]) - 1.2 * k) + '" font-size="' + (3.4 * k) + '">' + esc(code || '') + '</text>';
    }
  }
  const sz = 0.33 * k;
  for (const f of list) {
    const on = f.callsign === S.real.sel;
    h2 += '<g class="pl' + (on ? ' on' : '') + '" data-real="' + esc(f.callsign) + '" transform="translate(' + MX(f.lon).toFixed(2) + ' ' + MY(f.lat).toFixed(2) + ') rotate(' + (f.track || 0) + ') scale(' + (on ? sz * 1.5 : sz) + ')"><title>' + esc((f.number || f.callsign) + (f.from ? ' · ' + f.from + ' → ' + f.to : '')) + '</title><circle r="7" fill="transparent"/><path d="' + PLANE + '"/></g>';
  }
  svg.innerHTML = h2;
}
function setView(vb) {
  mapVB = vb;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', VIEWS[b.dataset.view] && VIEWS[b.dataset.view].join() === vb.join()));
  renderRealMap(realShown());
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(VIEWS[b.dataset.view].slice()); });
(function mapControls() {
  const svg = $('realMap');
  const toMap = (ev) => { const r = svg.getBoundingClientRect(); return [mapVB[0] + ((ev.clientX - r.left) / r.width) * mapVB[2], mapVB[1] + ((ev.clientY - r.top) / r.height) * mapVB[3]]; };
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [mx, my] = toMap(ev);
    const f = ev.deltaY > 0 ? 1.25 : 0.8;
    const w = Math.min(360, Math.max(8, mapVB[2] * f)); const h = w * (mapVB[3] / mapVB[2]);
    setView([mx - (mx - mapVB[0]) * (w / mapVB[2]), my - (my - mapVB[1]) * (h / mapVB[3]), w, h]);
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => { if (ev.target.closest('.pl')) return; drag = { x: ev.clientX, y: ev.clientY, vb: mapVB.slice() }; svg.setPointerCapture(ev.pointerId); });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    setView([drag.vb[0] - ((ev.clientX - drag.x) / r.width) * drag.vb[2], drag.vb[1] - ((ev.clientY - drag.y) / r.height) * drag.vb[3], drag.vb[2], drag.vb[3]]);
  });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('click', async (ev) => {
    const g = ev.target.closest('.pl'); if (!g) return;
    const f = S.real.flights.find((x) => x.callsign === g.dataset.real); if (!f) return;
    S.real.sel = f.callsign;
    if (!S.real.det[f.callsign]) { S.real.det[f.callsign] = { pending: true }; renderReal(); S.real.det[f.callsign] = await afv.realDetails(f.callsign, f.icao24); }
    renderReal();
    const el = document.querySelector('#realList [data-real="' + CSS.escape(f.callsign) + '"]'); if (el) el.scrollIntoView({ block: 'nearest' });
  });
})();

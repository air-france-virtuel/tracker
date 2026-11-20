'use strict';
/* global afv */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PHASES = ['Boarding', 'Roulage', 'Décollage', 'Montée', 'Croisière', 'Descente', 'Approche', 'Atterrissage', 'Parking'];

const S = { store: null, plan: null, flight: null, phase: null, simOk: false, muted: false, lastT: null, trail: [], stars: 0, tags: {} };

// ---------------- navigation ----------------
document.querySelectorAll('.nav[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.nav').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + name));
  if (name === 'vols') renderReports();
  if (name === 'livrees') loadLiveries(false);
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
    { key: 'boarding_welcome', phase: 0, title: 'Bienvenue à bord', text: 'Mesdames et messieurs, bonjour et bienvenue à bord de ce vol Les Ailes Tricolores à destination de ' + dest + '. Merci de ranger vos bagages et de prendre place.' },
    { key: 'boarding_safety', phase: 0, title: 'Consignes de sécurité', text: 'Nous allons vous présenter les consignes de sécurité. Merci de bien vouloir suivre la démonstration de l’équipage.' },
    { key: 'taxi_crew', phase: 1, title: 'Préparation au départ', text: 'Personnel navigant, préparation pour le départ. Mesdames et messieurs, veuillez attacher votre ceinture.' },
    { key: 'takeoff_crew', phase: 2, title: 'Décollage', text: 'Personnel navigant, à vos places pour le décollage.' },
    { key: 'cruise_seatbelt', phase: 4, title: 'Fin de la montée', text: 'Le signal lumineux vient de s’éteindre. Vous pouvez détacher votre ceinture, mais nous vous conseillons de la garder attachée lorsque vous êtes assis.' },
    { key: 'cruise_captain', phase: 4, title: 'Message du commandant', text: 'Ici votre commandant de bord. Nous volons à ' + fl.toLocaleString('fr-FR') + ' pieds. Le vol se déroule normalement. Bon voyage.' },
    { key: 'descent_start', phase: 5, title: 'Début de la descente', text: 'Mesdames et messieurs, nous avons commencé notre descente vers ' + dest + '. Merci de regagner votre siège et de relever votre tablette.' },
    { key: 'approach_crew', phase: 6, title: 'Atterrissage', text: 'Personnel navigant, à vos places pour l’atterrissage.' },
    { key: 'landing_welcome', phase: 7, title: 'Bienvenue à destination', text: 'Mesdames et messieurs, bienvenue à ' + dest + '. Merci de rester assis, ceinture attachée, jusqu’à l’arrêt complet de l’appareil.' },
    { key: 'parking_deplane', phase: 8, title: 'Débarquement', text: 'Nous sommes arrivés au parking. Merci d’avoir choisi Les Ailes Tricolores. Nous vous souhaitons une excellente journée.' }
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
    ['Vario', (t.vs > 0 ? '+' : '') + fmt(t.vs) + ' ft/min'], ['Cap', fmt(t.hdg) + '°'],
    ['Vent', t.windKt != null && Number.isFinite(t.windKt) ? String(Math.round(t.windDir)).padStart(3, '0') + '° / ' + fmt(t.windKt) + ' kt' : '—']
  ];
  $('telem').innerHTML = items.map(([k, v]) => '<div class="tl"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
}
S.mapMode = 'route';
S.lastPos = null;
S.layers = { vol: { sat: false, radar: false }, reels: { sat: false, radar: false } };
// Squelette d'une carte : océan, satellite, terres, radar, puis le dessin du vol par-dessus.
function mapSkeleton(svg) {
  if (svg.querySelector('.fg')) return;
  svg.innerHTML = '<rect class="ocean" x="-2000" y="-2000" width="5000" height="5000" fill="#DCE6F5"/><g class="sat"></g>' +
    '<path class="landp" d="' + (window.WORLD_PATH || '') + '" fill="#F7F9FC" stroke="#B8C4DA" stroke-width="0.8" vector-effect="non-scaling-stroke"/><g class="radar"></g><g class="fg"></g>';
}
// Applique les fonds (plan / satellite / radar) à une carte : m = matrice Mercator → écran, view = zone visible.
function applyLayers(svg, which, m, view, ppu, redraw) {
  const L = S.layers[which];
  const mat = 'matrix(' + m.join(' ') + ')';
  for (const sel of ['.sat', '.landp', '.radar']) svg.querySelector(sel).setAttribute('transform', mat);
  svg.querySelector('.ocean').setAttribute('fill', L.sat ? '#0B1F3F' : '#DCE6F5');
  const land = svg.querySelector('.landp');
  land.setAttribute('fill', L.sat ? 'none' : '#F7F9FC');
  land.setAttribute('stroke', L.sat ? 'rgba(255,255,255,.55)' : '#B8C4DA');
  MapLayers.fill(svg.querySelector('.sat'), { view, pxPerUnit: ppu, sat: L.sat, radar: false });
  MapLayers.fill(svg.querySelector('.radar'), { view, pxPerUnit: ppu, sat: false, radar: L.radar, onReady: redraw });
}
function renderMap(t) {
  const pl = S.plan;
  const svg = $('map');
  mapSkeleton(svg);
  const fg = svg.querySelector('.fg');
  if (t && t.lat != null) S.lastPos = t; else t = t || S.lastPos;
  const pts = pl ? (pl.route_points && pl.route_points.length ? pl.route_points : [pl.origin, pl.destination]).map((p) => ({ lat: p.lat, lon: p.lon })) : [];
  if (!pl && !t) {
    applyLayers(svg, 'vol', [0.8, 0, 0, 0.8, 300 - 180 * 0.8, 150 - 140 * 0.8], [0, 0, 360, 360], 0.8, () => renderMap(null));
    fg.innerHTML = '<rect x="120" y="128" width="360" height="34" rx="8" fill="rgba(255,255,255,.9)"/><text x="300" y="150" text-anchor="middle" fill="#5B667D" font-size="13">La carte suit l’avion dès le début du suivi</text>';
    return;
  }
  const box = S.mapMode === 'avion' && t ? [{ lat: t.lat - 2.2, lon: t.lon - 2.2 }, { lat: t.lat + 2.2, lon: t.lon + 2.2 }] : (pts.length ? pts.concat(S.trail) : [{ lat: t.lat - 2.2, lon: t.lon - 2.2 }, { lat: t.lat + 2.2, lon: t.lon + 2.2 }]);
  const xs = box.map((p) => MapLayers.LX(p.lon)), ys = box.map((p) => MapLayers.LY(p.lat));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sc = Math.min(540 / Math.max(0.3, x1 - x0), 240 / Math.max(0.3, y1 - y0));
  const ox = 300 - ((x0 + x1) / 2) * sc, oy = 150 - ((y0 + y1) / 2) * sc;
  const X = (p) => (MapLayers.LX(p.lon) * sc + ox).toFixed(1), Y = (p) => (MapLayers.LY(p.lat) * sc + oy).toFixed(1);
  const line = (arr) => arr.map((p, i) => (i ? 'L' : 'M') + X(p) + ' ' + Y(p)).join(' ');
  const ppu = sc * ((svg.clientWidth || 600) / 600);
  applyLayers(svg, 'vol', [sc, 0, 0, sc, ox, oy], [-ox / sc, -oy / sc, (600 - ox) / sc, (300 - oy) / sc], ppu, () => renderMap(null));
  const sat = S.layers.vol.sat;
  const ink = sat ? '#fff' : '#0A1E4A';
  const halo = sat ? '#0A1E4A' : '#fff';
  let h2 = '';
  if (pl) h2 += '<path d="' + line(pts) + '" fill="none" stroke="' + (sat ? '#C9D4EE' : '#7F8CA8') + '" stroke-width="2" stroke-dasharray="6 6"/>';
  if (S.trail.length > 1) h2 += '<path d="' + line(S.trail) + '" fill="none" stroke="' + (sat ? '#3DDC84' : '#0A1E4A') + '" stroke-width="3"/>';
  if (pl) {
    for (const [p, dy] of [[pl.origin, -12], [pl.destination, 22]]) {
      h2 += '<circle cx="' + X(p) + '" cy="' + Y(p) + '" r="6" fill="' + halo + '" stroke="' + ink + '" stroke-width="3"/>';
      h2 += '<text x="' + X(p) + '" y="' + (+Y(p) + dy) + '" text-anchor="middle" font-size="13" font-weight="700" fill="' + ink + '" paint-order="stroke" stroke="' + halo + '" stroke-width="3">' + esc(p.icao) + '</text>';
    }
    if (pl.tod) h2 += '<circle cx="' + X(pl.tod) + '" cy="' + Y(pl.tod) + '" r="4" fill="#E0A800"/><text x="' + X(pl.tod) + '" y="' + (Y(pl.tod) - 8) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#7A5B00" paint-order="stroke" stroke="#fff" stroke-width="3">TOD</text>';
  }
  if (t) h2 += '<g transform="translate(' + X(t) + ' ' + Y(t) + ') rotate(' + ((t.hdg || 0) - 90).toFixed(0) + ')"><path d="M12 0 L-8 -8 L-4 0 L-8 8 Z" fill="#C8102E" stroke="#fff" stroke-width="1.5"/></g>';
  if (S.layers.vol.radar) h2 += '<text x="592" y="292" text-anchor="end" font-size="10" fill="' + ink + '" paint-order="stroke" stroke="' + halo + '" stroke-width="3">Radar : RainViewer' + (MapLayers.state.radar ? ' · ' + new Date(MapLayers.state.radar.time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '') + '</text>';
  else if (sat) h2 += '<text x="592" y="292" text-anchor="end" font-size="10" fill="#fff">Images : NASA GIBS</text>';
  fg.innerHTML = h2;
  $('mapFrom').textContent = pl ? pl.origin.icao + (pl.origin.rwy ? ' · piste ' + pl.origin.rwy : '') : '';
  $('mapTo').textContent = pl ? pl.destination.icao + (pl.destination.rwy ? ' · piste ' + pl.destination.rwy : '') : '';
}
// Boutons Plan / Satellite / Radar (carte du tracker et carte des vols réels)
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-layer]'); if (!b) return;
  const [which, kind] = b.dataset.layer.split(':');
  const L = S.layers[which];
  if (kind === 'radar') L.radar = !L.radar; else L.sat = kind === 'sat';
  document.querySelectorAll('[data-layer^="' + which + ':"]').forEach((x) => {
    const k = x.dataset.layer.split(':')[1];
    const on = k === 'radar' ? L.radar : (k === 'sat' ? L.sat : !L.sat);
    x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on));
  });
  if (which === 'vol') renderMap(null); else renderRealMap(realShown());
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mapmode]'); if (!b) return;
  S.mapMode = b.dataset.mapmode;
  document.querySelectorAll('[data-mapmode]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
  renderMap(null);
});
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
    showBriefing(S.plan, true);
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
  opsReset();
  $('alerts').innerHTML = '';
  $('prep').hidden = true; $('live').hidden = false; $('btnStop').hidden = false;
  const curM = missionId && S.career ? S.career.missions.find((m) => m.id === missionId) : null;
  $('flightSub').textContent = (curM ? 'Mission : ' + curM.title + ' · ' : '') + (S.plan ? (S.plan.callsign || '') + ' · ' + S.plan.origin.icao + ' → ' + S.plan.destination.icao : 'Vol sans plan SimBrief') + (aircraft ? ' · ' + aircraft : '') + (mode === 'demo' ? ' · démonstration' : '');
  S.lastPos = null;
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
  S.lastTod = d.tod;
  opsTick(t, d);
});
afv.on('flight:event', (e) => {
  if (!S.flight) return;
  opsEvent(e);
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
  return 'Avis bêta tracker Les Ailes Tricolores v' + $('ver').textContent + '\nNote : ' + S.stars + '/5\nPoints à améliorer : ' + (tags.join(', ') || '—') + '\n' + $('fbText').value.trim();
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
  $('sMaxVoice').checked = s.maxVoice !== false; $('sDiscord').checked = s.discord !== false; $('sChat').checked = s.chat !== false; $('sTray').checked = s.closeToTray !== false; $('sMaxVol').value = s.maxVolume != null ? s.maxVolume : 0.9;
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
  S.store.settings = await afv.setSettings({ pilot: $('sPilot').value.trim(), simbrief: $('sSimbrief').value.trim(), announcements: $('sAnn').checked, volume: +$('sVol').value, hard1: h1, hard2: h2, maxVoice: $('sMaxVoice').checked, maxVolume: +$('sMaxVol').value, discord: $('sDiscord').checked, chat: $('sChat').checked, closeToTray: $('sTray').checked });
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
    error: 'Vérification impossible pour le moment. Réessaie plus tard.',
    blocked: 'Windows a bloqué l’installation de la version ' + esc(u.version) + '.'
  }[u.state] || '';
  h += '<div style="text-align:right">' + (u.state === 'ready' ? '<button class="btn red" id="btnInstallNow">Redémarrer et installer</button>' : '') + '</div></div>';
  h += '<p class="muted">' + st + '</p>';
  if (u.state === 'error' && u.error) h += '<p class="muted small">Détail : ' + esc(u.error) + '</p>';
  if (u.failed || u.state === 'blocked') h += '<div class="updfail">' + updFailHtml(u) + '</div>';
  else if (u.state !== 'dev') h += '<p class="muted small">La mise à jour ne s’installe pas ? <button class="linkbtn" data-manualupd>Télécharger l’installateur à la main</button></p>';
  if (u.state === 'downloading') h += '<div class="progress"><i style="width:' + (u.percent || 0) + '%"></i></div>';
  if ((u.state === 'ready' || u.state === 'downloading') && u.notes) h += '<div class="muted small">Ce qui change dans la version ' + esc(u.version) + ' :</div><div class="notes">' + esc(stripHtml(u.notes)) + '</div>';
  $('updCard').innerHTML = h;
  const b = $('btnInstallNow'); if (b) b.addEventListener('click', () => afv.installUpdate());
  $('updDot').hidden = u.state !== 'ready';
  $('updBanner').hidden = u.state !== 'ready';
  $('updBannerText').textContent = 'La version ' + (u.version || '') + ' du tracker est prête.' + (S.flight ? ' Installe-la après ton vol.' : '');
}
afv.on('update:status', (u) => { const was = UPD && UPD.state; UPD = u; renderUpdate(); if (u.state === 'blocked' && was !== 'blocked') updFailPopup(); else updPopup(); });
// Mise à jour bloquée (Windows Smart App Control, antivirus…) : explication et téléchargement à la main.
function updFailHtml(u) {
  const v = (u.failed && u.failed.version) || u.version || '';
  return '<p><b>La version ' + esc(v) + ' n’a pas pu s’installer.</b> Windows a sûrement bloqué l’installateur, car il n’est pas encore signé numériquement (protection « Smart App Control » ou antivirus). Ce n’est pas un virus.</p>' +
    '<ol class="small"><li>Clique sur <b>Télécharger l’installateur</b> : il s’ouvre dans ton navigateur.</li><li>Ferme le tracker, puis lance le fichier téléchargé <b>LesAilesTricolores-Tracker-Setup.exe</b>.</li>' +
    '<li>Si Windows le bloque encore : <b>Paramètres › Confidentialité et sécurité › Sécurité Windows › Contrôle des applications et du navigateur › Paramètres de Smart App Control</b>. Attention, selon ta version de Windows, le désactiver peut être définitif : c’est ton choix.</li></ol>' +
    '<div class="row"><button class="btn red" data-manualupd>Télécharger l’installateur</button></div>' + (u.error ? '<p class="muted small">Détail : ' + esc(u.error) + '</p>' : '');
}
function updFailPopup() {
  $('updModalTitle').textContent = 'La mise à jour n’a pas pu s’installer';
  $('updModalBody').innerHTML = updFailHtml(UPD);
  $('btnUpdModalInstall').hidden = true;
  $('btnUpdModalLater').textContent = 'Fermer';
  $('updModal').hidden = false;
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-manualupd]')) afv.manualUpdate(); });

// Pop-up dès qu'une nouvelle version est trouvée (une fois par version).
S.updSeen = {};
function updPopup() {
  const u = UPD;
  if (u && u.failed) return; // l'explication du blocage reste affichée
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
$('btnUpdModalLater').addEventListener('click', () => { $('updModal').hidden = true; if (UPD && UPD.failed) afv.updateFailedSeen(); });
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
  UPD = await afv.getUpdate(); renderUpdate(); if (UPD.failed) updFailPopup(); else updPopup();
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
S.real = { flights: [], sel: null, det: {}, mode: 'live', sched: [], ssel: null };
let realTimer = null;
async function loadReal(force) {
  if (S.real.mode !== 'live') return loadSched();
  $('realSub').textContent = 'Chargement des vols Air France en cours…';
  const r = await afv.realLive(force);
  S.real.flights = r.flights || [];
  S.real.at = r.at;
  const when = r.at ? new Date(r.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  $('realSub').textContent = r.error && !S.real.flights.length ? r.error
    : S.real.flights.length + ' vols Air France en l’air' + (when ? ' · mis à jour à ' + when : '') + (r.error ? ' · ' + r.error : '');
  fillAirports(S.real.flights);
  renderReal();
}
// Vols du programme officiel : à venir (pas encore partis) ou précédents (déjà arrivés)
function realSource() {
  if (S.real.mode === 'live') return S.real.flights;
  const now = Date.now();
  if (S.real.mode === 'next') return S.real.sched.filter((f) => f.depEst && f.depEst > now).sort((a, b) => a.depEst - b.depEst);
  return S.real.sched.filter((f) => f.arrEst && f.arrEst < now).sort((a, b) => b.arrEst - a.arrEst);
}
async function loadSched() {
  $('realSub').textContent = 'Chargement du programme du jour…';
  const d = await afv.getPlanning(false);
  S.real.sched = (d.flights || []).filter((f) => f.scheduled);
  S.real.schedSrc = d.source;
  const list = realSource();
  $('realSub').textContent = !d.source ? 'Programme du jour pas encore disponible (il est mis à jour chaque nuit).'
    : list.length + ' vols Air France ' + (S.real.mode === 'next' ? 'à venir' : 'déjà arrivés') + ' aujourd’hui · programme AeroDataBox';
  fillAirports(list);
  renderReal();
}
function fillAirports(list) {
  const aps = [...new Set(list.flatMap((f) => [f.from, f.to]).filter(Boolean))].sort();
  const cur = $('realAirport').value || 'all';
  $('realAirport').innerHTML = '<option value="all">Tous</option>' + aps.map((a) => '<option>' + esc(a) + '</option>').join('');
  $('realAirport').value = aps.includes(cur) ? cur : 'all';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-rmode]'); if (!b) return;
  S.real.mode = b.dataset.rmode;
  document.querySelectorAll('[data-rmode]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
  if (S.real.mode === 'live') loadReal(false); else loadSched();
});
function realShown() {
  const ap = $('realAirport').value;
  const q = $('realSearch').value.trim().toUpperCase().replace(/\s+/g, '');
  return realSource().filter((f) => (ap === 'all' || f.from === ap || f.to === ap) &&
    (!q || [f.callsign, f.number, f.from, f.to, f.fromName, f.toName, f.fromIata, f.toIata].some((x) => String(x || '').toUpperCase().replace(/\s+/g, '').includes(q))));
}
const hhmm = (t) => (t ? new Date(t).toISOString().slice(11, 16) + 'Z' : '—');
function renderReal() {
  const list = realShown();
  renderRealMap(list);
  $('realMapTitle').textContent = S.real.mode === 'live' ? 'Carte des vols en cours' : S.real.mode === 'next' ? 'Carte des vols à venir' : 'Carte des vols précédents';
  if (S.real.mode !== 'live') {
    $('realList').innerHTML = list.length ? list.slice(0, 250).map((f) => '<button class="rt' + (f.key === S.real.ssel ? ' on' : '') + '" data-sreal="' + esc(f.key) + '">' +
      '<span class="n">' + esc(f.number) + '</span><span><b>' + esc(f.from) + ' → ' + esc(f.to) + '</b><br><span class="c">' + esc((f.fromName || '') + ' – ' + (f.toName || '')) + (f.type ? ' · ' + esc(f.type) : '') + '</span></span>' +
      '<span class="a">' + (f.status === 'Annulé' ? '<b style="color:#8A1026">Annulé</b>' : S.real.mode === 'next' ? 'Départ<br>' + hhmm(f.depEst) : 'Arrivé<br>' + hhmm(f.arrEst)) + '</span></button>').join('')
      : '<div class="empty">' + (S.real.schedSrc ? 'Aucun vol ne correspond à ces filtres.' : 'Le programme du jour n’est pas encore disponible.') + '</div>';
    renderSchedDetail();
    return;
  }
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
// Vues prédéfinies, données en lon/lat puis converties en Mercator.
const vbox = (lon0, lat1, lon1, lat0) => [MapLayers.LX(lon0), MapLayers.LY(lat1), MapLayers.LX(lon1) - MapLayers.LX(lon0), MapLayers.LY(lat0) - MapLayers.LY(lat1)];
const VIEWS = { monde: vbox(-180, 78, 180, -58), europe: vbox(-12, 60, 32, 34), atlantique: vbox(-85, 58, 35, 5), antilles: vbox(-72, 22, -55, 10) };
let mapVB = VIEWS.monde.slice();
const MX = (lon) => MapLayers.LX(lon); const MY = (lat) => MapLayers.LY(lat);
const PLANE = 'M0 -5 L1 -1.5 L5 1 L5 2 L1 1 L0.8 3.6 L2 4.6 L2 5.2 L0 4.6 L-2 5.2 L-2 4.6 L-0.8 3.6 L-1 1 L-5 2 L-5 1 L-1 -1.5 Z';
function renderRealMap(list) {

  const svg = $('realMap'); if (!svg) return;
  mapSkeleton(svg);
  const [x, y, w, h] = mapVB;
  // la carte garde le rapport largeur/hauteur de l'écran
  const ratio = (svg.clientHeight || 420) / (svg.clientWidth || 1000);
  const hh = w * ratio, yy = y + h / 2 - hh / 2;
  svg.setAttribute('viewBox', x + ' ' + yy + ' ' + w + ' ' + hh);
  mapVB = [x, yy, w, hh];
  const ppu = (svg.clientWidth || 1000) / w;
  applyLayers(svg, 'reels', [1, 0, 0, 1, 0, 0], [x, yy, x + w, yy + hh], ppu, () => renderRealMap(realShown()));
  const k = Math.pow(w / 360, 0.6);
  const sat = S.layers.reels.sat;
  const ink = sat ? '#fff' : '#0A1E4A', halo = sat ? '#0A1E4A' : '#fff';
  let h2 = '';
  const sel = S.real.mode === 'live' ? S.real.flights.find((f) => f.callsign === S.real.sel) : null;
  if (sel) {
    const d = S.real.det[sel.callsign] || {};
    const fp = sel.fromPos || d.fromPos; const tp = sel.toPos || d.toPos;
    const pts = [fp, [sel.lat, sel.lon], tp].filter(Boolean);
    if (pts.length > 1) h2 += '<polyline fill="none" stroke="#F0374E" stroke-width="' + (0.35 * k) + '" stroke-dasharray="' + (1.6 * k) + ' ' + (1 * k) + '" points="' + pts.map((p) => MX(p[1]) + ',' + MY(p[0])).join(' ') + '"/>';
    for (const [p, code] of [[fp, sel.from || d.from], [tp, sel.to || d.to]]) if (p) {
      h2 += '<circle cx="' + MX(p[1]) + '" cy="' + MY(p[0]) + '" r="' + (1 * k) + '" fill="' + halo + '" stroke="#F0374E" stroke-width="' + (0.35 * k) + '"/>' +
        '<text x="' + (MX(p[1]) + 1.6 * k) + '" y="' + (MY(p[0]) - 1.2 * k) + '" font-size="' + (3.4 * k) + '" font-weight="700" fill="' + ink + '" paint-order="stroke" stroke="' + halo + '" stroke-width="' + (0.6 * k) + '">' + esc(code || '') + '</text>';
    }
  }
  const sz = 0.33 * k;
  if (S.real.mode !== 'live') {
    // programme : une ligne par vol (départ → arrivée), le vol choisi en rouge
    for (const f of list.slice(0, 250)) {
      if (!f.fromPos || !f.toPos) continue;
      const on = f.key === S.real.ssel;
      h2 += '<line x1="' + MX(f.fromPos[1]) + '" y1="' + MY(f.fromPos[0]) + '" x2="' + MX(f.toPos[1]) + '" y2="' + MY(f.toPos[0]) + '" stroke="' + (on ? '#F0374E' : (sat ? 'rgba(255,255,255,.45)' : 'rgba(10,30,74,.28)')) + '" stroke-width="' + ((on ? 0.45 : 0.18) * k) + '"/>';
      if (on) for (const [p, c] of [[f.fromPos, f.from], [f.toPos, f.to]]) h2 += '<circle cx="' + MX(p[1]) + '" cy="' + MY(p[0]) + '" r="' + (1 * k) + '" fill="' + halo + '" stroke="#F0374E" stroke-width="' + (0.35 * k) + '"/><text x="' + (MX(p[1]) + 1.6 * k) + '" y="' + (MY(p[0]) - 1.2 * k) + '" font-size="' + (3.4 * k) + '" font-weight="700" fill="' + ink + '" paint-order="stroke" stroke="' + halo + '" stroke-width="' + (0.6 * k) + '">' + esc(c) + '</text>';
    }
    list = [];
  }
  for (const f of list) {
    const on = f.callsign === S.real.sel;
    h2 += '<g class="pl' + (on ? ' on' : '') + '" data-real="' + esc(f.callsign) + '" transform="translate(' + MX(f.lon).toFixed(2) + ' ' + MY(f.lat).toFixed(2) + ') rotate(' + (f.track || 0) + ') scale(' + (on ? sz * 1.5 : sz) + ')"><title>' + esc((f.number || f.callsign) + (f.from ? ' · ' + f.from + ' → ' + f.to : '')) + '</title><circle r="7" fill="transparent"/><path d="' + PLANE + '"' + (sat && !on ? ' style="fill:#fff"' : '') + '/></g>';
  }
  svg.querySelector('.fg').innerHTML = h2;
  const credit = ['Fond : Natural Earth'];
  if (sat) credit.push('Satellite : NASA GIBS');
  if (S.layers.reels.radar) credit.push('Radar : RainViewer' + (MapLayers.state.radar ? ' (' + new Date(MapLayers.state.radar.time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ')' : ''));
  const c = $('realCredit'); if (c) c.textContent = credit.join(' · ');
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
    const w = Math.min(360, Math.max(4, mapVB[2] * f)); const h = w * (mapVB[3] / mapVB[2]);
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

// ---------------- tracker « centre des opérations » ----------------
const R_NM = 3440.065;
function hav(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
const utc = (ms) => ms ? new Date(ms).toISOString().slice(11, 16) + 'Z' : '—';
// Route du plan : points avec distance cumulée, altitude et carburant prévus.
function buildRoute(pl) {
  if (!pl) return null;
  let pts = (pl.route_points || []).map((p) => Object.assign({}, p));
  if (!pts.length || pts[0].ident !== pl.origin.icao) pts.unshift({ ident: pl.origin.icao, lat: pl.origin.lat, lon: pl.origin.lon, alt: pl.origin.elev || 0 });
  if (pts[pts.length - 1].ident !== pl.destination.icao) pts.push({ ident: pl.destination.icao, lat: pl.destination.lat, lon: pl.destination.lon, alt: pl.destination.elev || 0 });
  let cum = 0;
  pts.forEach((p, i) => { if (i) cum += hav(pts[i - 1], p); p.cum = cum; if (p.alt == null) p.alt = i === 0 || i === pts.length - 1 ? 0 : pl.cruiseAlt; });
  return { pts, total: cum };
}
// Position projetée sur la route : distance parcourue et prochain point.
function alongRoute(R, t) {
  let best = { d: Infinity, along: 0, next: 1 };
  for (let i = 0; i < R.pts.length - 1; i++) {
    const a = R.pts[i], b = R.pts[i + 1];
    const k = Math.cos(t.lat * Math.PI / 180);
    const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = t.lon * k, py = t.lat;
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1e-9;
    const f = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2));
    const d = Math.hypot(px - (ax + f * (bx - ax)), py - (ay + f * (by - ay)));
    if (d < best.d) best = { d, along: a.cum + f * (b.cum - a.cum), next: f >= 0.999 ? i + 2 : i + 1 };
  }
  best.next = Math.min(best.next, R.pts.length - 1);
  return best;
}
function plannedFuel(R, along) {
  const p = R.pts.filter((x) => x.fuelKg != null);
  if (p.length < 2) return null;
  for (let i = 0; i < p.length - 1; i++) if (along <= p[i + 1].cum) { const f = (along - p[i].cum) / ((p[i + 1].cum - p[i].cum) || 1); return p[i].fuelKg + f * (p[i + 1].fuelKg - p[i].fuelKg); }
  return p[p.length - 1].fuelKg;
}
function opsReset() {
  S.route = buildRoute(S.plan);
  S.oooi = {}; S.prof = []; S.ops = null; S.opsT = 0;
  renderStrip(null); renderNavlog(); renderProfile();
}
function opsEvent(e) {
  const now = Date.now();
  if (e.type === 'phase') {
    if (e.phase === 1 && !S.oooi.out) S.oooi.out = now;
    if (e.phase === 3 && !S.oooi.off) S.oooi.off = now;
    if (e.phase === 8 && !S.oooi.in) S.oooi.in = now;
  } else if (e.type === 'landing' && !S.oooi.on) S.oooi.on = now;
}
function opsTick(t, d) {
  const R = S.route;
  const o = { t, remaining: null, along: 0, next: null, eta: null, fuelPlan: null };
  if (R) {
    const a = alongRoute(R, t);
    o.along = a.along; o.remaining = Math.max(0, R.total - a.along); o.next = R.pts[a.next];
    o.fuelPlan = plannedFuel(R, a.along);
    const last = S.prof[S.prof.length - 1];
    if (!last || Math.abs(last.d - a.along) > R.total / 300 || Math.abs(last.alt - t.alt) > 400) S.prof.push({ d: a.along, alt: t.alt });
  }
  if (o.remaining != null) {
    if (!t.onGround && t.gs > 60) o.eta = Date.now() + (o.remaining / t.gs) * 3600000;
    else if (S.plan && S.plan.eteSec) o.eta = Date.now() + S.plan.eteSec * 1000;
  }
  S.ops = o;
  renderStrip(o);
  const now = Date.now();
  if (now - S.opsT > 1000) { S.opsT = now; renderNavlog(); renderProfile(); pushCompact(); }
}
function windOf(metar) { const m = /\b(\d{3}|VRB)(\d{2,3})(G\d{2,3})?KT\b/.exec(metar || ''); return m ? (m[1] === 'VRB' ? 'Vent variable' : m[1] + '°') + ' / ' + (+m[2]) + ' kt' : ''; }
function renderStrip(o) {
  const pl = S.plan, R = S.route, t = o && o.t;
  const ph = S.phase != null ? PHASES[S.phase] : '';
  const cell = (k, v, sub, cls) => '<div><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s ' + (cls || '') + '">' + (sub || '&nbsp;') + '</div></div>';
  const cs = (pl && (pl.callsign || pl.flightNumber)) || 'Vol libre';
  let h = '<div><div class="cs">' + esc(cs) + (ph ? '<span class="stat">' + esc(ph.toUpperCase()) + '</span>' : '') + '</div><div class="muted small">' +
    (pl ? esc(pl.origin.icao) + ' → ' + esc(pl.destination.icao) + ' · ' : '') + esc(S.flight && S.flight.aircraft ? S.flight.aircraft : (pl && pl.aircraft) || '') + '</div></div>';
  h += cell('Out · parking', utc(S.oooi && S.oooi.out), S.oooi && S.oooi.out ? 'départ du parking' : 'en attente', 'mut');
  h += cell('Off · décollage', utc(S.oooi && S.oooi.off), pl && pl.origin.rwy ? 'piste ' + esc(pl.origin.rwy) : '', 'mut');
  let etaSub = 'arrivée estimée', etaCls = 'mut';
  if (o && o.eta && S.oooi && S.oooi.off && pl && pl.eteSec) {
    const diff = Math.round((o.eta - (S.oooi.off + pl.eteSec * 1000)) / 60000);
    etaSub = diff === 0 ? 'à l’heure du plan' : Math.abs(diff) + ' min ' + (diff < 0 ? 'd’avance' : 'de retard'); etaCls = diff > 5 ? 'warn' : '';
  }
  h += cell('ETA · arrivée', o && o.eta ? utc(o.eta) : '—', etaSub, etaCls);
  h += cell('Distance restante', o && o.remaining != null ? fmt(o.remaining) + ' NM' : '—', R && o && o.remaining != null ? Math.round((1 - o.remaining / R.total) * 100) + ' % parcouru' : '', 'mut');
  let fSub = '', fCls = 'mut';
  if (t && o.fuelPlan != null) { const df = (t.fuelKg - o.fuelPlan) / 1000; fSub = (df >= 0 ? '+' : '−') + fmt(Math.abs(df), 1) + ' t / plan'; fCls = df < -0.3 ? 'warn' : ''; }
  h += cell('Carburant', t ? fmt(t.fuelKg / 1000, 1) + ' t' : '—', fSub, fCls);
  h += cell('Arrivée prévue', pl && pl.destination.rwy ? 'Piste ' + esc(pl.destination.rwy) : (pl ? esc(pl.destination.icao) : '—'), pl ? esc(windOf(pl.metarArr)) : '', 'mut');
  $('strip').innerHTML = h;
}
function renderNavlog() {
  const R = S.route, el = $('navlog');
  if (!R) { el.innerHTML = '<p class="muted">Charge un plan SimBrief pour voir le navlog.</p>'; return; }
  const o = S.ops, along = o ? o.along : 0, gs = o && o.t && o.t.gs > 60 ? o.t.gs : null;
  const nextIdx = o && o.next ? R.pts.indexOf(o.next) : 1;
  const lvl = (a) => a >= 10000 ? 'FL' + String(Math.round(a / 100)).padStart(3, '0') : fmt(a) + ' ft';
  el.innerHTML = '<div class="scroll"><table><thead><tr><th>Point</th><th>Niveau</th><th>Dist.</th><th>ETA</th><th>Carb. prévu</th></tr></thead><tbody>' +
    R.pts.map((p, i) => {
      const cls = i < nextIdx ? 'past' : i === nextIdx ? 'cur' : '';
      const dist = p.cum - along;
      const eta = gs && dist > 0 ? utc(Date.now() + dist / gs * 3600000) : '—';
      return '<tr class="' + cls + '"><td>' + esc(p.ident) + '</td><td>' + lvl(p.alt || 0) + '</td><td>' + (dist > 0 ? fmt(dist) : '—') + '</td><td>' + eta + '</td><td>' + (p.fuelKg != null ? fmt(p.fuelKg / 1000, 1) + ' t' : '—') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  const cur = el.querySelector('tr.cur'); if (cur) { const sc = el.querySelector('.scroll'); sc.scrollTop = Math.max(0, cur.offsetTop - 60); }
}
function renderProfile() {
  const svg = $('profile'), R = S.route;
  if (!R) { svg.innerHTML = '<text x="320" y="85" text-anchor="middle" fill="#5B667D" font-size="13">Profil disponible avec un plan SimBrief</text>'; return; }
  const W = 640, H = 160, maxAlt = Math.max(10000, ...R.pts.map((p) => p.alt || 0), ...S.prof.map((p) => p.alt)) * 1.08;
  const x = (d) => 46 + d / R.total * (W - 66), y = (a) => H - 24 - Math.max(0, a) / maxAlt * (H - 40);
  let h = '';
  for (let fl = 100; fl * 100 < maxAlt; fl += 100) h += '<line x1="46" x2="' + (W - 20) + '" y1="' + y(fl * 100) + '" y2="' + y(fl * 100) + '" stroke="#EEF1F6"/><text x="4" y="' + (y(fl * 100) + 4) + '" font-size="10" fill="#8A94A8">FL' + fl + '</text>';
  h += '<line x1="46" x2="' + (W - 20) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="#DDE2EC"/>';
  h += '<path d="' + R.pts.map((p, i) => (i ? 'L' : 'M') + x(p.cum).toFixed(1) + ' ' + y(p.alt || 0).toFixed(1)).join(' ') + '" fill="none" stroke="#9AA6BF" stroke-width="2" stroke-dasharray="6 5"/>';
  for (const id of ['TOC', 'TOD']) { const p = R.pts.find((q) => q.ident === id); if (p) h += '<line x1="' + x(p.cum) + '" x2="' + x(p.cum) + '" y1="' + (y(p.alt) - 4) + '" y2="' + y(0) + '" stroke="' + (id === 'TOD' ? '#E0A800' : '#9AA6BF') + '" stroke-dasharray="3 3"/><text x="' + (x(p.cum) + 3) + '" y="' + (y(p.alt) - 7) + '" font-size="10" font-weight="700" fill="' + (id === 'TOD' ? '#7A5B00' : '#0A1E4A') + '">' + (id === 'TOD' ? 'T/D' : 'T/C') + '</text>'; }
  if (S.prof.length > 1) h += '<path d="' + S.prof.map((p, i) => (i ? 'L' : 'M') + x(p.d).toFixed(1) + ' ' + y(p.alt).toFixed(1)).join(' ') + '" fill="none" stroke="#0A1E4A" stroke-width="3"/>';
  if (S.ops && S.ops.t) h += '<circle cx="' + x(S.ops.along) + '" cy="' + y(S.ops.t.alt) + '" r="6" fill="#C8102E" stroke="#fff" stroke-width="2"/>';
  h += '<text x="' + x(0) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#0A1E4A">' + esc(R.pts[0].ident) + '</text><text x="' + x(R.total) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#0A1E4A">' + esc(R.pts[R.pts.length - 1].ident) + '</text>';
  svg.innerHTML = h;
}

// ---------------- panneau compact (second écran) ----------------
S.compactOn = false;
$('btnCompact').addEventListener('click', () => { if (S.compactOn) afv.compactClose(); else afv.compactOpen().then(() => setTimeout(pushCompact, 600)); });
afv.on('compact:state', (on) => { S.compactOn = on; $('btnCompact').textContent = on ? 'Fermer le panneau compact' : 'Panneau compact'; if (on) setTimeout(pushCompact, 600); });
function nextEvent() {
  const o = S.ops, ph = S.phase, R = S.route;
  if (ph == null) return { label: 'PRÊT', value: '', sub: 'Démarre le suivi dans le tracker' };
  if (ph <= 2) return { label: 'DÉPART', value: S.plan && S.plan.origin.rwy ? 'RWY ' + S.plan.origin.rwy : '', sub: S.plan ? S.plan.origin.icao + ' → ' + S.plan.destination.icao : 'Vol libre' };
  if (ph === 3 && R && o) { const toc = R.pts.find((p) => p.ident === 'TOC'); if (toc && toc.cum > o.along) return { label: 'T/C', value: fmt(toc.cum - o.along) + ' NM', sub: 'fin de montée · ' + (S.plan.cruiseAlt ? 'FL' + Math.round(S.plan.cruiseAlt / 100) : '') }; }
  if (ph <= 4 && S.lastTod && S.lastTod.distNm != null) return { label: 'T/D', value: S.lastTod.minutes != null ? fmt(S.lastTod.minutes) + ' min' : fmt(S.lastTod.distNm) + ' NM', sub: fmt(S.lastTod.distNm) + ' NM · début de descente' };
  if (ph <= 6 && o && o.remaining != null) return { label: 'ARRIVÉE', value: o.t && o.t.gs > 60 ? fmt(o.remaining / o.t.gs * 60) + ' min' : fmt(o.remaining) + ' NM', sub: S.plan ? S.plan.destination.icao + (S.plan.destination.rwy ? ' · piste ' + S.plan.destination.rwy : '') : '' };
  return { label: ph >= 8 ? 'ARRIVÉ' : 'ROULAGE', value: '', sub: ph >= 8 ? 'Bon vol terminé !' : 'vers le parking' };
}
function pushCompact() {
  if (!S.compactOn) return;
  const o = S.ops, t = o && o.t, R = S.route;
  afv.compactPush({
    callsign: (S.plan && (S.plan.callsign || S.plan.flightNumber)) || (S.flight ? 'Vol libre' : 'LAT'),
    from: S.plan ? S.plan.origin.icao : '', to: S.plan ? S.plan.destination.icao : '',
    phase: S.phase, phaseName: S.phase != null ? PHASES[S.phase] : '',
    progress: R && o && o.remaining != null ? Math.round((1 - o.remaining / R.total) * 100) : 0,
    next: nextEvent(),
    params: t ? [['ALT', t.alt >= 18000 ? 'FL' + Math.round(t.alt / 100) : fmt(t.alt)], ['IAS', fmt(t.ias)], ['GS', fmt(t.gs)], ['V/S', (t.vs > 0 ? '+' : '') + fmt(t.vs)], ['HDG', fmt(t.hdg) + '°'], ['FUEL', fmt(t.fuelKg / 1000, 1) + ' t']] : [],
    route: R ? R.pts.map((p) => [p.lat, p.lon, p.ident]) : [],
    pos: t ? [t.lat, t.lon, t.hdg] : null,
    trail: S.trail.slice(-400).map((p) => [p.lat, p.lon]),
    max: $('maxSay').textContent
  });
}

// ---------------- actualité Air France ----------------
async function loadNews(force) {
  const r = await afv.getNews(force);
  const items = (r && r.items) || [];
  const ago = (d) => { if (!d) return ''; const h = Math.round((Date.now() - d) / 3600000); return h < 1 ? 'il y a moins d’une heure' : h < 24 ? 'il y a ' + h + ' h' : new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }); };
  $('news').innerHTML = items.length ? items.map((n) => '<a class="nw" href="' + esc(n.link) + '" target="_blank" rel="noopener"><span class="t">' + esc(n.title) + '</span>' +
    (n.summary ? '<span class="muted small">' + esc(n.summary) + '</span>' : '') + '<span class="m">' + esc(n.source) + (n.date ? ' · ' + ago(n.date) : '') + '</span></a>').join('')
    : '<p class="muted">' + esc((r && r.error) || 'Pas d’actualité pour le moment.') + '</p>';
  $('newsSrc').textContent = items.length ? 'Source : ' + r.source + '. Clique sur un titre pour lire l’article sur le site d’origine.' : (r && r.detail ? 'Détail : ' + r.detail : '');
}
$('btnNews').addEventListener('click', () => loadNews(true));
loadNews(false);

// ---------------- planning du jour ----------------
S.plan2 = { cat: 'tous', data: null };
const CAT = { court: 'Court-courrier', moyen: 'Moyen-courrier', long: 'Long-courrier', 'court-moyen': 'Court / moyen', inconnu: 'Non classé' };
const hm = (min) => min == null ? '—' : Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0');
function planSimbrief(f) {
  return 'https://dispatch.simbrief.com/options/custom?' + new URLSearchParams(Object.assign({ orig: f.from, dest: f.to, airline: 'AFR', fltnum: (f.number || '').replace(/\D/g, '') }, f.type ? { type: f.type } : {})).toString();
}
async function loadPlanning(refresh) {
  if (refresh) $('planSub').textContent = 'Relevé des vols Air France en cours…';
  S.plan2.data = await afv.getPlanning(refresh);
  renderPlanning();
}
afv.on('planning:changed', (d) => { S.plan2.data = d; if ($('tab-planning').classList.contains('on')) renderPlanning(); });
function renderPlanning() {
  const d = S.plan2.data; if (!d) return;
  const all = d.flights.slice().sort((a, b) => (a.depEst || a.lastSeen) - (b.depEst || b.lastSeen));
  const count = (c) => all.filter((f) => f.cat === c).length;
  const dayTxt = new Date(d.day + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('planSub').textContent = all.length + ' vols Air France · ' + dayTxt + ' · ' + (d.source ? 'programme officiel (' + d.source.name + ', mis à jour à ' + new Date(d.source.generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ') et vols en direct' : 'vols vus en direct seulement (programme officiel pas encore disponible)');
  const cats = [['tous', 'Tous', all.length], ['court', 'Court-courrier', count('court')], ['moyen', 'Moyen-courrier', count('moyen')], ['long', 'Long-courrier', count('long')]];
  $('planCats').innerHTML = cats.map(([k, l, n]) => '<button class="tag' + (S.plan2.cat === k ? ' on' : '') + '" data-pcat="' + k + '" aria-pressed="' + (S.plan2.cat === k) + '">' + l + ' · ' + n + '</button>').join('');
  const byKey = Object.fromEntries(all.map((f) => [f.key, f]));
  const mine = d.mine.map((k) => byKey[k]).filter(Boolean);
  $('planMine').innerHTML = '<h3 class="caps">Ma journée</h3>' + (mine.length ? '<div class="mine">' + mine.map((f, i) => '<div class="am"><div class="t">' + (i + 1) + '. ' + esc(f.number || f.callsign) + ' · ' + esc(f.from) + ' → ' + esc(f.to) + '</div><div class="muted small">' + esc(f.type || 'avion inconnu') + ' · ' + hm(f.blockMin) + ' · <a href="' + esc(planSimbrief(f)) + '" target="_blank" rel="noopener">SimBrief</a> · <button class="linkbtn" data-pmine="' + esc(f.key) + '">Retirer</button></div></div>').join('') + '</div>'
    : '<p class="muted">Ajoute des vols avec l’étoile ☆ pour préparer ta journée de vols.</p>') + maxDayHtml(all, mine);
  renderRotation(all, d);
  const list = all.filter((f) => S.plan2.cat === 'tous' || f.cat === S.plan2.cat);
  $('planTable').innerHTML = list.length ? '<table class="plan-t"><thead><tr><th>Vol</th><th>Trajet</th><th>Avion</th><th>Catégorie</th><th>Départ</th><th>Arrivée</th><th>Durée</th><th>Statut</th><th></th></tr></thead><tbody>' +
    list.map((f) => '<tr><td class="n">' + esc(f.number || f.callsign) + '</td><td class="r"><b>' + esc(f.from) + ' → ' + esc(f.to) + '</b><div class="muted small">' + esc((f.fromName || '') + ' – ' + (f.toName || '')) + '</div></td>' +
      '<td>' + (f.type || f.model ? '<b>' + esc(f.model || f.type) + '</b>' + (f.reg || (f.model && f.type) ? '<div class="muted small">' + esc([f.model ? f.type : '', f.reg].filter(Boolean).join(' · ')) + '</div>' : '') : '<span class="muted">…</span>') + '</td>' +
      '<td><span class="cat ' + esc(f.cat) + '">' + esc(CAT[f.cat] || f.cat) + '</span>' + (f.distKm != null ? '<div class="muted small">' + fmt(f.distKm) + ' km</div>' : '') + '</td>' +
      '<td>' + (f.depEst ? new Date(f.depEst).toISOString().slice(11, 16) + 'Z' : '—') + (f.scheduled && !f.depEstimated ? '' : '<div class="muted small">estimé</div>') + '</td>' +
      '<td>' + (f.arrEst ? new Date(f.arrEst).toISOString().slice(11, 16) + 'Z' : '—') + '</td><td>' + hm(f.blockMin) + '</td>' +
      '<td><span class="pst ' + esc((f.status || '').replace(/\s+/g, '-').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()) + '">' + esc(f.status || '') + '</span></td>' +
      '<td><div class="row">' + (f.reg ? '<button class="btn small ghost" data-prot="' + esc(f.reg) + '" title="Tous les vols de cet avion aujourd’hui">Journée de l’avion</button>' : '') + '<a class="btn small ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(planSimbrief(f)) + '" target="_blank" rel="noopener">SimBrief</a>' +
      '<button class="star' + (d.mine.includes(f.key) ? ' on' : '') + '" data-pmine="' + esc(f.key) + '" aria-pressed="' + d.mine.includes(f.key) + '" aria-label="Ajouter à ma journée">' + (d.mine.includes(f.key) ? '★' : '☆') + '</button></div></td></tr>').join('') + '</tbody></table>'
    : '<div class="empty" style="margin:16px">Aucun vol relevé pour le moment' + (S.plan2.cat !== 'tous' ? ' dans cette catégorie' : '') + '. Clique sur Actualiser.</div>';
}
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-pcat]'); if (c) { S.plan2.cat = c.dataset.pcat; renderPlanning(); return; }
  const m = e.target.closest('[data-pmine]'); if (m) { S.plan2.data = await afv.togglePlanning(m.dataset.pmine); renderPlanning(); return; }
  const r = e.target.closest('[data-prot]'); if (r) { S.plan2.reg = r.dataset.prot; renderPlanning(); $('planRot').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (e.target.closest('[data-maxday-say]')) { if (S.plan2.maxSay) { maxStop(); maxSpeak(S.plan2.maxSay, true); } return; }
  if (e.target.closest('[data-maxday-add]')) {
    const keys = (S.plan2.maxAdd || []).filter((k) => !S.plan2.data.mine.includes(k));
    for (const k of keys) S.plan2.data = await afv.togglePlanning(k);
    renderPlanning(); return;
  }
  if (e.target.closest('[data-protclose]')) { S.plan2.reg = null; renderPlanning(); return; }
  if (e.target.closest('[data-protall]')) {
    // ajoute toute la journée de l'avion à « Ma journée », dans l'ordre des départs
    const d = S.plan2.data;
    const rot = d.flights.filter((f) => f.reg === S.plan2.reg).sort((a, b) => (a.depEst || 0) - (b.depEst || 0));
    for (const f of rot) if (!S.plan2.data.mine.includes(f.key)) S.plan2.data = await afv.togglePlanning(f.key);
    renderPlanning();
  }
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'maxDayReg') { S.plan2.myReg = e.target.value || null; S.plan2.myKey = null; renderPlanning(); }
});
$('btnPlanRefresh').addEventListener('click', () => loadPlanning(true));

// Max, rubrique « Ma journée » : avec l'avion choisi, un seul vol ou toute sa journée à respecter ?
const MAX_AVATAR = '<svg class="max-avatar" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20" fill="#0A1E4A"/><rect x="11" y="15" width="22" height="13" rx="6" fill="#fff"/><circle class="blink" cx="17" cy="21" r="2.4" fill="#0A1E4A"/><circle class="blink" cx="27" cy="21" r="2.4" fill="#0A1E4A"/><path d="M17 31 Q22 34 27 31" stroke="#C8102E" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>';
const hhZ = (ms) => ms ? new Date(ms).toISOString().slice(11, 16) + 'Z' : 'heure inconnue';
const sayTime = (ms) => ms ? (+new Date(ms).toISOString().slice(11, 13)) + ' heures ' + new Date(ms).toISOString().slice(14, 16) + ' UTC' : '';
// Journée d'un avion à partir du vol choisi (ou du prochain vol) :
// kind = 'single' (un seul vol à faire), 'rotation' (planning de l'avion à respecter), 'done' (journée finie), 'none'.
function aircraftPlan(all, reg, fromKey, now) {
  const rot = all.filter((f) => f.reg === reg && f.status !== 'Annulé').sort((a, b) => (a.depEst || 0) - (b.depEst || 0));
  if (!rot.length) return { kind: 'none', rot, todo: [], before: [] };
  const isDone = (f) => f.status === 'Arrivé' || (f.arrEst && f.arrEst < now && f.status !== 'Programmé' && f.status !== 'En vol');
  let i = fromKey ? rot.findIndex((f) => f.key === fromKey) : -1;
  if (i < 0) i = rot.findIndex((f) => !isDone(f));
  if (i < 0) return { kind: 'done', rot, todo: [], before: rot };
  const todo = rot.slice(i), before = rot.slice(0, i);
  let gap = '';
  for (let k = 1; k < rot.length; k++) if (rot[k].from !== rot[k - 1].to) { gap = rot[k - 1].to + ' → ' + rot[k].from; break; }
  return { kind: todo.length === 1 ? 'single' : 'rotation', rot, todo, before, gap, last: todo.length === 1 && rot.length > 1, left: todo.reduce((s, f) => s + (f.blockMin || 0), 0) };
}
// Texte de Max (HTML court + phrase à dire) pour un avion et un vol de départ.
function maxPlanText(p, reg, model, mineKeys) {
  const line = (f) => '<li><b>' + esc(f.number || f.callsign) + '</b> · ' + esc(f.from) + ' → ' + esc(f.to) + ' · départ ' + hhZ(f.depEst) + ' · ' + hm(f.blockMin) + (mineKeys && mineKeys.includes(f.key) ? ' <span class="pst arrive">dans ma journée</span>' : '') + '</li>';
  const who = esc(reg) + (model ? ' (' + esc(model) + ')' : '');
  if (p.kind === 'none') return { html: 'Je ne trouve aucun vol pour ' + esc(reg) + ' aujourd’hui.', say: '' };
  if (p.kind === 'done') return { html: who + ' a déjà terminé sa journée (' + p.rot.length + ' vol' + (p.rot.length > 1 ? 's' : '') + '). Choisis un autre avion.', say: reg + ' a déjà terminé sa journée. Choisis un autre avion.' };
  const f = p.todo[0];
  if (p.kind === 'single') {
    return {
      html: '<b>Un seul vol</b> avec ' + who + ' : ' + (p.last ? 'c’est le dernier vol de sa journée' : 'c’est son seul vol aujourd’hui') + ', pas de rotation à suivre.<ul class="mday">' + line(f) + '</ul>Tu fais ce vol et ta journée est terminée.',
      say: 'Avec ' + reg + ', c’est un seul vol : ' + (f.number || f.callsign) + ', de ' + f.from + ' vers ' + f.to + (f.depEst ? ', départ à ' + sayTime(f.depEst) : '') + '. Pas de rotation à suivre.'
    };
  }
  return {
    html: '<b>Tu devras respecter le planning de l’avion.</b> Après ' + esc(f.number || f.callsign) + ', ' + who + ' enchaîne encore <b>' + (p.todo.length - 1) + ' vol' + (p.todo.length > 2 ? 's' : '') + '</b> aujourd’hui. ' +
      'Fais ces ' + p.todo.length + ' vols dans l’ordre (' + hm(p.left) + ' de vol) :<ul class="mday">' + p.todo.map(line).join('') + '</ul>' +
      (p.before.length ? '<span class="muted small">Avant toi, l’avion a déjà ' + (p.before.length > 1 ? 'fait ' + p.before.length + ' vols' : 'fait 1 vol') + ' ce jour-là. </span>' : '') +
      (p.gap ? '<span class="muted small">Il manque peut-être un vol entre ' + esc(p.gap) + ' (hors de Paris, absent du programme).</span>' : ''),
    say: 'Avec ' + reg + ', tu devras respecter le planning de l’avion : ' + p.todo.length + ' vols à enchaîner. Tu pars de ' + f.from + (f.depEst ? ' à ' + sayTime(f.depEst) : '') + ', puis ' + p.todo.map((x) => x.to).join(', puis ') + '. Respecte bien l’ordre des vols.'
  };
}
function maxDayHtml(all, mine) {
  const regs = {};
  for (const f of all) if (f.reg) { const r = regs[f.reg] || (regs[f.reg] = { reg: f.reg, model: f.model || f.type || 'Type inconnu', n: 0 }); if (f.status !== 'Annulé') r.n++; }
  const list = Object.values(regs);
  if (!list.length) return '';
  // par défaut : l'avion du premier vol de « Ma journée »
  if (!S.plan2.myReg || !regs[S.plan2.myReg]) { const m = mine.find((f) => f.reg); S.plan2.myReg = m ? m.reg : null; S.plan2.myKey = m ? m.key : null; }
  const byModel = {};
  for (const r of list) (byModel[r.model] = byModel[r.model] || []).push(r);
  const opts = '<option value="">Choisis ton avion…</option>' + Object.keys(byModel).sort().map((m) => '<optgroup label="' + esc(m) + '">' +
    byModel[m].sort((a, b) => a.reg.localeCompare(b.reg)).map((r) => '<option value="' + esc(r.reg) + '"' + (r.reg === S.plan2.myReg ? ' selected' : '') + '>' + esc(r.reg) + ' · ' + r.n + ' vol' + (r.n > 1 ? 's' : '') + '</option>').join('') + '</optgroup>').join('');
  const reg = S.plan2.myReg;
  let t = { html: 'Choisis un vol dans <b>Vols réels › À venir</b> (bouton « Prendre ce vol ») ou dis-moi quel avion tu veux prendre : je te dirai si c’est un seul vol ou si tu dois suivre la journée de l’avion.', say: '' }, add = [];
  if (reg) {
    const p = aircraftPlan(all, reg, S.plan2.myKey, Date.now());
    t = maxPlanText(p, reg, regs[reg].model, mine.map((m) => m.key));
    add = p.todo.map((f) => f.key);
  }
  S.plan2.maxSay = t.say; S.plan2.maxAdd = add;
  const missing = add.filter((k) => !mine.some((m) => m.key === k)).length;
  return '<div class="maxday"><div class="max-head">' + MAX_AVATAR + '<div><div class="max-name">Max : quel avion prends-tu ?</div><div class="muted small">Un seul vol ou toute la journée de l’avion</div></div>' +
    '<select id="maxDayReg" aria-label="Avion que je veux prendre">' + opts + '</select></div>' +
    '<div class="max-say">' + t.html + '</div>' +
    (reg ? '<div class="row" style="margin-top:8px">' + (missing ? '<button class="btn small red" data-maxday-add>' + (add.length > 1 ? 'Ajouter ' + (missing === add.length ? 'les ' + missing + ' vols' : 'les ' + missing + ' vols manquants') + ' à « Ma journée »' : 'Ajouter ce vol à « Ma journée »') + '</button>' : (add.length ? '<span class="muted small">Tout est déjà dans « Ma journée ».</span>' : '')) +
      (t.say ? '<button class="btn small ghost" data-maxday-say>Écouter Max</button>' : '') + '<button class="btn small ghost" data-prot="' + esc(reg) + '">Voir la journée de l’avion</button></div>' : '') + '</div>';
}

// Journée d'un avion : tous ses vols du jour, dans l'ordre (rotation)
function renderRotation(all, d) {
  const box = $('planRot');
  if (!S.plan2.reg) { box.hidden = true; return; }
  const rot = all.filter((f) => f.reg === S.plan2.reg).sort((a, b) => (a.depEst || 0) - (b.depEst || 0));
  box.hidden = false;
  const first = rot[0] || {};
  const total = rot.reduce((a, f) => a + (f.blockMin || 0), 0);
  let warn = '';
  for (let i = 1; i < rot.length; i++) if (rot[i].from !== rot[i - 1].to) { warn = 'Il manque peut-être un vol entre ' + rot[i - 1].to + ' et ' + rot[i].from + ' (vol hors de Paris, absent du programme).'; break; }
  box.innerHTML = '<div class="row between"><h3 class="caps">Journée de l’avion ' + esc(S.plan2.reg) + (first.model || first.type ? ' · ' + esc(first.model || first.type) : '') + '</h3><button class="linkbtn" data-protclose>Fermer</button></div>' +
    (rot.length ? '<p class="muted small">' + rot.length + ' vol' + (rot.length > 1 ? 's' : '') + ' aujourd’hui · ' + hm(total) + ' de vol au total' + (warn ? ' · ' + esc(warn) : '') + '</p>' +
      '<table class="plan-t"><thead><tr><th>#</th><th>Vol</th><th>Trajet</th><th>Départ</th><th>Arrivée</th><th>Durée</th><th>Statut</th><th></th></tr></thead><tbody>' +
      rot.map((f, i) => '<tr><td>' + (i + 1) + '</td><td class="n">' + esc(f.number || f.callsign) + '</td><td class="r"><b>' + esc(f.from) + ' → ' + esc(f.to) + '</b><div class="muted small">' + esc((f.fromName || '') + ' – ' + (f.toName || '')) + '</div></td>' +
        '<td>' + (f.depEst ? new Date(f.depEst).toISOString().slice(11, 16) + 'Z' : '—') + '</td><td>' + (f.arrEst ? new Date(f.arrEst).toISOString().slice(11, 16) + 'Z' : '—') + '</td><td>' + hm(f.blockMin) + '</td>' +
        '<td><span class="pst ' + esc((f.status || '').replace(/\s+/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()) + '">' + esc(f.status || '') + '</span></td>' +
        '<td><a class="btn small ghost" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(planSimbrief(f)) + '" target="_blank" rel="noopener">SimBrief</a></td></tr>').join('') + '</tbody></table>' +
      '<div class="row" style="margin-top:10px"><button class="btn red" data-protall>Ajouter toute la journée de l’avion à « Ma journée »</button></div>'
    : '<p class="muted">Aucun autre vol connu pour cet avion aujourd’hui.</p>');
}

function renderSchedDetail() {
  const f = S.real.sched.find((x) => x.key === S.real.ssel);
  if (!f) { $('realDetail').innerHTML = '<p class="muted">Choisis un vol dans la liste.</p>'; return; }
  const kv = (k, v) => '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  $('realDetail').innerHTML = '<div class="muted small">' + esc(f.number) + ' · ' + esc(f.status || '') + '</div><h2>' + esc(f.from) + ' → ' + esc(f.to) + '</h2>' +
    '<div style="font-weight:600">' + esc((f.fromName || '') + ' – ' + (f.toName || '')) + '</div>' +
    '<div class="kv">' + kv('Départ prévu', hhZ(f.depEst)) + kv('Arrivée prévue', hhmm(f.arrEst)) + kv('Durée', hm(f.blockMin)) + kv('Distance', f.distKm != null ? fmt(f.distKm) + ' km' : '—') +
    kv('Appareil', esc(f.model || f.type || 'Inconnu')) + kv('Immatriculation', esc(f.reg || '—')) + '</div>' +
    '<div class="row wrap"><a class="btn red" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(planSimbrief(f)) + '" target="_blank" rel="noopener">Copier vers SimBrief</a>' +
    (f.reg ? '<button class="btn ghost" data-goplanreg="' + esc(f.reg) + '">Journée de l’avion</button>' : '') + '</div>' + realMaxHtml(f);
}
// Avis de Max sur un vol à venir : un seul vol, ou la suite de la journée de l'avion à respecter.
function realMaxHtml(f) {
  if (S.real.mode !== 'next' || f.status === 'Annulé') return '';
  let body;
  if (!f.reg) body = 'Je ne connais pas encore l’avion de ce vol : je ne peux pas te dire s’il enchaîne d’autres vols.';
  else {
    const p = aircraftPlan(S.real.sched, f.reg, f.key, Date.now());
    body = maxPlanText(p, f.reg, f.model || f.type, []).html;
  }
  return '<div class="maxday"><div class="max-head">' + MAX_AVATAR + '<div><div class="max-name">L’avis de Max</div><div class="muted small">Un seul vol ou la journée de l’avion ?</div></div></div>' +
    '<div class="max-say">' + body + '</div><div class="row" style="margin-top:8px"><button class="btn small red" data-takeflight="' + esc(f.key) + '">Prendre ce vol</button>' +
    '<span class="muted small">Il est ajouté à « Ma journée » dans le Planning du jour, où Max te guide.</span></div></div>';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sreal]');
  if (b) { S.real.ssel = b.dataset.sreal; renderReal(); return; }
  const tk = e.target.closest('[data-takeflight]');
  if (tk) {
    const f = S.real.sched.find((x) => x.key === tk.dataset.takeflight);
    if (f) {
      (async () => {
        const d = await afv.getPlanning(false);
        if (!d.mine.includes(f.key)) S.plan2.data = await afv.togglePlanning(f.key); else S.plan2.data = d;
        S.plan2.myReg = f.reg || null; S.plan2.myKey = f.key;
        showTab('planning'); renderPlanning();
        const box = $('planMine'); if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const t = S.plan2.maxSay; if (t && S.store && S.store.settings.maxVoice) { maxStop(); maxSpeak(t); }
      })();
    }
    return;
  }
  const g = e.target.closest('[data-goplanreg]');
  if (g) { S.plan2.reg = g.dataset.goplanreg; showTab('planning'); loadPlanning(false); }
});

// ---------------- briefing de Max (après le chargement du plan SimBrief) ----------------
// Décode un METAR en français : vent, visibilité, nuages, température, QNH.
function decodeMetar(m) {
  const r = { raw: m || '' };
  if (!m) return r;
  const w = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(m);
  if (w) { r.windTxt = (w[1] === 'VRB' ? 'variable' : 'du ' + w[1] + '°') + ' · ' + (+w[2]) + ' kt' + (w[3] ? ', rafales ' + (+w[3]) + ' kt' : ''); r.windDir = w[1] === 'VRB' ? null : +w[1]; r.windKt = +w[2]; r.gust = w[3] ? +w[3] : null; }
  if (/\bCAVOK\b/.test(m)) r.visTxt = 'CAVOK (> 10 km)';
  else { const v = /\s(\d{4})\s/.exec(m); if (v) r.visTxt = (+v[1] >= 9999 ? 'plus de 10 km' : (+v[1] >= 1000 ? (+v[1] / 1000).toLocaleString('fr-FR') + ' km' : +v[1] + ' m')); }
  const cl = [...m.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map((c) => ({ FEW: 'quelques nuages', SCT: 'nuages épars', BKN: 'nuages fragmentés', OVC: 'couvert' }[c[1]] + ' à ' + (+c[2] * 100).toLocaleString('fr-FR') + ' ft' + (c[3] ? ' (' + c[3] + ')' : '')));
  if (cl.length) r.cloudTxt = cl.join(', '); else if (/\b(NSC|SKC|CLR|NCD)\b/.test(m)) r.cloudTxt = 'pas de nuages significatifs';
  const t = /\b(M?\d{2})\/(M?\d{2})\b/.exec(m); if (t) r.temp = +t[1].replace('M', '-');
  const q = /\bQ(\d{4})\b/.exec(m); const a = /\bA(\d{4})\b/.exec(m);
  if (q) r.qnh = 'QNH ' + q[1]; else if (a) r.qnh = 'altimètre ' + a[1].slice(0, 2) + ',' + a[1].slice(2) + ' inHg';
  const wx = { RA: 'pluie', SN: 'neige', TS: 'orage', FG: 'brouillard', BR: 'brume', DZ: 'bruine', SH: 'averses', GR: 'grêle' };
  const ph = Object.keys(wx).filter((k) => new RegExp('(^|\\s)[-+]?(VC)?[A-Z]*' + k + '[A-Z]*(\\s|$)').test(m)).map((k) => wx[k]);
  if (ph.length) r.wxTxt = [...new Set(ph)].join(', ');
  return r;
}
// Composante de vent de travers et de face pour une piste (ex. « 08L » → cap 080°)
function windOnRunway(met, rwy) {
  const n = /^(\d{2})/.exec(rwy || '');
  if (!n || met.windDir == null || met.windKt == null) return '';
  const diff = (met.windDir - (+n[1] * 10)) * Math.PI / 180;
  const head = Math.round(met.windKt * Math.cos(diff)), cross = Math.abs(Math.round(met.windKt * Math.sin(diff)));
  return (head >= 0 ? 'face ' + head : 'arrière ' + (-head)) + ' kt · travers ' + cross + ' kt';
}
function showBriefing(pl, auto) {
  if (!pl) return;
  const dep = decodeMetar(pl.metarDep), arr = decodeMetar(pl.metarArr), alt = decodeMetar(pl.metarAltn);
  const li = (k, v) => v || v === 0 ? '<div class="li"><span>' + k + '</span><span>' + esc(v) + '</span></div>' : '';
  const ete = pl.eteSec ? Math.floor(pl.eteSec / 3600) + ' h ' + String(Math.round(pl.eteSec % 3600 / 60)).padStart(2, '0') : '';
  const fl = pl.cruiseAlt ? 'FL' + String(Math.round(pl.cruiseAlt / 100)).padStart(3, '0') : '';
  const t = (kg) => kg ? fmt(kg / 1000, 1) + ' t' : '';
  const steps = (pl.steps || []).map((s) => 'FL' + Math.round(s.alt / 100) + ' à ' + s.ident).join(', ');
  const wind = pl.avgWindComp ? (pl.avgWindComp > 0 ? 'vent arrière moyen ' + pl.avgWindComp + ' kt' : 'vent de face moyen ' + (-pl.avgWindComp) + ' kt') : '';
  // conseils de Max selon la météo
  const tips = [];
  if (dep.gust || arr.gust) tips.push('Rafales annoncées : garde de la marge de vitesse en approche.');
  const xw = (met, rwy) => { const w = windOnRunway(met, rwy); const c = /travers (\d+)/.exec(w); return c ? +c[1] : 0; };
  if (xw(arr, pl.destination.rwy) >= 15) tips.push('Vent de travers sensible à l’arrivée : prépare un atterrissage en crabe.');
  if ((arr.wxTxt || '').match(/orage|neige|brouillard/) || (dep.wxTxt || '').match(/orage|neige|brouillard/)) tips.push('Phénomènes météo significatifs : vérifie bien le carburant de dégagement.');
  if (dep.temp != null && dep.temp <= 3) tips.push('Températures basses au départ : pense à l’antigivrage.');
  if (!tips.length) tips.push('Météo sans difficulté particulière. Je te préviens au TOD et à chaque palier.');
  $('briefSub').textContent = (pl.callsign || pl.flightNumber || '') + ' · ' + pl.origin.icao + ' → ' + pl.destination.icao + (pl.schedOut ? ' · départ prévu ' + new Date(pl.schedOut).toISOString().slice(11, 16) + 'Z' : '');
  $('briefBody').innerHTML =
    '<div class="sec"><h4>Le vol</h4>' + li('Indicatif', pl.callsign) + li('Appareil', [pl.aircraft, pl.registration].filter(Boolean).join(' · ')) + li('Passagers', pl.pax) + li('Masse sans carburant', t(pl.zfwKg)) + li('Masse au décollage', t(pl.towKg)) + li('Cost index', pl.costIndex) + '</div>' +
    '<div class="sec"><h4>Route et carburant</h4>' + li('Croisière', fl) + li('Paliers', steps) + li('Distance', pl.distanceNm ? fmt(pl.distanceNm) + ' NM' : '') + li('Temps de vol', ete) + li('Vent en route', wind) + li('Carburant au départ', t(pl.fuelPlanKg)) + '</div>' +
    '<div class="sec"><h4>Départ · ' + esc(pl.origin.icao) + '</h4>' + li('Aéroport', pl.origin.name) + li('Piste', pl.origin.rwy) + li('Vent', dep.windTxt) + li('Sur la piste', windOnRunway(dep, pl.origin.rwy)) + li('Visibilité', dep.visTxt) + li('Nuages', dep.cloudTxt) + li('Temps présent', dep.wxTxt) + li('Température', dep.temp != null ? dep.temp + ' °C' : '') + li('Pression', dep.qnh) + '</div>' +
    '<div class="sec"><h4>Arrivée · ' + esc(pl.destination.icao) + '</h4>' + li('Aéroport', pl.destination.name) + li('Piste', pl.destination.rwy) + li('Vent', arr.windTxt) + li('Sur la piste', windOnRunway(arr, pl.destination.rwy)) + li('Visibilité', arr.visTxt) + li('Nuages', arr.cloudTxt) + li('Temps présent', arr.wxTxt) + li('Température', arr.temp != null ? arr.temp + ' °C' : '') + li('Pression', arr.qnh) + '</div>' +
    (pl.alternate && pl.alternate.icao ? '<div class="sec full"><h4>Dégagement · ' + esc(pl.alternate.icao) + '</h4>' + li('Aéroport', pl.alternate.name) + li('Météo', [alt.windTxt, alt.visTxt, alt.cloudTxt].filter(Boolean).join(' · ')) + '</div>' : '') +
    '<div class="sec full"><h4>Le conseil de Max</h4><div class="say">' + tips.map(esc).join('<br>') + '</div></div>';
  // texte lu par Max
  const say = ['Briefing du vol ' + (pl.callsign || '') + ', de ' + (pl.origin.name || pl.origin.icao) + ' vers ' + (pl.destination.name || pl.destination.icao) + '.'];
  if (pl.origin.rwy) say.push('Départ piste ' + pl.origin.rwy + (dep.windTxt ? ', vent ' + dep.windTxt.replace('du ', 'du ').replace(' · ', ' pour ') : '') + (dep.qnh ? ', ' + dep.qnh : '') + '.');
  if (fl) say.push('Croisière ' + fl + (ete ? ', ' + ete.replace(' h ', ' heure ').replace(/ 0(\d)$/, ' $1') + ' minutes de vol' : '') + '.');
  if (steps) say.push('Paliers prévus : ' + steps + '.');
  if (pl.destination.rwy) say.push('Arrivée piste ' + pl.destination.rwy + (arr.windTxt ? ', vent ' + arr.windTxt.replace(' · ', ' pour ') : '') + (arr.qnh ? ', ' + arr.qnh : '') + '.');
  if (pl.alternate && pl.alternate.icao) say.push('Dégagement ' + (pl.alternate.name || pl.alternate.icao) + '.');
  if (pl.fuelPlanKg) say.push('Carburant au départ ' + fmt(pl.fuelPlanKg / 1000, 1) + ' tonnes.');
  say.push(tips[0] + ' Bon vol commandant !');
  S.briefSay = say.join(' ').replace(/kt/g, 'nœuds').replace(/°/g, ' degrés');
  $('briefModal').hidden = false;
  $('btnBriefing').hidden = false;
  $('maxSay').textContent = 'Briefing prêt : ' + pl.origin.icao + ' → ' + pl.destination.icao + (fl ? ', ' + fl : '') + '. ' + tips[0];
  if (auto) { maxQueue.length = 0; maxSpeak(S.briefSay); }
}
$('btnBriefClose').addEventListener('click', () => { $('briefModal').hidden = true; });
$('btnBriefListen').addEventListener('click', () => { if (S.briefSay) { maxStop(); maxSpeak(S.briefSay, true); } });
$('btnBriefing').addEventListener('click', () => showBriefing(S.plan, false));

// ---------------- menu latéral ----------------
const sideStore = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* rien */ } } };
function setMini(on) {
  $('side').classList.toggle('mini', on);
  $('btnSide').title = on ? 'Agrandir le menu' : 'Réduire le menu';
  $('btnSide').setAttribute('aria-label', $('btnSide').title);
  sideStore.set('afv.sideMini', on ? '1' : '0');
}
setMini(sideStore.get('afv.sideMini') === '1');
$('btnSide').addEventListener('click', () => setMini(!$('side').classList.contains('mini')));
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const searchable = () => [...document.querySelectorAll('.nscroll .nav')];
function navFilter() {
  const q = norm($('navSearch').value.trim());
  $('side').classList.toggle('searching', !!q);
  for (const b of document.querySelectorAll('.nscroll .nav')) b.classList.toggle('hide', !!q && !norm(b.title).includes(q));
  for (const h of document.querySelectorAll('.nscroll .nsec')) {
    let n = h.nextElementSibling, any = false;
    while (n && !n.classList.contains('nsec')) { if (!n.classList.contains('hide') && (q || !n.classList.contains('searchonly'))) any = true; n = n.nextElementSibling; }
    h.hidden = !!q && !any;
  }
}
$('navSearch').addEventListener('input', navFilter);
$('navSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('navSearch').value = ''; navFilter(); $('navSearch').blur(); }
  if (e.key === 'Enter') {
    const q = norm($('navSearch').value.trim()); if (!q) return;
    const b = searchable().find((x) => !x.disabled && norm(x.title).includes(q));
    if (b) { b.click(); $('navSearch').value = ''; navFilter(); $('navSearch').blur(); }
  }
});
document.querySelector('.nsearch').addEventListener('click', () => { if ($('side').classList.contains('mini')) { setMini(false); $('navSearch').focus(); } });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('side').classList.contains('mini')) setMini(false); $('navSearch').focus(); $('navSearch').select(); }
});
$('btnGoFly').addEventListener('click', () => showTab('vol'));
$('navBrief').addEventListener('click', () => { if (S.plan) showBriefing(S.plan, false); });
$('liveCard').addEventListener('click', () => showTab('vol'));
const sideCache = {};
const setTxt = (id, v) => { if (sideCache[id] !== v) { sideCache[id] = v; $(id).textContent = v; } };
function sideRefresh() {
  const flying = !!S.flight;
  $('chipFly').hidden = !flying; $('chipBeta').hidden = flying;
  $('btnGoFly').classList.toggle('live', flying);
  setTxt('goFlyText', flying ? 'Revenir à mon vol' : 'Démarrer un vol');
  $('navBrief').disabled = !S.plan;
  $('navBrief').title = S.plan ? 'Briefing de Max' : 'Briefing de Max (charge d’abord ton plan SimBrief)';
  const acc = S.career ? S.career.missions.filter((m) => m.accepted).length : 0;
  $('chipMis').hidden = !acc; setTxt('chipMis', String(acc));
  // vol en cours
  $('liveCard').hidden = !flying;
  if (flying) {
    const pl = S.plan, t = S.lastT, ph = S.phase;
    setTxt('lcCs', (pl && (pl.callsign || pl.flightNumber)) || 'Vol libre');
    setTxt('lcRt', pl ? pl.origin.icao + ' → ' + pl.destination.icao : (S.flight.aircraft || ''));
    const ne = nextEvent();
    setTxt('lcNext', ne.value ? (/^T\//.test(ne.label) ? ne.label + ' ' : '') + ne.value : '');
    const bars = PHASES.map((_, i) => '<i class="' + (ph == null ? '' : i < ph ? 'd' : i === ph ? 'c' : '') + '"></i>').join('');
    if (sideCache.bars !== bars) { sideCache.bars = bars; $('lcBar').innerHTML = bars; }
    const alt = t ? (t.alt >= 18000 ? 'FL' + Math.round(t.alt / 100) : fmt(Math.round(t.alt / 10) * 10) + ' ft') : '';
    setTxt('lcPh', (ph != null ? PHASES[ph] : 'Prêt') + (alt ? ' · ' + alt : ''));
    setTxt('lcEta', S.ops && S.ops.eta ? 'ETA ' + utc(S.ops.eta) : '');
  }
  // pilote
  const name = (S.store && S.store.settings.pilot) || 'Pilote';
  setTxt('pName', name);
  setTxt('pInit', name === 'Pilote' ? 'AF' : name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  const c = S.career;
  if (c) {
    setTxt('pGrade', c.gradeName + ' · ' + fmtH(c.hours));
    const prevH = [0, 100, 250, 600, 1200][c.grade] || 0;
    const pct = c.next ? Math.max(2, Math.min(100, Math.round(((c.hours - prevH) / (c.nextHours - prevH)) * 100))) : 100;
    $('pRing').style.setProperty('--p', pct + '%');
    $('pRing').title = c.next ? pct + ' % vers ' + c.next : 'Plus haut grade atteint';
  }
}
setInterval(sideRefresh, 1000);
sideRefresh();

// ---------------- icône près de l'horloge et Discord ----------------
afv.on('settings:changed', (st) => { if (S.store) { S.store.settings = st; renderSettings(); } });
afv.on('tray:go', (g) => {
  if (g.tab) showTab(g.tab);
  if (g.action === 'briefing' && S.plan) showBriefing(S.plan, false);
  if (g.action === 'compact') $('btnCompact').click();
});
let trayLast = '';
function trayPush() {
  const pl = S.plan, t = S.lastT, c = S.career;
  if (S.flight && !S.flightStartedAt) S.flightStartedAt = Date.now();
  if (!S.flight) S.flightStartedAt = 0;
  const st = {
    flying: !!S.flight,
    callsign: S.flight ? ((pl && (pl.callsign || pl.flightNumber)) || 'Vol libre') : '',
    route: S.flight && pl ? pl.origin.icao + ' → ' + pl.destination.icao : '',
    phase: S.flight && S.phase != null ? PHASES[S.phase] : '',
    alt: S.flight && t && !t.onGround ? (t.alt >= 18000 ? 'FL' + Math.round(t.alt / 1000) * 10 : Math.round(t.alt / 500) * 500 + ' ft') : '',
    aircraft: S.flight ? ((S.flight.aircraft) || (pl && pl.aircraft) || '') : '',
    // temps de vol : depuis le décollage, sinon depuis le départ du parking, sinon depuis le début du suivi
    startedAt: S.flight ? ((S.oooi && (S.oooi.off || S.oooi.out)) || S.flightStartedAt || 0) : 0,
    remaining: S.flight && S.ops && S.ops.eta && S.phase != null && S.phase < 8 ? (() => { const m = Math.max(0, Math.round((S.ops.eta - Date.now()) / 60000)); return 'reste ' + (m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : m + ' min'); })() : '',
    grade: c ? c.gradeName : '',
    plan: !!S.plan, compact: !!S.compactOn
  };
  const k = JSON.stringify(st);
  if (k !== trayLast) { trayLast = k; afv.trayStatus(st); }
}
setInterval(trayPush, 2000);

// ---------------- chat des pilotes ----------------
const CH = { status: null, msgs: [], unread: 0, rules: '', lastAt: 0 };
const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const chatOpen = () => $('tab-chat').classList.contains('on');
function chatTime(d) { return new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function chatDay(d) {
  const x = new Date(d), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(x, t)) return 'Aujourd’hui';
  const y = new Date(t); y.setDate(t.getDate() - 1);
  return same(x, y) ? 'Hier' : x.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function chatMsgHtml(m, prev) {
  const me = CH.status && CH.status.me;
  const mine = me && m.user_id === me.id;
  const cont = prev && prev.user_id === m.user_id && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60000 && chatDay(prev.created_at) === chatDay(m.created_at);
  let acts = '';
  if (!mine) acts += '<button data-crep="' + m.id + '" title="Signaler ce message à la direction">Signaler</button>';
  if (me && me.admin) { acts += '<button data-chide="' + m.id + '">Supprimer</button>'; if (!mine && !m.admin) acts += '<button data-cban="' + esc(m.user_id) + '" data-cbn="' + esc(m.pseudo) + '">Exclure</button>'; }
  return '<div class="cm' + (mine ? ' me' : '') + (cont ? ' cont' : '') + '" data-cid="' + m.id + '"><div class="cav' + (m.admin ? ' adm' : '') + '" aria-hidden="true">' + esc(initials(m.pseudo)) + '</div><div class="cbody">' +
    (cont ? '' : '<div class="chead"><b>' + esc(m.pseudo) + '</b>' + (m.admin ? '<span class="badge-dir">DIRECTION</span>' : '') + (m.grade ? '<span class="g">' + esc(m.grade) + '</span>' : '') + (m.flight ? '<span class="ftag">✈ ' + esc(m.flight) + '</span>' : '') + '<span class="t">' + chatTime(m.created_at) + '</span></div>') +
    '<div class="ctext">' + esc(m.body) + '</div></div>' + (acts ? '<div class="cact">' + acts + '</div>' : '') + '</div>';
}
function renderChatList(keepScroll) {
  const box = $('chatList');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let h = '', prev = null, day = '';
  for (const m of CH.msgs) {
    const d = chatDay(m.created_at);
    if (d !== day) { h += '<div class="cday">' + esc(d) + '</div>'; day = d; prev = null; }
    h += chatMsgHtml(m, prev); prev = m;
  }
  box.innerHTML = h || (CH.status && CH.status.state === 'ready' ? '<p class="muted" style="text-align:center;margin-top:40px">Aucun message pour le moment. Lance la conversation !</p>' : '');
  if (!keepScroll || atBottom) box.scrollTop = box.scrollHeight;
}
function renderChatStatus() {
  const st = CH.status || { state: 'off' };
  const me = st.me;
  const box = $('chatState');
  let h = '';
  if (!st.configured) h = 'Le chat entre pilotes arrive bientôt : la direction est en train de l’ouvrir.';
  else if (st.state === 'nopseudo') h = '<b>Choisis ton nom de pilote</b> : c’est lui qui s’affichera dans le chat.<div class="row"><input id="chatPseudo" maxlength="32" placeholder="Ex. : Cdt Martin" style="height:36px;border:1px solid var(--line);border-radius:8px;padding:0 10px"><button class="btn small red" id="chatPseudoOk">Rejoindre le chat</button></div>';
  else if (st.state === 'connecting') h = 'Connexion au chat…';
  else if (st.state === 'error') h = esc(st.error) + '<div class="row"><button class="btn small ghost" id="chatRetry">Réessayer</button></div>';
  else if (st.state === 'idle' && S.store && S.store.settings.chat === false) h = 'Le chat est désactivé dans tes Réglages.';
  else if (st.state === 'idle') h = '<div class="row"><button class="btn small red" id="chatRetry">Se connecter au chat</button></div>';
  if (me && me.banned) h = 'La direction t’a exclu du chat : tu peux lire les messages mais plus en écrire.';
  box.innerHTML = h; box.hidden = !h;
  const can = st.state === 'ready' && !(me && me.banned);
  $('chatInput').disabled = !can; $('chatBtn').disabled = !can;
  const on = st.online || [];
  $('chatOnlineN').textContent = st.state === 'ready' ? '· ' + on.length : '';
  $('chatSub').textContent = 'Tous les pilotes qui ont le tracker' + (st.state === 'ready' ? ' · ' + on.length + ' en ligne' + (on.filter((x) => x.flight).length ? ' dont ' + on.filter((x) => x.flight).length + ' en vol' : '') : '');
  $('chatOnline').innerHTML = on.length ? on.map((p) => '<div class="co"><div class="cav' + (p.admin ? ' adm' : '') + '" aria-hidden="true">' + esc(initials(p.pseudo)) + '</div><div><div class="n">' + esc(p.pseudo) + (me && p.id === me.id ? ' (toi)' : '') + '</div><div class="s">' + esc(p.flight ? '✈ ' + p.flight : (p.grade || 'Au sol')) + '</div></div><span class="dot" aria-label="en ligne"></span></div>').join('') : '<p class="muted small">' + (st.state === 'ready' ? 'Personne pour le moment.' : '—') + '</p>';
  $('chatAdmin').hidden = !(me && me.admin);
}
function chatBadge() { $('chipChat').hidden = !CH.unread; $('chipChat').textContent = CH.unread > 9 ? '9+' : String(CH.unread); }
async function chatLoad() {
  const d = await afv.chatGet();
  CH.status = d.status; CH.msgs = d.messages; CH.rules = d.rules;
  $('chatRules').textContent = d.rules || ''; $('chatRules').hidden = !d.rules;
  renderChatStatus(); renderChatList();
}
afv.on('chat:status', (st) => { const was = CH.status && CH.status.me && CH.status.me.admin; CH.status = st; renderChatStatus(); if (st.me && st.me.admin !== was) renderChatList(true); });
afv.on('chat:history', (list) => { CH.msgs = list; renderChatList(); });
afv.on('chat:message', (m) => {
  if (CH.msgs.some((x) => x.id === m.id)) return;
  CH.msgs.push(m); if (CH.msgs.length > 300) CH.msgs.shift();
  renderChatList(true);
  const me = CH.status && CH.status.me;
  if (!(me && m.user_id === me.id) && !(chatOpen() && document.hasFocus())) { CH.unread++; chatBadge(); }
});
afv.on('chat:removed', (id) => { CH.msgs = CH.msgs.filter((m) => m.id !== id); renderChatList(true); });
document.querySelector('[data-tab=chat]').addEventListener('click', () => { CH.unread = 0; chatBadge(); if (CH.status && CH.status.state !== 'ready') afv.chatStart(); setTimeout(() => { $('chatList').scrollTop = $('chatList').scrollHeight; $('chatInput').focus(); }, 50); });
window.addEventListener('focus', () => { if (chatOpen()) { CH.unread = 0; chatBadge(); } });
$('chatInput').addEventListener('input', () => { $('chatCount').textContent = $('chatInput').value.length + ' / 500'; });
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });
$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('chatInput').value.trim(); if (!t) return;
  $('chatBtn').disabled = true; $('chatErr').textContent = '';
  const r = await afv.chatSend(t);
  $('chatBtn').disabled = false;
  if (r.ok) { $('chatInput').value = ''; $('chatCount').textContent = '0 / 500'; $('chatList').scrollTop = $('chatList').scrollHeight; }
  else $('chatErr').textContent = r.error;
  $('chatInput').focus();
});
document.addEventListener('click', async (e) => {
  if (e.target.closest('#chatRetry')) { afv.chatStart(); return; }
  if (e.target.closest('#chatPseudoOk')) {
    const v = ($('chatPseudo').value || '').trim();
    if (v.length < 2) { $('chatErr').textContent = 'Ton nom de pilote doit faire au moins 2 caractères.'; return; }
    S.store.settings = await afv.setSettings({ pilot: v }); renderSettings(); afv.chatStart(); return;
  }
  const rp = e.target.closest('[data-crep]');
  if (rp) { const r = await afv.chatReport(rp.dataset.crep, ''); $('chatErr').textContent = r.ok ? 'Merci, la direction a été prévenue.' : r.error; return; }
  const hd = e.target.closest('[data-chide]');
  if (hd) { const r = await afv.chatHide(hd.dataset.chide); if (!r.ok) $('chatErr').textContent = r.error; else loadChatReports(); return; }
  const bn = e.target.closest('[data-cban]');
  if (bn) {
    if (!window.confirm('Exclure ' + bn.dataset.cbn + ' du chat ? Ses messages des dernières 24 h seront aussi supprimés.')) return;
    const r = await afv.chatBan(bn.dataset.cban); $('chatErr').textContent = r.ok ? bn.dataset.cbn + ' est exclu du chat.' : r.error; if (r.ok) loadChatReports(); return;
  }
});
async function loadChatReports() {
  const list = await afv.chatReports();
  $('chatReports').innerHTML = list.length ? list.map((r) => { const m = r.messages || {}; return '<div class="crep"><b>' + esc(m.pseudo || '?') + '</b> : « ' + esc(String(m.body || '').slice(0, 140)) + ' »' + (m.deleted ? ' <span class="muted">(supprimé)</span>' : '') +
    (!m.deleted && m.id ? '<div class="row"><button class="btn small ghost" data-chide="' + m.id + '">Supprimer</button>' + (m.user_id ? '<button class="btn small ghost" data-cban="' + esc(m.user_id) + '" data-cbn="' + esc(m.pseudo || '') + '">Exclure</button>' : '') + '</div>' : '') + '</div>'; }).join('') : 'Aucun signalement.';
}
$('chatReportsBtn').addEventListener('click', loadChatReports);
chatLoad();

// ---------------- livrées de la compagnie ----------------
const LV = { data: null };
const mo = (n) => (n ? (n / 1048576).toFixed(0) + ' Mo' : '');
async function loadLiveries(force) {
  try { LV.data = await afv.listLiveries(force); } catch (e) { LV.data = { community: null, livrees: [], error: String(e.message || e) }; }
  renderLiveries();
}
function renderLiveries() {
  const d = LV.data;
  if (!d) return;
  $('livCom').textContent = d.community ? d.community + (d.communityAuto ? ' (trouvé automatiquement)' : '') : 'Introuvable : clique sur « Changer » et choisis le dossier Community de MSFS 2024.';
  $('btnLivAuto').hidden = !d.community || d.communityAuto;
  $('btnLivOpen').disabled = !d.community;
  const upd = d.livrees.filter((l) => l.outdated).length;
  $('chipLiv').hidden = !upd; $('chipLiv').textContent = upd ? 'MAJ' : '';
  if (!d.livrees.length) { $('livList').innerHTML = '<div class="empty">Aucune livrée disponible pour le moment.</div>'; return; }
  $('livList').innerHTML = d.livrees.map((l) => {
    const j = l.job || {};
    const busy = j.state === 'download' || j.state === 'extract';
    let state = '<span class="badge">' + (l.outdated ? 'Mise à jour disponible' : 'Installée') + '</span>';
    if (!l.installed) state = '<span class="badge red">Non installée</span>';
    if (l.outdated) state = '<span class="badge red">Mise à jour disponible</span>';
    let acts = '';
    if (busy) {
      const lab = j.state === 'download' ? 'Téléchargement… ' + (j.percent || 0) + ' %' + (j.total ? ' · ' + mo(j.got) + ' / ' + mo(j.total) : '') : 'Installation… ' + (j.percent || 0) + ' %';
      acts = '<div style="flex:1"><div class="muted small">' + esc(lab) + '</div><div class="progress"><i style="width:' + (j.percent || 0) + '%"></i></div></div>';
    } else {
      if (!l.installed) acts += '<button class="btn red" data-inst="' + esc(l.id) + '"' + (d.community ? '' : ' disabled') + '>Installer</button>';
      else if (l.outdated) acts += '<button class="btn red" data-inst="' + esc(l.id) + '">Mettre à jour</button>';
      else acts += '<button class="btn small ghost" data-inst="' + esc(l.id) + '">Réinstaller</button>';
      if (l.installed && !l.manual) acts += '<button class="btn small ghost" data-rem="' + esc(l.id) + '">Désinstaller</button>';
    }
    const msg = j.state === 'error' ? '<div class="err">' + esc(j.error) + '</div>' : (j.state === 'done' ? '<div class="muted small">Installée ! Redémarre MSFS 2024 pour la voir dans la sélection de l’avion.</div>' : '');
    const manual = l.manual ? '<div class="muted small">Déjà présente dans ton dossier Community (installée à la main).</div>' : '';
    return '<div class="liv">' + (l.image ? '<img src="' + esc(l.image) + '" alt="Aperçu de la livrée ' + esc(l.name) + '">' : '') +
      '<div class="in"><div class="row between"><span class="nm">' + esc(l.name) + '</span>' + state + '</div>' +
      '<div class="tags">' + [l.aircraft, l.engine, l.reg, l.version ? 'v' + l.version : ''].filter(Boolean).map((t) => '<span class="tg">' + esc(t) + '</span>').join('') + '</div>' +
      (l.description ? '<div class="muted">' + esc(l.description) + '</div>' : '') +
      (l.requires ? '<div class="muted small">Nécessite : ' + esc(l.requires) + '</div>' : '') +
      manual + '<div class="acts">' + acts + '</div>' + msg + '</div></div>';
  }).join('');
}
$('livList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.inst) { b.disabled = true; await afv.installLivery(b.dataset.inst); }
  if (b.dataset.rem) {
    if (!window.confirm('Désinstaller cette livrée ? Elle sera retirée de ton dossier Community.')) return;
    try { await afv.removeLivery(b.dataset.rem); } catch (e) { window.alert(String(e.message || e)); }
    loadLiveries(false);
  }
});
afv.on('livrees:job', ({ id, job }) => {
  if (!LV.data) return;
  const l = LV.data.livrees.find((x) => x.id === id);
  if (!l) return;
  l.job = job;
  if (job.state === 'done' || job.state === 'error') { loadLiveries(false).then(() => { const x = LV.data.livrees.find((y) => y.id === id); if (x) { x.job = job; renderLiveries(); } }); return; }
  renderLiveries();
});
$('btnLivRefresh').addEventListener('click', () => loadLiveries(true));
$('btnLivPick').addEventListener('click', async () => { const r = await afv.pickCommunity(); if (r) { LV.data = r; renderLiveries(); } });
$('btnLivAuto').addEventListener('click', async () => { LV.data = await afv.resetCommunity(); renderLiveries(); });
$('btnLivOpen').addEventListener('click', () => afv.openCommunity());
setTimeout(() => loadLiveries(false), 4000); // pastille « MAJ » si une nouvelle version de livrée est sortie

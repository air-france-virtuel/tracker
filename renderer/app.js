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
  if (name === 'vol') renderDayNext(true);
  if (name === 'livrees') loadLiveries(false);
  if (name === 'ligne') loadLive();
  if (name === 'hgc') loadHangar(true);
  if (name === 'sons') loadUa();
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
      if (S.ua && S.ua.running) {
        // pas de doublon : Universal Announcer joue déjà les annonces cabine
        $('annNow').innerHTML += '<div class="muted small">Son joué par Universal Announcer</div>';
        await new Promise((r) => setTimeout(r, 6000));
      } else {
        const f = await afv.uaFile(item.key, S.plan && S.plan.aircraft).catch(() => null);
        if (f) await playFile(f); // son du dossier Universal Announcer (LAT, sinon Default) ; sinon texte seulement
      }
      $('annNow').textContent = 'Dernière annonce : ' + item.title;
    }
  }
  playing = false;
}
function maxSays(text) {
  $('maxSay').textContent = text;
  S.maxHist = (S.maxHist || []).concat([{ time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), text }]).slice(-4);
  maxSpeak(text);
  pushMax();
}
// ---------------- Max par-dessus le simulateur : check-list de chaque phase et infos du vol ----------------
S.maxWin = false; S.ck = null;
function pushMax() {
  if (!S.maxWin) return;
  const pl = S.plan;
  afv.maxPush({
    route: S.flight ? ((pl && pl.callsign) || 'Vol libre') + (pl ? ' · ' + pl.origin.icao + ' → ' + pl.destination.icao : '') : '',
    phaseName: S.flight && S.phase != null ? PHASES[S.phase] : '',
    msg: $('maxSay').textContent, hist: (S.maxHist || []).slice(0, -1).reverse(), muted: !!S.maxMuted,
    ck: S.ck ? { title: S.ck.title, complete: S.ck.complete, items: S.ck.items.map((i) => ({ id: i.id, text: i.text, done: i.done, by: i.by })) } : null
  });
}
function ckContext(t) { return { t, plan: S.plan, fuelPlanKg: S.plan && S.plan.fuelPlanKg }; }
function startChecklist(phase) {
  S.ck = Checklists.create(phase);
  if (S.lastT) Checklists.update(S.ck, ckContext(S.lastT));
  S.ckDoneSaid = S.ck.complete;
  // Max lit la check-list juste après son conseil de phase
  // pendant la course au décollage et le freinage, un copilote ne lit pas de check-list : il fait les annonces
  if (phase !== 2 && phase !== 7) setTimeout(() => { if (S.flight && S.ck && S.ck.phase === phase && !S.ck.complete) { const a = Checklists.announce(S.ck); $('maxSay').textContent = a; S.maxHist = (S.maxHist || []).concat([{ time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), text: a }]).slice(-4); maxSpeak(a); pushMax(); } }, 2500);
  pushMax();
}
// Annonces de copilote (cent nœuds, vario positif, transition, mille pieds avant le niveau, 2 500 / 1 000 / 500 / minimums…) :
// elles passent avant tout le reste, comme dans un vrai cockpit.
function tickCallouts(t) {
  if (!S.co) return;
  for (const c of Callouts.update(S.co, t, S.phase, S.plan)) { maxStop(); maxSays(c); }
}
function tickChecklist(t) {
  if (!S.ck) return;
  const newly = Checklists.update(S.ck, ckContext(t));
  if (S.ck.complete && !S.ckDoneSaid) { S.ckDoneSaid = true; maxSays('Check-list ' + S.ck.say + ' terminée.'); return; }
  if (newly.length) pushMax();
}
// Infos de Max pendant le vol (en plus du TOD, des paliers et des alertes)
function flightInfos(t, d) {
  const I = S.infos = S.infos || {};
  if (!S.flight || t.onGround) { I.lastAlt = t.alt; return; }
  const prev = I.lastAlt; I.lastAlt = t.alt;
  const o = S.ops, R = S.route;
  if (o && R && R.total > 150 && o.remaining != null && !I.half && o.remaining < R.total / 2 && S.phase >= 3) {
    I.half = true;
    const min = t.gs > 100 ? Math.round(o.remaining / t.gs * 60) : null;
    const dur = min == null ? '' : min >= 60 ? Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') : min + ' minutes';
    maxSays('Mi-parcours : il reste ' + fmt(o.remaining) + ' nautiques' + (dur ? ', arrivée dans environ ' + dur : '') + '.');
  }
  if (o && o.fuelPlan != null && !I.fuelLow && S.phase >= 3 && t.fuelKg < o.fuelPlan - 1500) {
    I.fuelLow = true;
    maxSays('Attention, carburant : ' + fmt((o.fuelPlan - t.fuelKg) / 1000, 1) + ' tonne de moins que prévu. Vérifie la consommation.');
  }
  if (o && o.remaining != null && !I.arr50 && S.phase >= 5 && o.remaining < 50) { I.arr50 = true; maxSays('Plus que 50 nautiques avant ' + (S.plan ? S.plan.destination.icao : 'l’arrivée') + '. Prépare l’approche et la ' + rwy('destination') + '.'); }
}
async function openMax() { await afv.maxOpen(); }
afv.on('max:state', (on) => { S.maxWin = !!on; $('btnMaxOverlay').textContent = on ? 'Fermer Max par-dessus le simu' : 'Max par-dessus le simu'; if (on) pushMax(); });
afv.on('max:action', (a) => {
  if (a.type === 'ready') pushMax();
  else if (a.type === 'check' && S.ck) { Checklists.toggle(S.ck, a.id); if (S.ck.complete && !S.ckDoneSaid) { S.ckDoneSaid = true; maxSays('Check-list ' + S.ck.say + ' terminée.'); } else pushMax(); }
  else if (a.type === 'mute') $('btnMaxMute').click();
});

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
// Profil de vitesses SimBrief « 250/300/78 » → « 250 nœuds, puis 300 nœuds, puis Mach 0,78 »
function sayProfile(p) {
  const raw = String(p || '').trim();
  const parts = raw.split('/').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || parts.some((x) => !/^(\.\d+|\d+)$/.test(x))) return raw;
  return parts.map((x) => x.startsWith('.') ? 'Mach 0,' + x.slice(1) : +x < 100 ? 'Mach 0,' + x : x + ' nœuds').join(', puis ');
}
// Ce que dit Max à chaque phase : uniquement ce qui vient du plan SimBrief (pistes, SID, STAR, niveaux, profils, carburant)
function adviceFor(p) {
  const pl = S.plan;
  const dep = pl ? pl.origin.icao : 'le départ';
  const arr = pl ? pl.destination.icao : 'l’arrivée';
  const fl = pl && pl.cruiseAlt ? 'FL' + Math.round(pl.cruiseAlt / 100) : 'ton niveau de croisière';
  const steps = pl && pl.steps && pl.steps.length ? ' Paliers prévus : ' + pl.steps.map((s) => 'FL' + Math.round(s.alt / 1000) * 10 + ' à ' + s.ident).join(', ') + '.' : '';
  const wDep = pl ? windOf(pl.metarDep) : '';
  const wArr = pl ? windOf(pl.metarArr) : '';
  const ft = (n) => n >= 10000 ? 'FL' + Math.round(n / 100) : fmt(n) + ' pieds';
  if (!pl) {
    return ['Embarquement. Sans plan SimBrief, je ne peux pas te donner les infos du vol.', 'Roulage.', 'Décollage.', 'Montée.', 'Croisière.', 'Descente.', 'Approche.', 'Atterrissage.', 'Au parking : ton rapport de vol est enregistré.'][p] || 'Prêt quand tu l’es.';
  }
  switch (p) {
    case 0: return 'Embarquement à ' + dep + '. Départ ' + rwy('origin') + (pl.sid ? ', SID ' + pl.sid : '') + (wDep ? ', ' + wDep : '') + '.' +
      (pl.fuelPlanKg ? ' Carburant prévu : ' + fmt(pl.fuelPlanKg / 1000, 1) + ' tonnes.' : '') + (pl.zfwKg ? ' Masse sans carburant : ' + fmt(pl.zfwKg / 1000, 1) + ' tonnes.' : '');
    case 1: return 'Roulage vers la ' + rwy('origin') + (pl.sid ? ', départ ' + pl.sid : '') + '.';
    case 2: return 'Décollage ' + rwy('origin') + (pl.sid ? ', SID ' + pl.sid : '') + '. Montée initiale vers ' + fl + '.';
    case 3: return 'Montée vers ' + fl + '.' + (pl.climbProfile ? ' Profil de montée : ' + sayProfile(pl.climbProfile) + '.' : '') +
      (pl.transAlt ? ' Altitude de transition à ' + dep + ' : ' + ft(pl.transAlt) + ', passe en standard.' : '') + steps;
    case 4: return 'Croisière à ' + fl + (pl.cruiseProfile ? ', ' + pl.cruiseProfile.replace(/^CI\s*/i, 'cost index ') : '') + '.' + (pl.tod ? ' Je te préviens 10 minutes avant le TOD.' : '');
    case 5: return 'Descente vers ' + arr + (pl.star ? ', STAR ' + pl.star : '') + ', ' + rwy('destination') + (wArr ? ', ' + wArr : '') + '.' +
      (pl.descentProfile ? ' Profil de descente : ' + sayProfile(pl.descentProfile) + '.' : '') + (pl.transLevel ? ' Niveau de transition à ' + arr + ' : ' + ft(pl.transLevel) + ', passe au QNH.' : '');
    case 6: return 'Approche ' + rwy('destination') + ' à ' + arr + '.' + (pl.alternate && pl.alternate.icao ? ' Dégagement prévu : ' + pl.alternate.icao + '.' : '');
    case 7: return 'Atterrissage ' + rwy('destination') + ' à ' + arr + '.';
    case 8: return 'Au parking à ' + arr + ' : ton rapport de vol est enregistré.';
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
S.layers = { vol: { sat: false, radar: false }, reels: { sat: false, radar: false }, ligne: { sat: false, radar: false } };
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
  let box = S.mapMode === 'avion' && t ? [{ lat: t.lat - 2.2, lon: t.lon - 2.2 }, { lat: t.lat + 2.2, lon: t.lon + 2.2 }] : (pts.length ? pts.concat(S.trail) : [{ lat: t.lat - 2.2, lon: t.lon - 2.2 }, { lat: t.lat + 2.2, lon: t.lon + 2.2 }]);
  const xs = box.map((p) => MapLayers.LX(p.lon)), ys = box.map((p) => MapLayers.LY(p.lat));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let sc = Math.min(540 / Math.max(0.3, x1 - x0), 240 / Math.max(0.3, y1 - y0));
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // vue libre : le pilote a déplacé ou zoomé la carte (molette, glisser, boutons + / −)
  if (S.mapMode === 'libre' && S.mapView) ({ cx, cy, sc } = S.mapView);
  S.mapCur = { cx, cy, sc };
  const ox = 300 - cx * sc, oy = 150 - cy * sc;
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
  if (which === 'vol') renderMap(null); else if (which === 'ligne') renderLiveMap(); else renderRealMap(realShown());
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mapmode]'); if (!b) return;
  S.mapMode = b.dataset.mapmode; S.mapView = null;
  document.querySelectorAll('[data-mapmode]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
  renderMap(null);
});
// Carte du vol : zoom (molette, double-clic, boutons + / −) et déplacement (glisser). « Route entière » ou « Suivre l’avion » recentre.
(function mapNav() {
  const svg = $('map');
  const MIN = 0.6, MAX = 1500;
  let raf = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderMap(null); }); };
  const free = () => {
    if (S.mapMode !== 'libre') {
      S.mapMode = 'libre';
      document.querySelectorAll('[data-mapmode]').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
    }
    if (!S.mapView) S.mapView = Object.assign({}, S.mapCur || { cx: 180, cy: 140, sc: 0.8 });
    return S.mapView;
  };
  const toView = (e) => { const r = svg.getBoundingClientRect(); const k = Math.min(r.width / 600, r.height / 300) || 1; return { x: 300 + (e.clientX - (r.left + r.width / 2)) / k, y: 150 + (e.clientY - (r.top + r.height / 2)) / k }; };
  const zoomAt = (f, vx, vy) => {
    const v = free();
    const sc2 = Math.min(MAX, Math.max(MIN, v.sc * f));
    // le point sous la souris reste au même endroit
    const wx = v.cx + (vx - 300) / v.sc, wy = v.cy + (vy - 150) / v.sc;
    v.cx = wx - (vx - 300) / sc2; v.cy = wy - (vy - 150) / sc2; v.sc = sc2;
    redraw();
  };
  svg.addEventListener('wheel', (e) => { e.preventDefault(); const p = toView(e); zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y); }, { passive: false });
  svg.addEventListener('mousedown', (e) => e.preventDefault()); // pas de sélection de texte en faisant glisser
  svg.addEventListener('dblclick', (e) => { const p = toView(e); zoomAt(2, p.x, p.y); });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const v = free(); const p = toView(e);
    drag = { x: p.x, y: p.y, cx: v.cx, cy: v.cy, id: e.pointerId, moved: false };
    svg.setPointerCapture(e.pointerId); svg.classList.add('grab');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = toView(e), v = S.mapView;
    v.cx = drag.cx - (p.x - drag.x) / v.sc; v.cy = drag.cy - (p.y - drag.y) / v.sc;
    redraw();
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) { drag = null; svg.classList.remove('grab'); } };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  document.addEventListener('click', (e) => {
    const z = e.target.closest('[data-mapzoom]'); if (!z) return;
    zoomAt(z.dataset.mapzoom === 'in' ? 1.6 : 1 / 1.6, 300, 150);
  });
})();
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
  const steps = p.steps && p.steps.length ? p.steps.map((s) => 'FL' + Math.round(s.alt / 1000) * 10 + ' à ' + esc(s.ident)).join(', ') : 'aucun';
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
}

$('btnSimbrief').addEventListener('click', async () => {
  $('sbMsg').textContent = 'Chargement…';
  try {
    S.plan = await afv.loadSimbrief();
    $('sbMsg').textContent = 'Plan chargé.';
    renderPlan(); renderDayNext(false);
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
  S.maxHist = []; S.infos = {}; S.co = Callouts.create();
  if (S.store && S.store.settings.maxOverlay !== false) await openMax();
  maxSays(adviceFor(0));
  startChecklist(0);
  playPhaseAnnouncements(0);
}
$('btnStart').addEventListener('click', () => startFlight('sim'));
$('btnDemo').addEventListener('click', () => startFlight('demo'));
$('btnStop').addEventListener('click', async () => {
  await afv.stopFlight();
  if (curAudio) curAudio.pause();
  maxStop();
  queue.length = 0;
  S.flight = null; S.phase = null; S.ck = null;
  afv.maxClose();
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
  pushMax();
});
$('btnMaxOverlay').addEventListener('click', () => { if (S.maxWin) afv.maxClose(); else openMax(); });
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
  tickCallouts(t);
  tickChecklist(t);
  flightInfos(t, d);
});
afv.on('flight:event', (e) => {
  if (!S.flight) return;
  opsEvent(e);
  if (e.type === 'phase') {
    S.phase = e.phase;
    renderPhases(e.phase);
    $('maxPhase').textContent = 'Phase : ' + e.name;
    maxSays(adviceFor(e.phase));
    startChecklist(e.phase);
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
    const txt = 'Palier : monte au FL' + Math.round(e.alt / 1000) * 10 + ' à ' + e.ident + '.';
    addAlert('Palier de montée', txt);
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
// Fin du vol : l'avion de la compagnie rentre au hangar (il redevient libre pour les autres pilotes),
// sauf si un autre vol de « Ma journée » part de l'aéroport d'arrivée : on le garde pour ce vol.
// Durée de la maintenance après les vols : 30 min + 10 min par heure de vol (3 h au plus)
const maintMinutes = (flightMin) => Math.min(180, 30 + Math.round((flightMin || 0) / 60 * 10 / 5) * 5);
async function autoHangar(rep) {
  try {
    await loadBookings(true);
    const b = (S.plan2.book.list || []).find((x) => x.mine && !x.maint && x.until > Date.now());
    if (!b) return;
    const d = S.plan2.data, arr = (rep && rep.to) || (S.plan && S.plan.destination && S.plan.destination.icao);
    const next = d && arr ? d.flights.filter((f) => d.mine.includes(f.key) && f.from === arr && (f.depEst || 0) > Date.now() - 30 * 60000).sort((x, y) => x.depEst - y.depEst) : [];
    const dur = (m) => m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : m + ' minutes';
    // carnet de l'avion sur le serveur (heures, usure, aéroport) et, s'il rentre, maintenance
    const r = await afv.hangarFinish({ reg: b.reg, callsign: rep && rep.callsign, dep: rep && rep.from, arr, minutes: (rep && (rep.flightMinutes || rep.blockMinutes)) || 0, rate: rep && rep.landingRate, keep: next.length > 0 });
    if (r && r.ok) {
      await loadBookings(true); loadHangar(true);
      if (r.kept) { maxSays('Je garde ' + b.reg + ' pour ton prochain vol, ' + (next[0].number || next[0].callsign) + ' au départ de ' + arr + '.'); return; }
      const m = r.maintenance || {};
      maxSays(b.reg + ' rentre au hangar de ' + (r.state && r.state.location || arr) + ' : ' + (m.reason || 'maintenance').toLowerCase() + '. Il sera de nouveau disponible dans ' + dur(m.minutes || 30) + '.');
      return;
    }
    // hangar pas encore activé sur le serveur : simple maintenance
    S.plan2.flown = Object.assign(S.plan2.flown || {}, { [b.reg]: (S.plan2.flown && S.plan2.flown[b.reg] || 0) + (rep && rep.flightMinutes || 60) });
    if (next.length) { maxSays('Je garde ' + b.reg + ' pour ton prochain vol, ' + (next[0].number || next[0].callsign) + ' au départ de ' + arr + '.'); return; }
    const mins = maintMinutes(S.plan2.flown[b.reg]);
    const rr = await afv.fleetRelease(b.reg, mins);
    await loadBookings(true);
    delete S.plan2.flown[b.reg];
    if (rr && rr.ok) maxSays(b.reg + ' rentre au hangar pour la maintenance : il sera de nouveau disponible dans ' + dur(mins) + '.');
  } catch (e) { /* l'avion se libérera tout seul à l'heure prévue */ }
}
afv.on('flight:report', (r) => {
  showReport(r);
  S.reports = [r].concat(S.reports || []);
  if (r.mode !== 'demo') setTimeout(() => autoHangar(r), 6000);
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
  if (!$('fleet')) return; // l'ancien « Hangar & flotte » a été remplacé par le Hangar de la compagnie
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
if ($('fleet')) $('fleet').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const f = S.store.fleet.slice();
  if (b.dataset.del != null) f.splice(+b.dataset.del, 1);
  if (b.dataset.repair != null) Object.assign(f[+b.dataset.repair], { repairUntil: null, reason: '', health: 100 });
  S.store.fleet = await afv.setFleet(f);
  renderFleet(); renderAircraftSelect();
});
if ($('btnAddPlane')) $('btnAddPlane').addEventListener('click', async () => {
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

// ---------------- sons (Universal Announcer) ----------------
// plus de liste des annonces à l'écran : on vérifie seulement s'il existe des sons, pour le message du tracker de vol
async function renderSounds() {
  let files = {};
  try { files = await afv.uaFiles(S.plan && S.plan.aircraft); } catch (e) { files = {}; }
  S.uaFound = Object.values(files || {}).some((f) => f && f.file);
  renderAnnHint();
}
$('btnSndRefresh').addEventListener('click', () => { loadUa(); renderSounds(); });
function alertBox(e) { console.error(e); }

// ---------------- avis ----------------
const TAGS = ['Annonces sonores', 'Conseils de Max', 'Carte du vol', 'Alerte TOD', 'Détection des phases', 'Hangar', 'Rapport de vol', 'Autre'];
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
  return 'Avis tracker Les Ailes Tricolores v' + $('ver').textContent + '\nNote : ' + S.stars + '/5\nPoints à améliorer : ' + (tags.join(', ') || '—') + '\n' + $('fbText').value.trim();
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
  $('sMaxVoice').checked = s.maxVoice !== false; $('sDiscord').checked = s.discord !== false; $('sChat').checked = s.chat !== false; $('sMaxOverlay').checked = s.maxOverlay !== false; $('sLive').checked = s.liveShare !== false; $('sTray').checked = s.closeToTray !== false; $('sMaxVol').value = s.maxVolume != null ? s.maxVolume : 0.9;
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
  S.store.settings = await afv.setSettings({ pilot: $('sPilot').value.trim(), simbrief: $('sSimbrief').value.trim(), announcements: $('sAnn').checked, volume: +$('sVol').value, hard1: h1, hard2: h2, maxVoice: $('sMaxVoice').checked, maxVolume: +$('sMaxVol').value, discord: $('sDiscord').checked, chat: $('sChat').checked, maxOverlay: $('sMaxOverlay').checked, liveShare: $('sLive').checked, closeToTray: $('sTray').checked });
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
// la fenêtre des nouveautés se ferme aussi avec Échap ou en cliquant à côté
$('newsModal').addEventListener('click', (e) => { if (e.target === $('newsModal')) $('btnNewsOk').click(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('newsModal').hidden) $('btnNewsOk').click(); });

document.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b) showTab(b.dataset.goto); });
function renderAnnHint() { $('annHint').hidden = !!S.uaFound; }

// ---------------- démarrage ----------------
(async function init() {
  const d = await afv.init();
  S.store = d.store;
  S.reports = d.reports || [];
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
// Avions de la compagnie : un par livrée (catalogue de la rubrique « Livrées »), ex. F-HLAT, A320 « Ruban »
S.plan2.company = [];
const TYPE_LABEL = { A320: 'A320', B77W: '777-300ER' };
const LONG_HAUL = ['B77W', 'B772', 'B789', 'A359', 'A332'];
async function loadCompanyFleet() {
  try {
    const r = await afv.listLiveries(false);
    S.plan2.company = (r.livrees || []).filter((l) => l.reg).map((l) => {
      const type = l.type || ((/\b(A3\d\d)\b/.exec(l.aircraft || '') || [])[1]) || (/777-300/.test(l.aircraft || '') ? 'B77W' : 'A320');
      return { reg: l.reg, type, label: TYPE_LABEL[type] || type, long: LONG_HAUL.includes(type), image: l.image || '', name: l.name, aircraft: l.aircraft || '', engine: l.engine || '', installed: !!l.installed };
    }).sort((a, b) => a.long - b.long || a.reg.localeCompare(b.reg));
  } catch (e) { S.plan2.company = []; }
  if (S.plan2.company.length) loadBookings(true);
  if ($('tab-planning').classList.contains('on')) renderPlanning();
}
setTimeout(loadCompanyFleet, 2500);
// Réservations des avions de la compagnie (serveur partagé) : un avion pris n'est plus proposé aux autres pilotes.
S.plan2.book = { list: [], at: 0, error: '', msg: '' };
async function loadBookings(force) {
  if (!force && Date.now() - S.plan2.book.at < 60000) return;
  S.plan2.book.at = Date.now();
  try {
    const r = await afv.fleetBookings();
    if (r && r.ok) { S.plan2.book.list = r.list; S.plan2.book.error = ''; } else S.plan2.book.error = (r && r.error) || 'Serveur injoignable.';
  } catch (e) { S.plan2.book.error = 'Serveur injoignable.'; }
  if ($('tab-planning').classList.contains('on')) renderPlanning();
}
const bookingOf = (reg) => S.plan2.book.list.find((b) => b.reg === reg && b.until > Date.now()) || null;
const hLocal = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
setInterval(() => { if (S.plan2.company.length && $('tab-planning').classList.contains('on')) loadBookings(true); }, 60000);
const companyPlane = (reg) => (S.plan2.company || []).find((c) => c.reg === reg) || null;
// vols que notre avion peut reprendre : exactement le même modèle (notre A320 « classique » : ni A319, ni A321, ni A320neo)
const sameFamily = (type, ours) => String(type || '').toUpperCase() === String(ours || '').toUpperCase();
// « Ma journée » : chaque vol avec son état (fait / prochain / à faire) et, pour le prochain, les 3 étapes à suivre
function legDone(f) {
  const today = new Date().toDateString();
  return (S.reports || []).some((r) => r.mode !== 'demo' && r.from === f.from && r.to === f.to && new Date(r.date).toDateString() === today && (!f.depEst || Date.parse(r.date) > f.depEst - 3 * 3600000));
}
// Prochain vol de « Ma journée » (premier vol pas encore fait)
function nextDayLeg() {
  const d = S.plan2.data; if (!d) return null;
  const byKey = Object.fromEntries(d.flights.map((f) => [f.key, f]));
  const mine = d.mine.map((k) => byKey[k]).filter(Boolean);
  const i = mine.findIndex((f) => !legDone(f));
  return i < 0 ? null : { f: mine[i], i, n: mine.length };
}
// Tracker de vol : rappel du prochain vol de la journée, et vérification que le plan SimBrief chargé est le bon
async function renderDayNext(load) {
  const box = $('dayNext'); if (!box) return;
  if (load && !S.plan2.data) { try { S.plan2.data = await afv.getPlanning(false); } catch (e) { /* hors ligne */ } }
  const nx = nextDayLeg();
  if (!nx || S.flight) { box.hidden = true; return; }
  const f = nx.f, own = companyPlane(S.plan2.myReg);
  const num = own ? esc(f.number || f.callsign).replace(/^AF\s?/, 'LAT') : esc(f.number || f.callsign);
  const ok = S.plan && S.plan.origin && S.plan.origin.icao === f.from && S.plan.destination && S.plan.destination.icao === f.to;
  box.hidden = false;
  box.className = 'day-next ' + (ok ? 'ok' : 'todo');
  box.innerHTML = '<div><b>▶ Vol ' + (nx.i + 1) + '/' + nx.n + ' de ta journée : ' + num + ' ' + esc(f.from) + ' → ' + esc(f.to) + '</b>' + (own ? ' avec ' + esc(own.reg) : '') + (f.depEst ? ' · départ ' + hhZ(f.depEst) : '') +
    '<div class="small">' + (ok ? '✓ Le plan SimBrief chargé correspond à ce vol : tu peux démarrer.'
      : S.plan && S.plan.origin ? '⚠ Le plan chargé est ' + esc(S.plan.origin.icao) + ' → ' + esc(S.plan.destination.icao) + '. Prépare ' + esc(f.from) + ' → ' + esc(f.to) + ' dans SimBrief, puis « Charger mon plan SimBrief ».'
      : 'Prépare-le dans SimBrief (« Generate Flight »), puis clique sur « Charger mon plan SimBrief ».') + '</div></div>' +
    (ok ? '' : '<a class="btn small red" href="' + esc(planSimbrief(f)) + '" target="_blank" rel="noopener">Ouvrir SimBrief</a>');
}
function myDayHtml(mine) {
  if (!mine.length) return '<h3 class="caps">Ma journée</h3><p class="muted">Ajoute des vols avec l’étoile ☆, ou laisse Max te proposer une journée avec l’avion de la compagnie.</p>';
  const own = companyPlane(S.plan2.myReg);
  const num = (f) => own ? esc(f.number || f.callsign).replace(/^AF\s?/, 'LAT') : esc(f.number || f.callsign);
  const nextI = mine.findIndex((f) => !legDone(f));
  const cards = '<div class="mine">' + mine.map((f, i) => {
    const done = legDone(f), next = i === nextI;
    return '<div class="am' + (done ? ' done' : next ? ' next' : '') + '"><div class="row between"><span class="t">' + (i + 1) + '. ' + num(f) + ' · ' + esc(f.from) + ' → ' + esc(f.to) + '</span>' +
      '<span class="pst ' + (done ? 'arrive' : next ? 'en-vol' : '') + '">' + (done ? '✓ Fait' : next ? '▶ Prochain' : 'À faire') + '</span></div>' +
      '<div class="muted small">' + (f.depEst ? 'Départ ' + hhZ(f.depEst) + ' · ' : '') + esc(f.type || 'avion inconnu') + ' · ' + hm(f.blockMin) + ' · <button class="linkbtn" data-pmine="' + esc(f.key) + '">Retirer</button></div></div>';
  }).join('') + '</div>';
  const head = '<div class="row between"><h3 class="caps" style="margin:0">Ma journée</h3><button class="linkbtn" data-dayclear title="Retire tous les vols de « Ma journée »">Vider ma journée</button></div>';
  if (nextI < 0) return head + cards + '<div class="day-guide"><b>✓ Journée terminée, bravo commandant !</b> Tes rapports sont dans « Mes vols ».</div>';
  const f = mine[nextI];
  const planOk = S.plan && S.plan.origin && S.plan.origin.icao === f.from && S.plan.destination && S.plan.destination.icao === f.to;
  const guide = '<div class="day-guide"><div class="dg-h">▶ Prochain vol : <b>' + num(f) + ' ' + esc(f.from) + ' → ' + esc(f.to) + '</b>' + (own ? ' avec ' + esc(own.reg) : '') + (f.depEst ? ' · départ prévu ' + hhZ(f.depEst) : '') + '</div>' +
    '<ol class="dg-steps">' +
    '<li class="ok-' + (planOk ? 1 : 0) + '"><span class="n">1</span><div><b>Prépare le vol dans SimBrief</b><div class="muted small">Le formulaire s’ouvre déjà rempli' + (own ? ' (indicatif LAT, ' + esc(own.reg) + ')' : '') + ' : clique sur « Generate Flight » en bas de la page SimBrief.</div></div><a class="btn small red" href="' + esc(planSimbrief(f)) + '" target="_blank" rel="noopener">Ouvrir SimBrief</a></li>' +
    '<li class="ok-' + (planOk ? 1 : 0) + '"><span class="n">2</span><div><b>Charge le plan dans le tracker</b><div class="muted small">' + (planOk ? '✓ Plan ' + esc(f.from) + ' → ' + esc(f.to) + ' chargé.' : S.plan2.dayErr ? '<span style="color:var(--red)">' + esc(S.plan2.dayErr) + '</span>' : S.plan && S.plan.origin ? '<span style="color:var(--red)">Le plan chargé est ' + esc(S.plan.origin.icao) + ' → ' + esc(S.plan.destination.icao) + ' : génère d’abord ' + esc(f.from) + ' → ' + esc(f.to) + ' dans SimBrief.</span>' : 'Le tracker récupère le plan que tu viens de générer.') + '</div></div><button class="btn small ' + (planOk ? 'ghost' : 'red') + '" data-dayload>' + (planOk ? 'Recharger' : 'Charger le plan') + '</button></li>' +
    '<li><span class="n">3</span><div><b>Lance le vol</b><div class="muted small">Dans MSFS, place ' + (own ? esc(own.reg) : 'ton avion') + ' à ' + esc(f.from) + ', puis « Démarrer le suivi ». Le vol se coche ✓ tout seul une fois au parking à ' + esc(f.to) + '.</div></div><button class="btn small ' + (planOk ? 'red' : 'ghost') + '" data-daygo>Aller au tracker</button></li>' +
    '</ol></div>';
  return head + cards + guide;
}
function planSimbrief(f) {
  const own = companyPlane(S.plan2.myReg);
  const p = own
    ? { orig: f.from, dest: f.to, airline: 'LAT', fltnum: (f.number || '').replace(/\D/g, ''), type: own.type, reg: own.reg }
    : Object.assign({ orig: f.from, dest: f.to, airline: 'AFR', fltnum: (f.number || '').replace(/\D/g, '') }, f.type ? { type: f.type } : {});
  return 'https://dispatch.simbrief.com/options/custom?' + new URLSearchParams(p).toString();
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
  $('planMine').innerHTML = myDayHtml(mine) + maxDayHtml(all, mine);
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
  if (e.target.closest('[data-maxday-other]')) { S.plan2.variant = (S.plan2.variant || 0) + 1; renderPlanning(); return; }
  if (e.target.closest('[data-maxday-say]')) { if (S.plan2.maxSay) { maxStop(); maxSpeak(S.plan2.maxSay, true); } return; }
  const take = e.target.closest('[data-maxday-add], [data-maxday-take]');
  const own = take && companyPlane(S.plan2.myReg);
  if (own && !S.plan2.book.error && !(bookingOf(own.reg) || {}).mine) {
    // l'avion de la compagnie est réservé sur le serveur avant d'ajouter les vols : un seul pilote à la fois
    take.disabled = true; S.plan2.book.msg = '';
    const r = await afv.fleetTake(own.reg, S.plan2.until);
    await loadBookings(true);
    if (!r || !r.ok) { S.plan2.book.msg = (r && r.error) || 'Réservation impossible.'; renderPlanning(); return; }
  }
  if (e.target.closest('[data-maxday-take]')) { renderPlanning(); return; }
  if (e.target.closest('[data-maxday-release]')) {
    const o = companyPlane(S.plan2.myReg);
    if (o) {
      const flown = S.plan2.flown && S.plan2.flown[o.reg];
      const r = await afv.fleetRelease(o.reg, flown ? maintMinutes(flown) : 0);
      if (flown && r && r.ok) delete S.plan2.flown[o.reg];
      S.plan2.book.msg = r && r.ok ? '' : (r && r.error) || ''; await loadBookings(true);
    }
    renderPlanning(); return;
  }
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
  if (e.target && e.target.id === 'maxDayReg') { S.plan2.myReg = e.target.value || null; try { if (!S.plan2.myReg) localStorage.removeItem('lat.myReg'); } catch (err) { /* rien */ } S.plan2.myKey = null; S.plan2.variant = 0; S.plan2.book.msg = ''; renderPlanning(); if (companyPlane(S.plan2.myReg)) loadBookings(true); }
  if (e.target && e.target.id === 'maxDayBase') { S.plan2.base = e.target.value; S.plan2.variant = 0; renderPlanning(); }
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
// Journée de l'avion de la compagnie : on part de « base » et on enchaîne des vols de la même famille,
// chacun partant de l'aéroport d'arrivée du précédent, avec 40 min d'escale minimum (5 vols / 10 h de vol au plus).
// « variant » change le premier vol pour proposer une autre journée.
function companyDayPlan(all, type, base, now, variant, long) {
  const TURN = 40 * 60000, MAXWAIT = 3 * 3600000, home = (ap) => ap === base || /^LFP[GO]$/.test(ap);
  const open = (f) => sameFamily(f.type, type) && f.depEst && f.arrEst && !['Annulé', 'Arrivé', 'En vol'].includes(f.status);
  const from = (ap, after, before) => all.filter((f) => open(f) && f.from === ap && f.depEst >= after && (!before || f.depEst <= before)).sort((a, b) => a.depEst - b.depEst);
  // un vol qui quitte la base doit avoir un retour possible, pour ne pas laisser l'avion loin de Paris
  const back = (f) => from(f.to, f.arrEst + TURN, f.arrEst + MAXWAIT).find((r) => home(r.to)) || null;
  if (long) {   // long-courrier : un seul vol, l'avion reste à destination (retour à la prochaine session)
    const out = from(base, now + 20 * 60000);
    if (!out.length) return { legs: [], block: 0, end: base, long: true };
    const f = out[(variant || 0) % out.length];
    return { legs: [f], block: f.blockMin || 0, end: f.to, long: true };
  }
  const firsts = from(base, now + 20 * 60000).filter((f) => home(f.to) || back(f));
  if (!firsts.length) return { legs: [], block: 0, end: base };
  const legs = [firsts[(variant || 0) % firsts.length]];
  let block = legs[0].blockMin || 0;
  while (legs.length < 6) {
    const prev = legs[legs.length - 1];
    const next = from(prev.to, prev.arrEst + TURN, prev.arrEst + MAXWAIT);
    // loin de Paris : on rentre ; à Paris : un aller qui a son retour, dans le temps de vol restant
    const n = home(prev.to)
      ? next.find((f) => { const r = home(f.to) ? null : back(f); return (home(f.to) || r) && block + (f.blockMin || 0) + (r ? r.blockMin || 0 : 0) <= 600; })
      : next.find((f) => home(f.to) && block + (f.blockMin || 0) <= 600);
    if (!n) break;
    legs.push(n); block += n.blockMin || 0;
  }
  return { legs, block, end: legs[legs.length - 1].to };
}
function maxDayHtml(all, mine) {
  const regs = {};
  for (const f of all) if (f.reg) { const r = regs[f.reg] || (regs[f.reg] = { reg: f.reg, model: f.model || f.type || 'Type inconnu', n: 0 }); if (f.status !== 'Annulé') r.n++; }
  const list = Object.values(regs);
  const company = S.plan2.company || [];
  if (!list.length && !company.length) return '';
  // par défaut : l'avion du premier vol de « Ma journée »
  if (!S.plan2.myReg || (!regs[S.plan2.myReg] && !companyPlane(S.plan2.myReg))) {
    // l'avion choisi la dernière fois (gardé même après un redémarrage), sinon celui que je pilote, sinon celui du 1er vol de « Ma journée »
    let saved = null; try { saved = localStorage.getItem('lat.myReg'); } catch (e) { /* stockage indisponible */ }
    const booked = (S.plan2.book.list || []).find((b) => b.mine && !b.maint && b.until > Date.now());
    const m = mine.find((f) => f.reg);
    S.plan2.myReg = booked && companyPlane(booked.reg) ? booked.reg : saved && (companyPlane(saved) || regs[saved]) ? saved : m ? m.reg : null;
    S.plan2.myKey = !booked && !saved && m ? m.key : null;
  }
  try { if (S.plan2.myReg) localStorage.setItem('lat.myReg', S.plan2.myReg); } catch (e) { /* rien */ }
  const byModel = {};
  for (const r of list) (byModel[r.model] = byModel[r.model] || []).push(r);
  const opts = '<option value="">Choisis ton avion…</option>' +
    (company.length ? '<optgroup label="Les Ailes Tricolores · nos avions">' + company.map((c) => { const b = bookingOf(c.reg); return '<option value="' + esc(c.reg) + '"' + (c.reg === S.plan2.myReg ? ' selected' : '') + '>' + esc(c.reg) + ' · ' + esc(c.label) + ' de la compagnie' + (b ? (b.maint ? ' · en maintenance jusqu’à ' + hLocal(b.until) : b.mine ? ' · piloté par toi' : ' · piloté par ' + esc(b.pseudo)) : '') + '</option>'; }).join('') + '</optgroup>' : '') +
    '<optgroup label="──────────" disabled></optgroup>' + Object.keys(byModel).sort().map((m) => '<optgroup label="Air France · ' + esc(m) + '">' +
    byModel[m].sort((a, b) => a.reg.localeCompare(b.reg)).map((r) => '<option value="' + esc(r.reg) + '"' + (r.reg === S.plan2.myReg ? ' selected' : '') + '>' + esc(r.reg) + ' · ' + r.n + ' vol' + (r.n > 1 ? 's' : '') + '</option>').join('') + '</optgroup>').join('');
  const reg = S.plan2.myReg;
  let booked = '';
  let t = { html: 'Choisis un vol dans <b>Vols réels › À venir</b> (bouton « Prendre ce vol ») ou dis-moi quel avion tu veux prendre : je te dirai si c’est un seul vol ou si tu dois suivre la journée de l’avion.', say: '' }, add = [];
  const own = companyPlane(reg);
  if (own) {
    // notre propre avion : Max compose une journée de vols qui s'enchaînent (chaque vol part de l'arrivée du précédent)
    const now = Date.now();
    const bases = [...new Set(all.filter((f) => sameFamily(f.type, own.type)).map((f) => f.from))].sort((a, b) => (/^LFP[GO]$/.test(b) - /^LFP[GO]$/.test(a)) || a.localeCompare(b));
    // l'avion part de l'aéroport où il se trouve (hangar)
    const where = hangarState(own.reg);
    if (where && where.location) S.plan2.base = where.location;
    else if (!S.plan2.base || !bases.includes(S.plan2.base)) {
      const last = (S.reports || []).find((r) => r.mode !== 'demo' && r.to);
      S.plan2.base = last && bases.includes(last.to) ? last.to : (bases.includes('LFPG') ? 'LFPG' : bases[0]);
    }
    const day = companyDayPlan(all, own.type, S.plan2.base, now, S.plan2.variant || 0, own.long);
    const leg = (f, k) => '<li><b>' + esc(f.number || f.callsign).replace(/^AF/, 'LAT') + '</b> · ' + esc(f.from) + ' → ' + esc(f.to) + ' · ' + hhZ(f.depEst) + ' → ' + hhZ(f.arrEst) + ' · ' + hm(f.blockMin) +
      (k > 0 ? ' <span class="muted small">(escale ' + hm(Math.round((f.depEst - day.legs[k - 1].arrEst) / 60000)) + ')</span>' : '') + (mine.some((m) => m.key === f.key) ? ' <span class="pst arrive">dans ma journée</span>' : '') + '</li>';
    const baseSel = where && where.location ? '<b title="L’avion part de l’aéroport où il se trouve (rubrique Hangar)">📍 ' + esc(where.location) + '</b>' : '<select id="maxDayBase" aria-label="Aéroport de départ de l’avion" style="height:32px;border:1px solid var(--line);border-radius:8px;padding:0 6px">' + bases.map((b) => '<option' + (b === S.plan2.base ? ' selected' : '') + '>' + esc(b) + '</option>').join('') + '</select>';
    t = {
      html: '<b>Ta journée avec ' + esc(own.reg) + ', ' + (/^A/.test(own.label) ? 'l’' : 'le ') + esc(own.label) + ' de la compagnie</b>' + (own.name ? ' (' + esc(own.name.replace(/^Les Ailes Tricolores\s*[–-]\s*/, 'livrée ')) + ')' : '') + '. L’avion part de ' + baseSel + '.<br>' +
        (day.legs.length
          ? 'Je te propose ' + day.legs.length + ' vol' + (day.legs.length > 1 ? 's qui s’enchaînent' : '') + ', ' + hm(day.block) + ' de vol' + (day.legs.length > 1 ? ', avec 40 min à 3 h d’escale' : '') + ' :<ol class="mday">' + day.legs.map(leg).join('') + '</ol>' +
            (day.long ? '<span class="muted small">Long-courrier : l’avion reste à ' + esc(day.end) + ', tu feras le retour à ta prochaine session. </span>' : day.end && !/^LFP[GO]$/.test(day.end) && day.end !== S.plan2.base ? '<span class="muted small">L’avion finit la journée à ' + esc(day.end) + ' : je n’ai pas trouvé de vol retour assez tôt. </span>' : '<span class="muted small">L’avion revient à ' + esc(day.end) + ' en fin de journée. </span>') +
            '<span class="muted small">SimBrief prépare chaque vol avec l’indicatif LAT et l’immatriculation ' + esc(own.reg) + '.</span>'
          : planStale() ? 'Le programme des vols n’est pas encore celui d’aujourd’hui (' + esc(planStale()) + ') : il est mis à jour chaque matin. Clique sur « Actualiser » en haut du planning ; s’il ne change pas, réessaie un peu plus tard.'
          : 'Je ne trouve plus de vol ' + esc(own.label) + ' au départ de ' + esc(S.plan2.base) + ' aujourd’hui. ' + (where && where.location ? 'L’avion est à ' + esc(where.location) + ' : reviens plus tard ou demande à la direction de le déplacer.' : 'Choisis un autre aéroport ou actualise le planning.')) +
        (own.installed ? '' : '<br><span class="muted small">La livrée n’est pas encore installée : rubrique « Livrées ».</span>'),
      say: day.legs.length ? 'Voici ta journée avec ' + own.reg + ' : ' + day.legs.length + ' vol' + (day.legs.length > 1 ? 's' : '') + '. Tu pars de ' + day.legs[0].from + (day.legs[0].depEst ? ' à ' + sayTime(day.legs[0].depEst) : '') + ', puis ' + day.legs.map((f) => f.to).join(', puis ') + '. ' + hm(day.block).replace(' h ', ' heures ') + ' de vol au total. Bonne journée !' : ''
    };
    add = day.legs.map((f) => f.key);
    const b = bookingOf(own.reg);
    if (b && b.maint) {
      t = { html: '<b>🔧 ' + esc(own.reg) + ' est en maintenance au hangar</b> jusqu’à ' + hLocal(b.until) + '. Personne ne peut le prendre avant la fin : choisis un autre avion, ou reviens à ' + hLocal(b.until) + '.', say: own.reg + ' est en maintenance au hangar jusqu’à ' + hLocal(b.until) + '.' };
      add = []; booked = 'other';
    } else if (b && !b.mine) {
      t = { html: '<b>' + esc(own.reg) + ' est déjà piloté par ' + esc(b.pseudo) + '</b> jusqu’à ' + hLocal(b.until) + ' au plus tard. Tant qu’il l’a, personne d’autre ne peut le prendre : choisis un autre avion, ou reviens quand il l’aura rendu.', say: own.reg + ' est déjà piloté par ' + b.pseudo + '. Choisis un autre avion.' };
      add = []; booked = 'other';
    } else if (b) {
      t.html += '<div class="muted small" style="margin-top:6px">✔ <b>Tu pilotes ' + esc(own.reg) + '</b> jusqu’à ' + hLocal(b.until) + ' : les autres pilotes ne peuvent pas le prendre. Pense à le rendre si tu ne voles plus.</div>';
      booked = 'mine';
    } else if (S.plan2.book.error) {
      t.html += '<div class="muted small" style="margin-top:6px">Réservation impossible pour l’instant : ' + esc(S.plan2.book.error) + '</div>';
      booked = 'off';
    }
    if (S.plan2.book.msg) t.html += '<div class="small" style="margin-top:6px;color:var(--red)">' + esc(S.plan2.book.msg) + '</div>';
    S.plan2.until = day.legs.length ? day.legs[day.legs.length - 1].arrEst + 2 * 3600000 : Date.now() + 12 * 3600000;
  } else if (reg) {
    const p = aircraftPlan(all, reg, S.plan2.myKey, Date.now());
    t = maxPlanText(p, reg, regs[reg].model, mine.map((m) => m.key));
    add = p.todo.map((f) => f.key);
  }
  S.plan2.maxSay = t.say; S.plan2.maxAdd = add;
  const missing = add.filter((k) => !mine.some((m) => m.key === k)).length;
  return '<div class="maxday"><div class="max-head">' + MAX_AVATAR + '<div><div class="max-name">Max : quel avion prends-tu ?</div><div class="muted small">Un seul vol ou toute la journée de l’avion</div></div>' +
    '<select id="maxDayReg" aria-label="Avion que je veux prendre">' + opts + '</select></div>' +
    '<div class="max-say">' + t.html + '</div>' +
    (reg ? '<div class="row" style="margin-top:8px">' + (missing ? '<button class="btn small red" data-maxday-add>' + (own ? (booked === '' ? 'Prendre ' + own.reg + ' et ajouter ' + (add.length > 1 ? 'cette journée' : 'ce vol') + ' à « Ma journée »' : add.length > 1 ? 'Ajouter cette journée à « Ma journée »' : 'Ajouter ce vol à « Ma journée »') : add.length > 1 ? 'Ajouter ' + (missing === add.length ? 'les ' + missing + ' vols' : 'les ' + missing + ' vols manquants') + ' à « Ma journée »' : 'Ajouter ce vol à « Ma journée »') + '</button>' : (add.length ? '<span class="muted small">Tout est déjà dans « Ma journée ».</span>' : '')) +
      (t.say ? '<button class="btn small ghost" data-maxday-say>Écouter Max</button>' : '') + (own ? (booked === 'other' ? '' : '<button class="btn small ghost" data-maxday-other>Autre proposition</button>') + (booked === 'mine' ? '<button class="btn small ghost" data-maxday-release>Rendre l’avion</button>' : !missing && booked === '' && add.length ? '<button class="btn small red" data-maxday-take>Prendre ' + esc(own.reg) + '</button>' : '') : '<button class="btn small ghost" data-prot="' + esc(reg) + '">Voir la journée de l’avion</button>') + '</div>' : '') + '</div>';
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
  const steps = (pl.steps || []).map((s) => 'FL' + Math.round(s.alt / 1000) * 10 + ' à ' + s.ident).join(', ');
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
  $('chipFly').hidden = !flying; $('chipBeta').hidden = flying || !/beta/i.test($('ver').textContent); // badge BÊTA seulement pour une version bêta
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

// ---------------- Universal Announcer ----------------
async function loadUa() { try { S.ua = await afv.uaGet(); } catch (e) { S.ua = null; } renderUa(); }
function renderUa() {
  const u = S.ua; if (!u || !$('uaCard')) return;
  const st = u.running ? '<span class="badge">Lancé</span>' : '<span class="badge red">Pas lancé</span>';
  $('uaCard').innerHTML =
    '<div class="row between wrap"><h2 style="margin:0">Universal Announcer</h2>' + st + '</div>' +
    '<p class="muted">Le logiciel gratuit d’annonces cabine. Le tracker travaille avec lui, sans jamais jouer deux fois la même annonce.</p>' +
    '<div class="row between wrap"><div class="t"><b>Dossier « Announcements »</b><div class="muted small">' + (u.dir ? esc(u.dir) + (u.auto ? ' (trouvé automatiquement)' : '') : 'Introuvable : clique sur « Choisir » et sélectionne le dossier Announcements d’Universal Announcer.') + '</div></div>' +
    '<div class="row">' + (u.dir ? '<button class="btn small ghost" id="uaOpen">Ouvrir</button>' : '') + '<button class="btn small ghost" id="uaPick">Choisir</button>' + (u.dir && !u.auto ? '<button class="btn small ghost" id="uaAuto">Détection automatique</button>' : '') + '</div></div>' +
    '<ul class="muted small" style="margin:6px 0 0 18px;padding:0"><li><b>Universal Announcer lancé</b> : c’est lui qui joue les annonces, le tracker affiche seulement leur texte (jamais deux fois la même annonce).</li>' +
    '<li><b>Universal Announcer fermé</b> : le tracker joue lui-même les sons rangés dans son dossier (LAT, sinon Default), au bon moment du vol.</li>' +
    '<li>Les sons de la compagnie vont dans le dossier <b>LAT</b> d’Universal Announcer (indicatif LAT dans SimBrief).</li></ul>';
  const on = (id, fn) => { const e = $(id); if (e) e.addEventListener('click', fn); };
  on('uaPick', async () => { S.ua = await afv.uaPick(); renderUa(); renderSounds(); });
  on('uaAuto', async () => { S.ua = await afv.uaReset(); renderUa(); renderSounds(); });
  on('uaOpen', () => afv.uaOpen());
}
afv.on('ua:status', (u) => { S.ua = u; renderUa(); renderSounds(); });
setTimeout(loadUa, 3000);

// ---------------- pilotes en vol (les autres pilotes de la compagnie, en direct) ----------------
S.live = { list: [], error: '', ready: false, share: true, sel: null };
let liveVB = null;
const PH_LABEL = ['Embarquement', 'Roulage', 'Décollage', 'Montée', 'Croisière', 'Descente', 'Approche', 'Atterrissage', 'Au parking'];
async function loadLive() {
  try { Object.assign(S.live, await afv.liveGet()); } catch (e) { /* rien */ }
  renderLive();
}
afv.on('live:list', (l) => { Object.assign(S.live, l); renderLive(); });
// Petite carte « Pilotes en vol » sur la page Infos du jour (vue Europe, sans fond satellite)
function renderLiveMini() {
  const svg = $('liveMini'); if (!svg) return;
  mapSkeleton(svg);
  const L = S.live.list || [];
  // cadrage : l'Europe quand personne ne vole, sinon les avions
  let [x, y, w, h] = VIEWS.europe;
  if (L.length) {
    const xs = L.map((p) => MX(p.lon)), ys = L.map((p) => MY(p.lat));
    // cadré sur les avions (au moins la taille de la France), sans couper personne
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    w = Math.max(28, (x1 - x0) * 1.4 + 8); h = Math.max(12, (y1 - y0) * 1.4 + 6);
    x = (x0 + x1) / 2 - w / 2; y = (y0 + y1) / 2 - h / 2;
  }
  const ratio = (svg.clientHeight || 260) / (svg.clientWidth || 1000);
  const hh = Math.max(h, w * ratio), ww = hh / ratio;
  const vb = [x + w / 2 - ww / 2, y + h / 2 - hh / 2, ww, hh];
  svg.setAttribute('viewBox', vb.join(' '));
  const k = Math.pow(ww / 360, 0.6);
  svg.querySelector('.fg').innerHTML = L.map((p) => '<g transform="translate(' + MX(p.lon).toFixed(3) + ' ' + MY(p.lat).toFixed(3) + ')"><title>' + esc(p.pseudo + ' · ' + (p.cs || '')) + '</title>' +
    '<g transform="rotate(' + (p.hdg || 0) + ') scale(' + (0.5 * k) + ')"><path d="' + PLANE + '" style="fill:' + (p.mine ? '#C8102E' : '#0A1E4A') + ';stroke:#fff;stroke-width:.6"/></g>' +
    '<text x="' + (2.8 * k) + '" y="' + (-1.8 * k) + '" font-size="' + (3 * k) + '" font-weight="700" fill="#0A1E4A" paint-order="stroke" stroke="#fff" stroke-width="' + (0.7 * k) + '">' + esc(p.pseudo) + '</text></g>').join('');
  $('liveMiniEmpty').hidden = !!L.length;
  $('liveMiniSub').textContent = S.live.error ? 'Connexion : ' + S.live.error : L.length ? L.length + ' pilote' + (L.length > 1 ? 's' : '') + ' en vol en ce moment' : 'Les pilotes des Ailes Tricolores en vol en ce moment';
  $('liveMiniList').innerHTML = L.slice(0, 4).map((p) => '<span class="lm"><b>' + esc(p.pseudo) + '</b> ' + esc(p.cs || '') + (p.from ? ' · ' + esc(p.from) + ' → ' + esc(p.to || '?') : '') + (p.alt != null ? ' · ' + (p.alt >= 18000 ? 'FL' + Math.round(p.alt / 100) : fmt(p.alt) + ' ft') : '') + '</span>').join('') + (L.length > 4 ? '<span class="lm">+' + (L.length - 4) + ' autres</span>' : '');
}
// Copier le vol d'un autre pilote dans SimBrief : même départ, même arrivée, même type d'avion, indicatif LAT
function liveSimbrief(x) {
  const p = { orig: x.from, dest: x.to, airline: 'LAT' };
  const n = String(x.cs || '').replace(/\D/g, ''); if (n) p.fltnum = n;
  if (x.ac && /^[A-Z0-9]{3,4}$/i.test(x.ac)) p.type = x.ac.toUpperCase();
  return 'https://dispatch.simbrief.com/options/custom?' + new URLSearchParams(p).toString();
}
function renderLive() {
  renderLiveMini();
  const L = S.live.list || [];
  const b = $('liveBadge'); if (b) { const n = L.filter((x) => !x.mine).length; b.hidden = !n; b.textContent = n; }
  if (!$('tab-ligne').classList.contains('on')) return;
  const others = L.filter((x) => !x.mine).length;
  $('liveSub').textContent = S.live.error ? 'Connexion : ' + S.live.error
    : !S.live.ready ? 'Connexion aux autres pilotes…'
    : L.length ? L.length + ' pilote' + (L.length > 1 ? 's' : '') + ' en vol' + (L.some((x) => x.mine) ? ' (toi compris)' : '') : 'Aucun pilote de la compagnie en vol pour le moment';
  const alt = (x) => x.alt == null ? '—' : x.alt >= 18000 ? 'FL' + Math.round(x.alt / 100) : fmt(x.alt) + ' ft';
  $('liveList').innerHTML = L.length ? '<div class="live-grid">' + L.map((x) => '<div class="live-card' + (x.id === S.live.sel ? ' on' : '') + '"><button class="rt" data-livesel="' + esc(x.id) + '">' +
    '<span class="n">' + esc(x.cs || '—') + (x.mine ? '<br><span class="pst arrive">toi</span>' : '') + '</span>' +
    '<span><b>' + esc(x.pseudo) + '</b>' + (x.grade ? ' <span class="c">· ' + esc(x.grade) + '</span>' : '') + '<br><span class="c">' + (x.from ? esc(x.from) + ' → ' + esc(x.to || '?') : 'Route inconnue') + (x.ac ? ' · ' + esc(x.ac) : '') + (x.reg ? ' · ' + esc(x.reg) : '') + (x.ph != null ? ' · ' + esc(PH_LABEL[x.ph] || '') : '') + '</span></span>' +
    '<span class="a">' + alt(x) + '<br>' + (x.gs != null ? x.gs + ' kt' : '') + '</span></button>' +
    (!x.mine && x.from && x.to ? '<div class="lc-act"><a href="' + esc(liveSimbrief(x)) + '" target="_blank" rel="noopener" title="Ouvre SimBrief avec le même départ, la même arrivée et le même avion">✈ Copier dans SimBrief</a><span class="muted small">' + esc(x.from) + ' → ' + esc(x.to) + (x.ac ? ' · ' + esc(x.ac) : '') + '</span></div>' : '') +
    '</div>').join('') + '</div>'
    : '<div class="empty">' + (S.live.ready ? 'Personne ne vole en ce moment. Dès qu’un pilote lance un vol avec le tracker, il apparaît ici.' : 'Pour voir les autres pilotes, mets ton nom de pilote dans les Réglages.') + '</div>';
  renderLiveMap();
}
function renderLiveMap() {
  const svg = $('liveMap'); if (!svg || !$('tab-ligne').classList.contains('on')) return;
  mapSkeleton(svg);
  if (!liveVB) liveVB = VIEWS.europe.slice();
  const [x, y, w, h] = liveVB;
  const ratio = (svg.clientHeight || 420) / (svg.clientWidth || 1000);
  const hh = w * ratio, yy = y + h / 2 - hh / 2;
  liveVB = [x, yy, w, hh];
  svg.setAttribute('viewBox', liveVB.join(' '));
  const ppu = (svg.clientWidth || 1000) / w;
  applyLayers(svg, 'ligne', [1, 0, 0, 1, 0, 0], [x, yy, x + w, yy + hh], ppu, () => renderLiveMap());
  const k = Math.pow(w / 360, 0.6), sat = S.layers.ligne.sat;
  const ink = sat ? '#fff' : '#0A1E4A', halo = sat ? '#0A1E4A' : '#fff';
  let h2 = '';
  for (const p of S.live.list || []) {
    const on = p.id === S.live.sel, sz = 0.42 * k * (on ? 1.5 : 1);
    const col = p.mine ? '#C8102E' : (on ? '#E0A800' : (sat ? '#fff' : '#0A1E4A'));
    h2 += '<g class="pl" data-livesel="' + esc(p.id) + '" transform="translate(' + MX(p.lon).toFixed(3) + ' ' + MY(p.lat).toFixed(3) + ')"><title>' + esc(p.pseudo + ' · ' + (p.cs || '') + (p.from ? ' · ' + p.from + ' → ' + p.to : '')) + '</title>' +
      '<g transform="rotate(' + (p.hdg || 0) + ') scale(' + sz + ')"><circle r="7" fill="transparent"/><path d="' + PLANE + '" style="fill:' + col + ';stroke:' + halo + ';stroke-width:.6"/></g>' +
      '<text x="' + (2.6 * k) + '" y="' + (-1.6 * k) + '" font-size="' + (2.6 * k) + '" font-weight="700" fill="' + ink + '" paint-order="stroke" stroke="' + halo + '" stroke-width="' + (0.7 * k) + '">' + esc(p.pseudo) + (p.cs ? ' · ' + esc(p.cs) : '') + '</text></g>';
  }
  svg.querySelector('.fg').innerHTML = h2;
  const credit = ['Fond : Natural Earth'];
  if (sat) credit.push('Satellite : NASA GIBS');
  if (S.layers.ligne.radar) credit.push('Radar : RainViewer');
  $('liveCredit').textContent = credit.join(' · ');
}
function setLiveView(vb) {
  liveVB = vb;
  document.querySelectorAll('[data-liveview]').forEach((b) => b.classList.toggle('on', VIEWS[b.dataset.liveview].join() === vb.join()));
  renderLiveMap();
}
document.addEventListener('click', (e) => {
  const v = e.target.closest('[data-liveview]'); if (v) { setLiveView(VIEWS[v.dataset.liveview].slice()); return; }
  const s = e.target.closest('[data-livesel]'); if (!s) return;
  const p = (S.live.list || []).find((x) => x.id === s.dataset.livesel); if (!p) return;
  S.live.sel = p.id;
  // la carte se centre sur l'avion choisi
  if (s.closest('.live-card')) { const w = Math.min(liveVB[2], 40), h = w * (liveVB[3] / liveVB[2]); setLiveView([MX(p.lon) - w / 2, MY(p.lat) - h / 2, w, h]); }
  renderLive();
});
(function liveMapControls() {
  const svg = $('liveMap');
  const toMap = (ev) => { const r = svg.getBoundingClientRect(); return [liveVB[0] + ((ev.clientX - r.left) / r.width) * liveVB[2], liveVB[1] + ((ev.clientY - r.top) / r.height) * liveVB[3]]; };
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [mx, my] = toMap(ev);
    const f = ev.deltaY > 0 ? 1.25 : 0.8;
    const w = Math.min(360, Math.max(2, liveVB[2] * f)); const h = w * (liveVB[3] / liveVB[2]);
    setLiveView([mx - (mx - liveVB[0]) * (w / liveVB[2]), my - (my - liveVB[1]) * (h / liveVB[3]), w, h]);
  }, { passive: false });
  let drag = null;
  svg.addEventListener('mousedown', (e) => e.preventDefault());
  svg.addEventListener('pointerdown', (ev) => { if (ev.target.closest('.pl')) return; drag = { x: ev.clientX, y: ev.clientY, vb: liveVB.slice() }; svg.setPointerCapture(ev.pointerId); });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    setLiveView([drag.vb[0] - ((ev.clientX - drag.x) / r.width) * drag.vb[2], drag.vb[1] - ((ev.clientY - drag.y) / r.height) * drag.vb[3], drag.vb[2], drag.vb[3]]);
  });
  svg.addEventListener('pointerup', () => { drag = null; });
})();
setTimeout(loadLive, 4000); // pastille du menu : nombre de pilotes en vol

// ---------------- hangar : la flotte de la compagnie (état, aéroport, usure, maintenance, historique) ----------------
S.hg = { fleet: [], log: [], bookings: [], admin: false, error: '', at: 0, sel: null, filter: 'tous', msg: '' };
// Programme des vols d'un autre jour (mise à jour du matin pas encore faite) : renvoie sa date, sinon ''
function planStale() {
  const d = S.plan2.data; if (!d || !d.day) return '';
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  return d.day === today ? '' : new Date(d.day + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
async function loadHangar(force) {
  if (!force && Date.now() - S.hg.at < 60000) return;
  S.hg.at = Date.now();
  try {
    const r = await afv.hangarGet();
    if (r && r.ok) Object.assign(S.hg, { fleet: r.fleet || [], log: r.log || [], bookings: r.bookings || [], admin: !!r.admin, error: '' });
    else S.hg.error = (r && r.error) || 'Serveur injoignable.';
  } catch (e) { S.hg.error = 'Serveur injoignable.'; }
  if (S.hg.bookings.length || !S.hg.error) S.plan2.book.list = S.hg.bookings.length ? S.hg.bookings : S.plan2.book.list;
  renderHangar();
  if ($('tab-planning').classList.contains('on')) renderPlanning();
}
const hangarState = (reg) => (S.hg.fleet || []).find((a) => a.reg === reg) || null;
const hDur = (min) => { min = Math.round(min || 0); return Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0'); };
const hWhen = (t) => { const d = new Date(t), n = new Date(); const y = new Date(n); y.setDate(n.getDate() - 1);
  const day = d.toDateString() === n.toDateString() ? 'Auj.' : d.toDateString() === y.toDateString() ? 'Hier' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return day + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
function hgStatus(a) {
  const b = (S.hg.bookings || []).find((x) => x.reg === a.reg && x.until > Date.now());
  if (!a.active) return { k: 'off', t: 'Retiré de la flotte' };
  if (b && b.maint) return { k: 'mt', t: '🔧 En maintenance', b };
  if (b) return { k: 'fly', t: b.mine ? '✈ Piloté par toi' : '✈ Piloté par ' + b.pseudo, b };
  if (+a.condition < 60) return { k: 'mt', t: '⛔ Cloué au sol' };
  return { k: 'ok', t: '● Disponible' };
}
function renderHangar() {
  const n = (S.hg.fleet || []).filter((a) => hgStatus(a).k === 'mt').length;
  const bd = $('hangarBadge'); if (bd) { bd.hidden = !n; bd.textContent = n; }
  if (!$('tab-hgc').classList.contains('on')) return;
  const F = S.hg.fleet || [];
  if (S.hg.error && !F.length) { $('hgSub').textContent = S.hg.error; $('hgFleet').innerHTML = '<div class="empty">' + esc(S.hg.error) + '</div>'; $('hgKpis').innerHTML = ''; $('hgHist').innerHTML = ''; $('hgDir').hidden = true; return; }
  const st = F.map((a) => [a, hgStatus(a)]);
  const cnt = (k) => st.filter(([, x]) => x.k === k).length;
  const mts = st.filter(([, x]) => x.k === 'mt' && x.b).map(([, x]) => x.b.until).sort((x, y) => x - y);
  $('hgSub').textContent = 'La flotte des Ailes Tricolores · ' + F.filter((a) => a.active).length + ' avion' + (F.length > 1 ? 's' : '') + ' · mis à jour en direct';
  $('hgKpis').innerHTML = [['Disponibles', cnt('ok'), cnt('ok') > 1 ? 'prêts à voler' : 'prêt à voler'], ['Pris par un pilote', cnt('fly'), cnt('fly') ? 'en préparation ou en vol' : 'aucun pour le moment'],
    ['En maintenance', cnt('mt'), mts.length ? 'premier retour à ' + hLocal(mts[0]) : 'aucune'], ['Heures de flotte', Math.round(F.reduce((t, a) => t + (a.minutes || 0), 0) / 60) + ' h', F.reduce((t, a) => t + (a.cycles || 0), 0) + ' vols au total']]
    .map(([k, v, s2]) => '<div class="hg-kpi"><div class="k">' + k + '</div><b>' + v + '</b><span>' + esc(s2) + '</span></div>').join('');
  if (!S.hg.sel || !hangarState(S.hg.sel)) S.hg.sel = F.length ? F[0].reg : null;
  const shown = st.filter(([, x]) => S.hg.filter === 'tous' || (S.hg.filter === 'dispo' ? x.k === 'ok' : x.k === 'mt'));
  const img = (reg) => { const c = (S.plan2.company || []).find((x) => x.reg === reg); return c && c.image ? c.image : ''; };
  $('hgFleet').innerHTML = shown.length ? shown.map(([a, x]) => {
    const c = Math.round(+a.condition), col = c >= 80 ? '#3DBA6A' : c >= 60 ? '#E0A800' : '#C8102E';
    const lf = a.last_flight;
    const lastMaint = (S.hg.log || []).find((l) => l.reg === a.reg && l.kind === 'maintenance');
    const box = x.k === 'mt' && x.b ? '<div class="hg-box mt">🔧 <div><b>' + esc(lastMaint ? lastMaint.note : 'Maintenance') + '</b><br><span class="small">Disponible à ' + hLocal(x.b.until) + '</span></div><div class="hg-cd" data-cd="' + x.b.until + '"></div></div>'
      : x.k === 'mt' ? '<div class="hg-box mt">⛔ <div><b>Cloué au sol</b> : état ' + c + ' %. La direction doit terminer sa remise en état.</div></div>'
      : x.k === 'fly' ? '<div class="hg-box fly"><div><b>' + esc(x.t.replace('✈ ', '')) + '</b> jusqu’à ' + hLocal(x.b.until) + ' au plus tard.</div></div>'
      : x.k === 'ok' ? '<div class="hg-box ok"><div><b>Prêt à voler</b> depuis ' + esc(a.location) + '. Le prochain vol doit partir de là.</div></div>' : '';
    return '<div class="hg-ac' + (a.reg === S.hg.sel ? ' sel' : '') + (a.active ? '' : ' off') + '" data-hgsel="' + esc(a.reg) + '" role="button" tabindex="0" aria-pressed="' + (a.reg === S.hg.sel) + '">' +
      '<div class="img" style="background-image:url(\'' + esc(img(a.reg)) + '\')"><span class="st hg-st ' + x.k + '">' + esc(x.t) + '</span></div><div class="bd">' +
      '<div class="row between"><div><div class="reg">' + esc(a.reg) + '</div><div class="ty">' + esc([a.label || a.type, a.engine, a.sim].filter(Boolean).join(' · ')) + '</div></div><div class="hg-loc">📍 <b>' + esc(a.location) + '</b></div></div>' + box +
      '<div><div class="hg-cond">État de l’avion <span>' + c + ' %</span></div><div class="hg-bar"><i style="width:' + c + '%;background:' + col + '"></i></div></div>' +
      '<div class="hg-g3"><div><div class="k">Heures</div><b>' + hDur(a.minutes) + '</b></div><div><div class="k">Vols</div><b>' + (a.cycles || 0) + '</b></div><div><div class="k">Grande visite</div><b>dans ' + Math.max(0, Math.round((150 * 60 - (a.since_check || 0)) / 60)) + ' h</b></div></div>' +
      '<div class="muted small">' + (lf ? 'Dernier vol : ' + esc(lf.callsign || '—') + ' ' + esc(lf.dep || '') + ' → ' + esc(lf.arr || '') + ' par ' + esc(lf.pilot || '?') + ', ' + hWhen(lf.at) : 'Aucun vol pour le moment') + '</div>' +
      '<div class="row">' + (x.k === 'ok' ? '<button class="btn small red" data-hgtake="' + esc(a.reg) + '">Préparer un vol avec ' + esc(a.reg) + '</button>' : x.k === 'mt' && x.b ? '<button class="btn small ghost" disabled>Disponible à ' + hLocal(x.b.until) + '</button>' : '') + '</div>' +
      '</div></div>';
  }).join('') : '<div class="empty">Aucun avion dans cette catégorie.</div>';
  // historique de l'avion choisi
  const L = (S.hg.log || []).filter((l) => l.reg === S.hg.sel).slice(0, 12);
  $('hgHist').innerHTML = '<div class="row between"><h2>Historique de ' + esc(S.hg.sel || '') + '</h2><span class="sub">vols et maintenances</span></div>' + (L.length ? '<table class="hg-hist"><thead><tr><th>Date</th><th>Événement</th><th>Pilote</th><th class="r">Durée</th><th class="r">État</th></tr></thead><tbody>' +
    L.map((l) => {
      const ev = l.kind === 'vol' ? '<b>✈ ' + esc(l.callsign || 'Vol') + '</b> ' + esc(l.dep) + ' → ' + esc(l.arr) + (l.rate != null ? ' · atterrissage ' + l.rate + ' ft/min' : '')
        : l.kind === 'maintenance' ? '<b>🔧 Maintenance</b> · ' + esc(l.note) : '<b>Direction</b> · ' + esc(l.note);
      const cs = l.cond_before != null && l.cond_after != null ? (l.kind === 'maintenance' ? Math.round(l.cond_before) + ' % → ' + Math.round(l.cond_after) + ' %' : (l.cond_after - l.cond_before >= 0 ? '+' : '−') + Math.abs(Math.round((l.cond_after - l.cond_before) * 10) / 10) + ' %') : '';
      return '<tr><td>' + hWhen(l.at) + '</td><td>' + ev + '</td><td>' + esc(l.pilot) + '</td><td class="r">' + (l.minutes ? (l.minutes >= 60 ? hDur(l.minutes) : l.minutes + ' min') : '') + '</td><td class="r">' + cs + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="muted">Pas encore d’historique pour cet avion.</p>');
  // barre de la direction
  const sel = hangarState(S.hg.sel);
  $('hgDir').hidden = !S.hg.admin;
  if (S.hg.admin && sel) $('hgDir').innerHTML = '<span class="t">DIRECTION · ' + esc(sel.reg) + '</span>' +
    '<button data-hgadm="end_maint">Terminer la maintenance</button>' +
    '<input id="hgMove" maxlength="4" placeholder="OACI" aria-label="Aéroport où déplacer l’avion"><button data-hgadm="move">Déplacer</button>' +
    '<button data-hgadm="' + (sel.active ? 'retire' : 'restore') + '">' + (sel.active ? 'Retirer de la flotte' : 'Remettre dans la flotte') + '</button>' +
    '<span style="width:12px"></span><input id="hgAddReg" maxlength="10" placeholder="F-HL.." aria-label="Immatriculation du nouvel avion"><select id="hgAddType" aria-label="Type du nouvel avion"><option value="A320">A320</option><option value="B77W">777-300ER</option></select><button data-hgadm="add">+ Ajouter un avion</button>' +
    (S.hg.msg ? '<span class="msg">' + esc(S.hg.msg) + '</span>' : '');
  tickHangar();
}
function tickHangar() {
  document.querySelectorAll('[data-cd]').forEach((el) => {
    const s2 = Math.max(0, Math.round((+el.dataset.cd - Date.now()) / 1000));
    el.textContent = String(Math.floor(s2 / 3600)).padStart(2, '0') + ':' + String(Math.floor(s2 / 60) % 60).padStart(2, '0') + ':' + String(s2 % 60).padStart(2, '0');
    if (!s2 && !el.dataset.done) { el.dataset.done = 1; loadHangar(true); }
  });
}
setInterval(() => { if ($('tab-hgc').classList.contains('on')) tickHangar(); }, 1000);
setInterval(() => { if ($('tab-hgc').classList.contains('on')) loadHangar(true); }, 60000);
setTimeout(() => loadHangar(true), 5000);
document.addEventListener('click', async (e) => {
  const f = e.target.closest('[data-hgf]');
  if (f) { S.hg.filter = f.dataset.hgf; document.querySelectorAll('[data-hgf]').forEach((x) => { x.classList.toggle('on', x === f); x.setAttribute('aria-pressed', String(x === f)); }); renderHangar(); return; }
  const t = e.target.closest('[data-hgtake]');
  if (t) { S.plan2.myReg = t.dataset.hgtake; S.plan2.variant = 0; showTab('planning'); return; }
  const a = e.target.closest('[data-hgadm]');
  if (a && S.hg.sel) {
    const act = a.dataset.hgadm;
    let reg = S.hg.sel, val = null, type = null;
    if (act === 'move') { val = ($('hgMove').value || '').trim().toUpperCase(); if (!/^[A-Z]{4}$/.test(val)) { S.hg.msg = 'Indique un code OACI de 4 lettres.'; renderHangar(); return; } }
    if (act === 'add') { reg = ($('hgAddReg').value || '').trim().toUpperCase(); type = $('hgAddType').value; val = type === 'B77W' ? 'Boeing 777-300ER' : 'Airbus A320'; if (!/^[A-Z0-9-]{3,10}$/.test(reg)) { S.hg.msg = 'Immatriculation invalide.'; renderHangar(); return; } }
    a.disabled = true;
    const r = await afv.hangarAdmin(act, reg, val, type);
    S.hg.msg = r && r.ok ? 'Fait.' : (r && r.error) || 'Échec.';
    if (act === 'add' && r && r.ok) S.hg.sel = reg;
    await loadHangar(true); await loadBookings(true);
    return;
  }
  const s2 = e.target.closest('[data-hgsel]');
  if (s2 && !e.target.closest('button')) { S.hg.sel = s2.dataset.hgsel; S.hg.msg = ''; renderHangar(); }
});

// Ma journée : charger le plan SimBrief / aller au tracker
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-dayload]')) {
    const b = e.target.closest('[data-dayload]'); b.disabled = true; b.textContent = 'Chargement…';
    S.plan2.dayErr = '';
    try { S.plan = await afv.loadSimbrief(); renderPlan(); renderMissionHint(); } catch (err) { S.plan2.dayErr = String((err && err.message) || err).replace(/^Error:\s*/, ''); }
    renderPlanning(); return;
  }
  if (e.target.closest('[data-daygo]')) showTab('vol');
});

document.addEventListener('click', (e) => { const o = e.target.closest('[data-tab-open]'); if (o) showTab(o.dataset.tabOpen); });

document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-dayclear]')) return;
  const d = S.plan2.data; if (!d) return;
  for (const k of d.mine.slice()) S.plan2.data = await afv.togglePlanning(k);
  renderPlanning();
});

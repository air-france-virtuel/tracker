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
  if (name === 'stats') loadStats();
  if (name === 'vol') renderDayNext(true);
  if (name === 'livrees') loadLiveries(false);
  if (name === 'infos' || name === 'ligne') loadLive();
  if (name === 'planning') loadPlanning(false);
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
// Annonce passée (par le tracker ou par Universal Announcer) : la case correspondante de la check-list se coche toute seule
const ANN_CHECK = { boarding_welcome: [0, 'pax'], descent_start: [5, 'pax'] };
function annDone(key) {
  const m = ANN_CHECK[key];
  if (!m || !S.ck || S.ck.phase !== m[0]) return;
  const it = S.ck.items.find((i) => i.id === m[1]);
  if (!it || it.done) return;
  it.done = true; it.by = 'ann';
  S.ck.complete = S.ck.items.every((i) => i.done);
  if (S.ck.complete && !S.ckDoneSaid) { S.ckDoneSaid = true; maxSays('Check-list ' + S.ck.say + ' terminée.'); } else pushMax();
}
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
      annDone(item.key);
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
    prompt: S.maxPrompt ? { text: S.maxPrompt.text, yes: S.maxPrompt.yes, no: S.maxPrompt.no } : null,
    ck: S.ck ? { title: S.ck.title, complete: S.ck.complete, items: S.ck.items.map((i) => ({ id: i.id, text: i.text, help: i.help, done: i.done, by: i.by })) } : null
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
// Question posée à Max (panneau par-dessus le simu ou tracker) : réponse à voix haute avec les données du vol
function askMax(q) {
  q = String(q || '').slice(0, 160);
  const r = AskMax.answer(q, { pistes: S.pistes, t: S.lastT, plan: S.plan, route: S.route, ops: S.ops, tod: S.phase != null && S.phase < 5 ? S.lastTod : null, phase: S.phase, phaseName: S.flight && S.phase != null ? PHASES[S.phase] : '', ck: S.ck, now: Date.now() });
  S.maxHist = (S.maxHist || []).concat([{ time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), text: 'Toi : ' + q }]).slice(-4);
  maxStop(); maxSays(r.text);
}
$('maxAskForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('maxAsk').value.trim(); if (q) { askMax(q); $('maxAsk').value = ''; } });
afv.on('max:state', (on) => { S.maxWin = !!on; $('btnMaxOverlay').textContent = on ? 'Fermer Max par-dessus le simu' : 'Max par-dessus le simu'; if (on) pushMax(); });
afv.on('max:action', (a) => {
  if (a.type === 'ready') pushMax();
  else if (a.type === 'check' && S.ck) { Checklists.toggle(S.ck, a.id); if (S.ck.complete && !S.ckDoneSaid) { S.ckDoneSaid = true; maxSays('Check-list ' + S.ck.say + ' terminée.'); } else pushMax(); }
  else if (a.type === 'mute') $('btnMaxMute').click();
  else if (a.type === 'prompt') answerPrompt(a.answer === 'yes');
  else if (a.type === 'listen') maxStop();
  else if (a.type === 'ask' && S.maxPrompt && /^\s*(oui|ouais|ok|okay|d.accord|vas-y|go|volontiers|non|pas maintenant|plus tard|non merci)\b/i.test(AskMax.norm(a.q))) answerPrompt(!/^\s*(non|pas maintenant|plus tard)/i.test(AskMax.norm(a.q)));
  else if (a.type === 'ask' && a.voice) { const q = AskMax.fromSpeech(a.q); if (q) askMax(q); else maxSays('Je n’ai pas bien entendu. Tu peux répéter ?'); }
  else if (a.type === 'ask') askMax(a.q);
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
S.layers = { vol: { sat: false, radar: false }, ligne: { sat: false, radar: false } };
// Squelette d'une carte : océan, satellite, terres, radar, puis le dessin du vol par-dessus.
function mapSkeleton(svg) {
  if (svg.querySelector('.fg')) return;
  svg.innerHTML = '<rect class="ocean" x="-2000" y="-2000" width="5000" height="5000" fill="#DCE6F5"/><g class="sat"></g>' +
    '<path class="landp" d="' + (window.WORLD_PATH || '') + '" fill="#F7F9FC" stroke="#B8C4DA" stroke-width="0.8" vector-effect="non-scaling-stroke"/><g class="radar"></g><g class="labels"></g><g class="apts"></g><g class="fg"></g>';
}
// Applique les fonds (plan / satellite / radar) à une carte : m = matrice Mercator → écran, view = zone visible.
function applyLayers(svg, which, m, view, ppu, redraw) {
  const L = S.layers[which];
  const mat = 'matrix(' + m.join(' ') + ')';
  for (const sel of ['.sat', '.landp', '.radar', '.labels', '.apts']) svg.querySelector(sel).setAttribute('transform', mat);
  svg.querySelector('.ocean').setAttribute('fill', L.sat ? '#0B1F3F' : '#DCE6F5');
  const land = svg.querySelector('.landp');
  land.setAttribute('fill', L.sat ? 'none' : '#F7F9FC');
  land.setAttribute('stroke', L.sat ? 'rgba(255,255,255,.55)' : '#B8C4DA');
  const res = MapLayers.fill(svg.querySelector('.sat'), { view, pxPerUnit: ppu, sat: L.sat, plan: !L.sat, radar: false, onReady: redraw }) || {};
  MapLayers.fill(svg.querySelector('.radar'), { view, pxPerUnit: ppu, sat: false, radar: L.radar, onReady: redraw });
  // satellite : noms des pays et des villes, frontières et routes par-dessus l'image, comme sur le plan, et les aéroports de la compagnie
  MapLayers.fill(svg.querySelector('.labels'), { view, pxPerUnit: ppu, labels: !!L.sat, onReady: redraw });
  drawAirports(svg.querySelector('.apts'), L.sat ? view : null, ppu);
  // zoomé : le plan détaillé ou le satellite remplace les contours simplifiés (qui ne tombent plus pile sur les côtes)
  if (res.plan) { land.setAttribute('fill', 'none'); land.setAttribute('stroke', 'none'); }
  else if (L.sat && res.z >= 6) land.setAttribute('stroke', 'none');
  svg.dataset.credit = MapLayers.credit(L, res);
  return res;
}
// Aéroports de la compagnie sur la carte satellite : un point et le code OACI, le nom de la ville quand on zoome.
// Tailles en pixels écran (pxu = pixels par unité Mercator), pour rester lisibles à tous les zooms.
S.apts = null;
function drawAirports(g, view, pxu) {
  if (!view || !S.apts || !pxu) { if (g.dataset.key) { g.textContent = ''; g.dataset.key = ''; } return; }
  const key = view.map((v) => v.toFixed(4)).join(',') + '|' + pxu.toFixed(3);
  if (g.dataset.key === key) return;
  g.dataset.key = key;
  const u = 1 / pxu, showCode = pxu > 2.5, showCity = pxu > 60;
  let h = '';
  for (const [icao, a] of Object.entries(S.apts)) {
    const x = MapLayers.LX(a.lon), y = MapLayers.LY(a.lat);
    if (x < view[0] - 1 || x > view[2] + 1 || y < view[1] - 1 || y > view[3] + 1) continue;
    h += '<g transform="translate(' + x + ' ' + y + ')"><circle r="' + (3.2 * u) + '" fill="#FFD45C" stroke="#0A1E4A" stroke-width="' + (1.2 * u) + '"/>' +
      (showCode ? '<text x="' + (5 * u) + '" y="' + (3.6 * u) + '" font-size="' + (11 * u) + '" font-weight="700" fill="#fff" stroke="#0A1E4A" stroke-width="' + (2.6 * u) + '" paint-order="stroke">✈ ' + esc(icao) + (showCity ? ' · ' + esc(a.city || a.name) : '') + '</text>' : '') + '</g>';
  }
  g.innerHTML = h;
}
afv.genGet().then((r) => { S.apts = r && r.airports; }).catch(() => {});
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
  else if (sat) h2 += '<text x="592" y="292" text-anchor="end" font-size="10" fill="#fff">Images : Sentinel-2 cloudless (EOX)</text>';
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
  if (which === 'vol') renderMap(null); else if (which === 'ligne') renderLiveMap();
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
  const MIN = 0.6, MAX = 20000;
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
    '<div class="full"><div class="k">Pistes en service (trafic réel, NOTAM, vent)</div><div id="pistesBox" class="pistes">' + pistesHtml() + '</div></div>' +
    (p.demo ? '<div class="full muted small">Plan de démonstration.</div>' : '');
  if (!p.demo && (!S.pistes || S.pistes.for !== planKey(p))) refreshPistes(false, true);
}
// ---------- pistes en service : trafic réel autour de l'aéroport, pistes fermées par NOTAM, vent ----------
const planKey = (p) => p ? p.origin.icao + '-' + p.destination.icao + '-' + (p.origin.rwy || '') + '-' + (p.destination.rwy || '') : '';
const SRC = { trafic: 'vue sur le trafic réel', sens: 'même sens que le trafic', vent: 'la plus face au vent', plan: 'pas de trafic ni de vent net : piste du plan' };
function pisteLine(d, label) {
  if (!d) return '<div class="muted small">' + label + ' : recherche…</div>';
  if (!d.rwy) return '<div class="muted small">' + label + ' ' + esc(d.icao) + ' : ' + esc(d.error || 'piste en service inconnue pour le moment') + '</div>';
  const warn = d.planClosed ? 'la piste ' + d.planRwy + ' du plan est fermée (NOTAM)' : d.reversed ? 'ton plan SimBrief prévoit la ' + d.planRwy + ', dans l’autre sens' : d.differs ? 'plan : ' + d.planRwy + ' (parallèle)' : '';
  const shut = (d.closed || []).map((c) => c.rwy + (c.partial ? ' (partiellement)' : '')).filter((x, i, a) => a.indexOf(x) === i);
  return '<div class="pl' + (d.planClosed || d.reversed ? ' bad' : d.differs ? ' warn' : ' ok') + '"><b>' + label + ' ' + esc(d.icao) + ' : ' + esc(d.rwy) + '</b> <span class="muted small">' + esc(SRC[d.source] || '') + (d.source === 'trafic' && d.detail ? ' : ' + esc(d.detail) : d.source === 'vent' && d.detail ? ' (' + esc(d.detail) + ')' : '') + '</span>' +
    (warn ? '<div class="small">⚠ ' + esc(warn) + '</div>' : '') + (shut.length ? '<div class="small muted">Fermée par NOTAM : ' + esc(shut.join(', ')) + '</div>' : '') + '</div>';
}
function pistesHtml() {
  const P = S.pistes;
  if (!P) return '<div class="muted small">Recherche des pistes en service…</div>';
  return pisteLine(P.dep, 'Départ') + pisteLine(P.arr, 'Arrivée') + '<div class="small muted">Mis à jour à ' + hLocal(P.at) + ' · <button class="linkbtn" data-pistes-refresh>Actualiser</button></div>';
}
async function refreshPistes(force, announce) {
  const p = S.plan; if (!p || p.demo) return null;
  const key = planKey(p);
  let r = null;
  try { r = await afv.getPistes(p, force); } catch (e) { r = null; }
  if (!r || planKey(S.plan) !== key) return null;
  S.pistes = Object.assign({ for: key, at: Date.now() }, r);
  const box = $('pistesBox'); if (box) box.innerHTML = pistesHtml();
  if (announce) {
    const warn = [r.dep, r.arr].filter((d) => d && d.rwy && (d.planClosed || d.reversed));
    if (warn.length) { const txt = warn.map((d) => d.say).join(' '); addAlert('Pistes en service', txt, 'red'); maxSays(txt); }
  }
  return S.pistes;
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-pistes-refresh]')) { const b = $('pistesBox'); if (b) b.innerHTML = '<div class="muted small">Recherche des pistes en service…</div>'; refreshPistes(true, false); } });
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
  S.waitStart = null;
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
  S.posCheck = mode !== 'demo';
  if (S.store && S.store.settings.maxOverlay !== false) await openMax();
  maxSays(adviceFor(0));
  startChecklist(0);
  playPhaseAnnouncements(0);
  if (mode !== 'demo' && S.plan) refreshPistes(true, false).then((P) => { if (P && P.dep && P.dep.say) setTimeout(() => maxSays(P.dep.say), 12000); });
}
// Le tracker a été fermé en plein vol (ou la fenêtre rouverte) : on reprend le vol là où il en était.
async function resumeFlight(fl) {
  S.plan = fl.plan || S.plan;
  S.flight = { mode: fl.mode, aircraft: fl.aircraft };
  S.phase = fl.phase; S.trail = []; queue.length = 0;
  opsReset();
  $('alerts').innerHTML = '';
  $('prep').hidden = true; $('live').hidden = false; $('btnStop').hidden = false;
  const curM = fl.missionId && S.career ? S.career.missions.find((m) => m.id === fl.missionId) : null;
  $('flightSub').textContent = (curM ? 'Mission : ' + curM.title + ' · ' : '') + (S.plan ? (S.plan.callsign || '') + ' · ' + S.plan.origin.icao + ' → ' + S.plan.destination.icao : 'Vol sans plan SimBrief') + (fl.aircraft ? ' · ' + fl.aircraft : '');
  S.lastPos = null;
  renderPhases(fl.phase); renderMap(null); renderTod(null, fl.phase);
  afv.voicePreload();
  renderMaxVoiceHint();
  $('maxPhase').textContent = 'Phase : ' + PHASES[fl.phase];
  S.maxHist = []; S.co = Callouts.create();
  if (S.store && S.store.settings.maxOverlay !== false) await openMax();
  startChecklist(fl.phase);
  S.resumeSay = Date.now();
  maxSays('Je reprends le vol' + (S.plan ? ' ' + S.plan.origin.icao + ' vers ' + S.plan.destination.icao : '') + ' là où on en était : phase ' + PHASES[fl.phase].toLowerCase() + '.' + (S.simOk ? '' : ' J’attends que le simulateur soit reconnecté.'));
}
// Dès que la position revient du simulateur, Max dit où on en est.
function resumeWhere() {
  if (!S.resumeSay || !S.ops) return;
  S.resumeSay = 0;
  const ctx = { t: S.lastT, plan: S.plan, route: S.route, ops: S.ops, tod: S.phase != null && S.phase < 5 ? S.lastTod : null, phase: S.phase, phaseName: PHASES[S.phase], ck: S.ck, now: Date.now() };
  const parts = [AskMax.answer('distance', ctx).text];
  if (S.ops.next) parts.push(AskMax.answer('prochain point', ctx).text);
  if (S.phase != null && S.phase < 5 && S.lastTod && S.lastTod.distNm != null) parts.push(AskMax.answer('tod', ctx).text);
  maxSays(parts.join(' '));
}
$('btnStart').addEventListener('click', async () => { if (!S.simOk) { await loadPlanForStart(); waitForSim(); return; } $('btnStart').disabled = true; try { await loadPlanForStart(); await startFlight('sim'); } finally { $('btnStart').disabled = false; } });
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
  if (!S.flight && S.waitStart && d.t) { waitTick(d.t); return; }
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
  if (S.resumeSay) resumeWhere();
  // au début du vol : l'avion est-il bien à l'aéroport de départ du plan chargé ?
  if (S.posCheck && S.plan && t.onGround && S.plan.origin.lat) {
    S.posCheck = false;
    const dnm = hav(t, S.plan.origin);
    if (dnm > 10) { const txt = 'Attention : ton avion n’est pas à ' + S.plan.origin.icao + ', le départ du plan SimBrief chargé (' + S.plan.origin.icao + ' → ' + S.plan.destination.icao + '). Vérifie que tu as généré le bon vol.'; addAlert('Plan de vol', txt, 'red'); maxSays(txt); }
  } else if (S.posCheck && t && !t.onGround) S.posCheck = false;
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
    if (e.phase === 4 && S.plan && !S.plan.demo) refreshPistes(true, false).then((P) => { if (P && P.arr && P.arr.say) setTimeout(() => maxSays(P.arr.say), 9000); });
    if (e.phase === 7) setTimeout(() => playPhaseAnnouncements(7), 12000); else playPhaseAnnouncements(e.phase);
  } else if (e.type === 'joined') {
    addAlert('Vol rejoint en cours de route', 'L’avion était déjà en vol : le suivi reprend directement en phase ' + PHASES[e.phase].toLowerCase() + '.');
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
    const next = (S.gen.day || []).filter((f) => !f.doneAt && f.from === arr && !(rep && f.from === rep.from && f.to === rep.to));
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
  if (r.mode !== 'demo') setTimeout(() => offerNextLeg(r), 14000); // après le message du hangar
  if (r.mission) maxSays(r.mission.validated ? 'Bravo commandant ! Mission validée, ' + r.mission.points + ' points de plus pour ta carrière.' : 'Mission non validée cette fois. ' + (r.mission.reason || ''));
});
// ---------- Arrivé à la gate : Max propose de préparer le vol suivant de « Ma journée » ----------
const samePlan = (p, f) => p && p.origin && p.destination && p.origin.icao === f.from && p.destination.icao === f.to;
function setPrompt(p) { S.maxPrompt = p; renderPrompt(); pushMax(); }
function renderPrompt() {
  const box = $('maxPrompt'); if (!box) return;
  const p = S.maxPrompt;
  box.hidden = !p;
  if (p) box.innerHTML = '<span>' + esc(p.text) + '</span><span class="row"><button class="btn small red" data-mprompt="yes">' + esc(p.yes) + '</button><button class="btn small ghost" data-mprompt="no">' + esc(p.no) + '</button></span>';
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-mprompt]'); if (b) answerPrompt(b.dataset.mprompt === 'yes'); });
function answerPrompt(yes) {
  const p = S.maxPrompt; if (!p) return;
  setPrompt(null);
  if (yes) p.onYes(); else if (p.onNo) p.onNo();
}
async function offerNextLeg(rep) {
  const gl = S.gen && S.gen.day && S.gen.flight && !S.gen.flight.doneAt && S.gen.day.some((l) => l.doneAt && l.from === rep.from && l.to === rep.to) ? S.gen.flight : null;
  if (gl) {
    if (S.flight) return;
    const i = S.gen.day.findIndex((l) => l.key === gl.key) + 1;
    const text = 'Bien arrivé à ' + rep.to + ' ! Vol suivant de ta journée, ' + i + ' sur ' + S.gen.day.length + ' : ' + gl.number + ', ' + gl.from + ' vers ' + gl.to + ', départ prévu ' + sayTime(gl.depEst) + '. Je prépare le plan de vol sur SimBrief ?';
    maxSays(text);
    setPrompt({ text: 'Préparer ' + gl.number + ' ' + gl.from + ' → ' + gl.to + ' sur SimBrief ?', yes: 'Oui, prépare-le', no: 'Plus tard', onYes: () => loadNextPlan(gl, gl.number), onNo: () => maxSays('D’accord. Il t’attend dans le Planning du jour.') });
    return;
  }
  const g = S.gen && S.gen.flight;
  if (g && g.from === rep.from && g.to === rep.to) {
    if (S.flight) return;
    S.gen.from = null; S.gen.seed++;
    const text = 'Bien arrivé à ' + rep.to + ' ! ' + (g.reg ? g.reg + ' reste à ' + rep.to + '. ' : '') + 'Je te propose d’autres vols au départ de ' + rep.to + ' ?';
    maxSays(text);
    setPrompt({ text: 'Voir les vols au départ de ' + rep.to + ' ?', yes: 'Oui, montre-moi', no: 'Plus tard', onYes: () => { showTab('planning'); genLoad(); }, onNo: () => maxSays('D’accord. Ils t’attendent dans le Planning du jour.') });
    return;
  }
  try { S.plan2.data = await afv.getPlanning(false); } catch (e) { /* hors ligne : on garde la dernière journée connue */ }
  const d = S.plan2.data; if (!d || !d.mine || !d.mine.length || S.flight) return;
  const byKey = Object.fromEntries(d.flights.map((f) => [f.key, f]));
  const mine = d.mine.map((k) => byKey[k]).filter(Boolean);
  if (!mine.some((f) => f.from === rep.from && f.to === rep.to)) return; // ce vol n'était pas dans la journée
  const nx = nextDayLeg();
  if (!nx) { maxSays('C’était le dernier vol de ta journée. Bravo commandant, bon repos !'); return; }
  const f = nx.f, own = companyPlane(S.plan2.myReg);
  const num = own ? String(f.number || f.callsign).replace(/^AF\s?/, 'LAT') : (f.number || f.callsign);
  const text = 'Bien arrivé à ' + rep.to + ' ! Prochain vol de ta journée : ' + num + ', ' + f.from + ' vers ' + f.to + (f.depEst ? ', départ prévu ' + hhZ(f.depEst) : '') + '. Je prépare le plan de vol sur SimBrief ?';
  maxSays(text);
  setPrompt({ text: 'Préparer ' + num + ' ' + f.from + ' → ' + f.to + ' sur SimBrief ?', yes: 'Oui, prépare-le', no: 'Plus tard', onYes: () => loadNextPlan(f, num), onNo: () => maxSays('D’accord. Tu le retrouves dans « Ma journée » quand tu veux.') });
}
// Prépare le vol suivant : si le plan est déjà fait sur SimBrief, Max le charge tout de suite ; sinon il ouvre
// SimBrief déjà rempli et charge le plan tout seul dès que le pilote a cliqué sur « Generate Flight ».
async function loadNextPlan(f, num) {
  clearInterval(S.nextPoll);
  const tryLoad = async () => { try { const p = await afv.loadSimbrief(); if (samePlan(p, f)) { S.plan = p; renderPlan(); renderMissionHint(); renderDayNext(); return true; } } catch (e) { /* pas encore de plan ou SimBrief injoignable */ } return false; };
  const done = () => maxSays('Plan ' + num + ' ' + f.from + ' → ' + f.to + ' chargé dans le tracker' + (S.plan.fuelPlanKg ? ', carburant prévu ' + Math.round(S.plan.fuelPlanKg).toLocaleString('fr-FR') + ' kilos' : '') + '. Place l’avion à ' + f.from + ' et démarre le suivi quand tu es prêt.');
  if (await tryLoad()) { done(); return; }
  window.open(planSimbrief(f), '_blank');
  maxSays('J’ouvre SimBrief avec le vol ' + num + ' déjà rempli. Clique sur « Generate Flight » en bas de la page : je charge le plan tout seul dès qu’il est prêt.');
  const until = Date.now() + 20 * 60000;
  S.nextPoll = setInterval(async () => {
    if (S.flight || Date.now() > until) { clearInterval(S.nextPoll); return; }
    if (await tryLoad()) { clearInterval(S.nextPoll); done(); }
  }, 15000);
}
afv.on('fleet:changed', (f) => { S.store.fleet = f; renderFleet(); renderAircraftSelect(); });

// ---------------- ponctualité ----------------
const hhmmZ = (t) => new Date(t).toISOString().slice(11, 16) + 'Z';
function ponctLabel(p) {
  if (!p) return '';
  if (p.arrDelay < -1) return 'À l’heure (' + -p.arrDelay + ' min d’avance)';
  if (p.arrDelay <= 1) return 'Pile à l’heure';
  if (p.onTime) return 'À l’heure (+' + p.arrDelay + ' min)';
  return 'En retard de ' + (p.arrDelay >= 60 ? Math.floor(p.arrDelay / 60) + ' h ' + String(p.arrDelay % 60).padStart(2, '0') : p.arrDelay + ' min');
}
function ponctBox(p) {
  if (!p) return '';
  return '<div class="ponct ' + (p.onTime ? 'ok' : 'late') + '"><b>' + (p.onTime ? '⏱ ' : '⚠ ') + esc(ponctLabel(p)) + '</b><span>' + esc(p.number) + ' prévu ' + hhmmZ(p.schedDep) + ' → ' + hhmmZ(p.schedArr) +
    ' · réel ' + (p.actualOut ? hhmmZ(p.actualOut) : '—') + ' → ' + hhmmZ(p.actualIn) + (p.depDelay != null ? ' · départ ' + (p.depDelay > 0 ? '+' + p.depDelay + ' min' : p.depDelay < 0 ? p.depDelay + ' min' : 'à l’heure') : '') + '</span></div>';
}

function showReport(r) {
  const h = (m) => (m == null ? '—' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'));
  $('reportBody').innerHTML = '<div class="muted">' + esc(r.callsign || '') + ' ' + esc(r.from) + ' → ' + esc(r.to) + (r.aircraft ? ' · ' + esc(r.aircraft) : '') + '</div><div class="rep">' +
    [['Temps bloc', h(r.blockMinutes)], ['Temps de vol', h(r.flightMinutes)], ['Distance', fmt(r.distanceNm) + ' NM'], ['Carburant utilisé', r.fuelUsedKg == null ? '—' : fmt(r.fuelUsedKg) + ' kg'], ['Atterrissage', r.landingRate == null ? '—' : r.landingRate + ' ft/min'], ['Altitude max', 'FL' + Math.round(r.maxAlt / 100)]]
      .map(([k, v]) => '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('') + '</div>' + ponctBox(r.ponctualite) + missionResult(r.mission) + '<p class="muted small">Rapport enregistré dans « Mes vols ».</p>';
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
  const rated = list.filter((r) => r.mode !== 'demo' && r.ponctualite);
  const ok = rated.filter((r) => r.ponctualite.onTime).length;
  $('ponctHead').hidden = !rated.length;
  if (rated.length) {
    const avg = Math.round(rated.reduce((a, r) => a + r.ponctualite.arrDelay, 0) / rated.length);
    $('ponctHead').innerHTML = '<div class="ponct-pct">' + Math.round(ok / rated.length * 100) + ' %</div><div><b>Ta ponctualité</b><div class="muted small">' + ok + ' vol' + (ok > 1 ? 's' : '') + ' à l’heure sur ' + rated.length + ' vol' + (rated.length > 1 ? 's' : '') + ' du programme · écart moyen à l’arrivée ' + (avg > 0 ? '+' : '') + avg + ' min</div></div>';
  }
  $('reports').innerHTML = '<table><thead><tr><th>Date</th><th>Vol</th><th>Trajet</th><th>Appareil</th><th>Temps de vol</th><th>Atterrissage</th><th>Ponctualité</th><th>Mission</th></tr></thead><tbody>' +
    list.map((r) => '<tr><td>' + esc(new Date(r.date).toLocaleString('fr-FR')) + (r.mode === 'demo' ? ' (démo)' : '') + '</td><td>' + esc(r.flightNumber || r.callsign) + '</td><td>' + esc(r.from) + ' → ' + esc(r.to) + '</td><td>' + esc(r.aircraft) + '</td><td>' + (r.flightMinutes == null ? '—' : Math.floor(r.flightMinutes / 60) + ' h ' + String(r.flightMinutes % 60).padStart(2, '0')) + '</td><td>' + (r.landingRate == null ? '—' : r.landingRate + ' ft/min') + '</td>' +
      '<td>' + (r.ponctualite ? '<span class="pz ' + (r.ponctualite.onTime ? 'ok' : 'late') + '">' + esc(ponctLabel(r.ponctualite)) + '</span>' : '<span class="muted">—</span>') + '</td><td>' + (r.mission ? (r.mission.validated ? '✓ +' + r.mission.points + ' pts' : 'Non validée') : '—') + '</td></tr>').join('') + '</tbody></table>';
}
$('btnOpenReports').addEventListener('click', () => afv.openFolder('rapports'));
$('btnLogbook').addEventListener('click', async () => {
  const b = $('btnLogbook'); b.disabled = true; $('logbookMsg').textContent = 'Préparation du carnet de vol…';
  try {
    const r = await afv.logbookPdf();
    $('logbookMsg').textContent = r.ok ? 'Carnet de vol enregistré (' + r.flights + ' vol' + (r.flights > 1 ? 's' : '') + ') : ' + r.path : r.canceled ? '' : 'Le carnet n’a pas pu être créé : ' + (r.error || 'erreur inconnue');
    if (r.ok) maxSays('Ton carnet de vol est prêt : ' + r.flights + ' vol' + (r.flights > 1 ? 's' : '') + '. Il s’ouvre pour que tu puisses l’imprimer.');
  } catch (e) { $('logbookMsg').textContent = 'Le carnet n’a pas pu être créé.'; }
  b.disabled = false;
});

// ---------------- statistiques de la compagnie ----------------
const hmin = (m) => Math.floor((m || 0) / 60).toLocaleString('fr-FR') + ' h ' + String(Math.round(m || 0) % 60).padStart(2, '0');
async function loadStats() {
  $('statsSub').textContent = 'Chargement…';
  let r;
  try { r = await afv.getStats(); } catch (e) { r = { ok: false, error: String(e) }; }
  if (!r || !r.ok) {
    $('statsSub').textContent = 'Statistiques indisponibles pour le moment' + (S.store && S.store.settings.chat === false ? ' (la connexion à la communauté est désactivée dans les réglages)' : '') + '.';
    if (!$('stKpis').innerHTML) $('stKpis').innerHTML = '<div class="empty">Pas de connexion au serveur de la compagnie. Vérifie ta connexion internet puis clique sur « Actualiser ».</div>';
    return;
  }
  if (!S.latAirports) { try { S.plan2.data = S.plan2.data || await afv.getPlanning(false); S.latAirports = S.plan2.data.airports; } catch (e) { /* noms des villes facultatifs */ } }
  renderStats(r.stats || {});
}
function renderStats(st) {
  const m = st.month || {}, a = st.all || {};
  const pct = (o) => (o.rated ? Math.round(o.on_time / o.rated * 100) + ' %' : '—');
  const mois = new Date().toLocaleDateString('fr-FR', { month: 'long' });
  $('statsSub').textContent = 'Les vols de tous les pilotes des Ailes Tricolores · mis à jour à ' + new Date(st.generated_at || Date.now()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('stKpis').innerHTML = [
    ['Vols en ' + mois, (m.flights || 0).toLocaleString('fr-FR'), (a.flights || 0).toLocaleString('fr-FR') + ' depuis le début'],
    ['Heures en ' + mois, hmin(m.block_min), hmin(a.block_min) + ' au total'],
    ['Pilotes actifs', String(m.pilots || 0), (a.pilots || 0) + ' pilotes ont volé'],
    ['Ponctualité', pct(m), pct(a) + ' depuis le début'],
    ['Atterrissage moyen', m.avg_landing != null ? m.avg_landing + ' ft/min' : '—', a.avg_landing != null ? a.avg_landing + ' ft/min depuis le début' : '']
  ].map(([k, v, s]) => '<div class="card st-kpi"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div><div class="muted small">' + esc(s) + '</div></div>').join('');
  const days = st.days || [], max = Math.max(1, ...days.map((d) => d.flights));
  $('stDays').innerHTML = days.length ? '<div class="st-days">' + days.map((d) => { const dt = new Date(d.d + 'T12:00:00Z'); return '<div title="' + esc(dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })) + ' : ' + d.flights + ' vol' + (d.flights > 1 ? 's' : '') + '"><span class="n">' + (d.flights || '') + '</span><i style="height:' + Math.max(2, d.flights / max * 100) + '%"></i><span class="d">' + dt.toLocaleDateString('fr-FR', { weekday: 'narrow' }) + dt.getUTCDate() + '</span></div>'; }).join('') + '</div>' : '<div class="muted">Aucun vol.</div>';
  const pp = st.punctual_pilots || [];
  $('stPonct').innerHTML = m.rated ? '<div class="st-donut" style="--p:' + Math.round(m.on_time / m.rated * 100) + '"><span>' + pct(m) + '</span></div><div class="muted small" style="text-align:center;margin:6px 0 10px">' + m.on_time + ' vols à l’heure sur ' + m.rated + ' vols du programme</div>' +
    (pp.length ? '<div class="st-list">' + pp.map((p) => '<div><span>' + esc(p.pseudo) + '</span><b>' + Math.round(p.on_time / p.rated * 100) + ' %</b><small>' + p.on_time + '/' + p.rated + '</small></div>').join('') + '</div>' : '<div class="muted small">Classement des pilotes ponctuels dès 3 vols du programme dans le mois.</div>')
    : '<div class="muted">Pas encore de vol du programme ce mois-ci. Prends un vol dans le Planning du jour pour être noté.</div>';
  const tp = st.top_pilots || [], tmax = Math.max(1, ...tp.map((p) => p.block_min));
  $('stPilots').innerHTML = tp.length ? '<div class="st-bars">' + tp.map((p, i) => '<div><span class="r">' + (i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1) + '</span><span class="l">' + esc(p.pseudo) + '</span><span class="b"><i style="width:' + (p.block_min / tmax * 100) + '%"></i></span><span class="v">' + hmin(p.block_min) + ' · ' + p.flights + ' vol' + (p.flights > 1 ? 's' : '') + '</span></div>').join('') + '</div>' : '<div class="muted">Personne n’a encore volé ce mois-ci : à toi de jouer !</div>';
  const bl = st.best_landing;
  if (bl) $('stPilots').innerHTML += '<div class="st-best">🪶 <b>Meilleur atterrissage de la semaine :</b> ' + esc(bl.pseudo) + ', ' + bl.landing_rate + ' ft/min à ' + esc(bl.arr) + (bl.flight_number ? ' (' + esc(bl.flight_number) + ')' : '') + '</div>';
  const ap = (icao) => { const x = (S.latAirports || {})[icao]; return x ? x.city || x.name : ''; };
  const td = st.top_dest || [], dmax = Math.max(1, ...td.map((d) => d.flights));
  $('stDest').innerHTML = td.length ? '<div class="st-bars">' + td.map((d) => '<div><span class="l"><b>' + esc(d.icao) + '</b> <small class="muted">' + esc(ap(d.icao)) + '</small></span><span class="b"><i style="width:' + (d.flights / dmax * 100) + '%"></i></span><span class="v">' + d.flights + '</span></div>').join('') + '</div>' : '<div class="muted">Aucune destination pour le moment.</div>';
  const ty = st.types || [];
  const tname = (t) => (/B77W|777/.test(t) ? 'Boeing 777-300ER' : /A20N/.test(t) ? 'Airbus A320neo' : /A32/.test(t) ? 'Airbus A320' : t);
  $('stTypes').innerHTML = ty.length ? '<div class="st-list">' + ty.map((t) => '<div><span>' + esc(tname(t.type)) + '</span><b>' + t.flights + ' vol' + (t.flights > 1 ? 's' : '') + '</b><small>' + hmin(t.block_min) + '</small></div>').join('') + '</div>' : '<div class="muted">—</div>';
  const ro = st.top_routes || [];
  $('stRoutes').innerHTML = ro.length ? '<div class="st-list">' + ro.map((x) => '<div><span>' + esc(x.dep) + ' → ' + esc(x.arr) + '</span><b>' + x.flights + '</b><small></small></div>').join('') + '</div>' : '<div class="muted">—</div>';
  const rc = st.recent || [];
  $('stRecent').innerHTML = rc.length ? '<table class="st-table"><tbody>' + rc.map((x) => '<tr><td>' + esc(new Date(x.flown_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })) + '</td><td><b>' + esc(x.pseudo) + '</b></td><td>' + esc(x.flight_number || '') + '</td><td>' + esc(x.dep) + ' → ' + esc(x.arr) + '</td><td>' + (x.block_min != null ? hmin(x.block_min) : '—') + '</td><td>' + (x.on_time == null ? '' : x.on_time ? '<span class="pz ok">À l’heure</span>' : '<span class="pz late">+' + x.delay_min + ' min</span>') + '</td></tr>').join('') + '</tbody></table>' : '<div class="muted">Aucun vol pour le moment.</div>';
}
$('btnStatsRefresh').addEventListener('click', loadStats);

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
  if (d.flight && d.flight.mode !== 'demo' && d.flight.phase != null) resumeFlight(d.flight);
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

const hhmm = (t) => (t ? new Date(t).toISOString().slice(11, 16) + 'Z' : '—');
document.addEventListener('click', (e) => { const g = e.target.closest('[data-gotab]'); if (g) showTab(g.dataset.gotab); });

// ---------------- carte des vols réels ----------------
// Vues prédéfinies, données en lon/lat puis converties en Mercator.
const vbox = (lon0, lat1, lon1, lat0) => [MapLayers.LX(lon0), MapLayers.LY(lat1), MapLayers.LX(lon1) - MapLayers.LX(lon0), MapLayers.LY(lat0) - MapLayers.LY(lat1)];
const VIEWS = { monde: vbox(-180, 78, 180, -58), europe: vbox(-12, 60, 32, 34), atlantique: vbox(-85, 58, 35, 5), antilles: vbox(-72, 22, -55, 10) };
const MX = (lon) => MapLayers.LX(lon); const MY = (lat) => MapLayers.LY(lat);
const PLANE = 'M0 -5 L1 -1.5 L5 1 L5 2 L1 1 L0.8 3.6 L2 4.6 L2 5.2 L0 4.6 L-2 5.2 L-2 4.6 L-0.8 3.6 L-1 1 L-5 2 L-5 1 L-1 -1.5 Z';
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
  // les aéroports de départ et d'arrivée à leur altitude réelle (SimBrief met parfois une altitude de procédure)
  if (pl.origin.elev != null) pts[0].alt = pl.origin.elev;
  if (pl.destination.elev != null) pts[pts.length - 1].alt = pl.destination.elev;
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

// ---------------- infos du jour : ton prochain vol (pris dans le Planning du jour) ----------------
async function loadInfosNext() {
  if (!$('infoNext')) return;
  try { if (!S.gen.flight) S.gen.flight = (await afv.genGet()).flight; } catch (e) { /* rien */ }
  const g = S.gen.flight;
  $('infoNext').innerHTML = g && !g.doneAt
    ? '<div class="gen-big"><b>' + esc(g.number) + '</b> ' + esc(g.from) + ' → ' + esc(g.to) + ' <span class="muted">' + esc((g.fromName || '') + ' – ' + (g.toName || '')) + '</span></div>' +
      '<div class="muted small">' + esc(g.reg || '') + ' · ' + esc(g.model || g.type) + ' · départ prévu ' + hhZ(g.depEst) + ' · ' + hm(g.blockMin) + '</div>'
    : '<p class="muted">Pas de vol prévu. Choisis ton avion et ton type de vol dans le Planning du jour : Max te propose des vols à faire.</p>' +
      '<button class="btn small red" data-gotab="planning">Choisir un vol</button>';
}
setTimeout(loadInfosNext, 1500);
setInterval(loadInfosNext, 5 * 60 * 1000);

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
  if (S.gen && S.gen.flight && !S.gen.flight.doneAt) {
    const i = S.gen.day ? Math.max(0, S.gen.day.findIndex((l) => l.key === S.gen.flight.key)) : 0;
    return { f: S.gen.flight, i, n: S.gen.day ? S.gen.day.length : 1 };
  }
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
  box.innerHTML = '<div><b>▶ ' + (nx.n > 1 ? 'Vol ' + (nx.i + 1) + '/' + nx.n + ' de ta journée : ' : 'Ton vol : ') + num + ' ' + esc(f.from) + ' → ' + esc(f.to) + '</b>' + (own ? ' avec ' + esc(own.reg) : '') + (f.depEst ? ' · départ ' + hhZ(f.depEst) : '') +
    '<div class="small">' + (ok ? '✓ Le plan SimBrief chargé correspond à ce vol : tu peux démarrer.'
      : S.plan && S.plan.origin ? '⚠ Le plan chargé est ' + esc(S.plan.origin.icao) + ' → ' + esc(S.plan.destination.icao) + '. Prépare ' + esc(f.from) + ' → ' + esc(f.to) + ' dans SimBrief, puis « Charger mon plan SimBrief ».'
      : 'Prépare-le dans SimBrief (« Generate Flight »), puis clique sur « Charger mon plan SimBrief ».') + '</div></div>' +
    (ok ? '' : '<a class="btn small red" href="' + esc(planSimbrief(f)) + '" target="_blank" rel="noopener">Ouvrir SimBrief</a>');
}
// avion de la compagnie pour un vol : celui choisi s'il est du bon type, sinon le premier de ce type (A320 → F-HLAT, 777 → F-HLAU)
const planeFor = (f) => { const m = companyPlane(S.plan2.myReg); return m && sameFamily(m.type, f.type) ? m : (S.plan2.company || []).find((c) => sameFamily(c.type, f.type)) || null; };
function planSimbrief(f) {
  const own = planeFor(f);
  const p = Object.assign({ orig: f.from, dest: f.to, airline: 'LAT', fltnum: (f.number || '').replace(/\D/g, '') }, f.type ? { type: f.type } : {}, own ? { reg: own.reg } : {});
  return 'https://dispatch.simbrief.com/options/custom?' + new URLSearchParams(p).toString();
}
// ---------------- Planning du jour : générateur de vols ----------------
// Le pilote choisit l'avion de la compagnie (A320 F-HLAT ou 777 F-HLAU) et court, moyen ou long-courrier :
// Max propose des vols au hasard au départ de l'aéroport où se trouve l'avion (règle du hangar).
S.gen = { cat: null, from: null, seed: 0, res: null, flight: null, msg: '', busy: false, mode: 'vol', legs: 4, day: null, dayRes: null };
const GEN_CAT = { court: ['Court-courrier', 'moins de 1 500 km'], moyen: ['Moyen-courrier', '1 500 à 4 000 km'], long: ['Long-courrier', 'plus de 4 000 km'] };
const GEN_CATS = { A320: ['court', 'moyen'], B77W: ['moyen', 'long'] };
async function loadPlanning(refresh) {
  if (!S.plan2.company.length) await loadCompanyFleet();
  if (!S.gen.airports) { try { const g = await afv.genGet(); S.gen.flight = g.flight; S.gen.day = g.day; S.gen.airports = g.airports; } catch (e) { /* rien */ } }
  if (!S.hg.fleet || !S.hg.fleet.length) await loadHangar(true);
  if (refresh) S.gen.seed++;
  await genLoad();
  renderFlightAdmin();
}
const genPlane = () => companyPlane(S.plan2.myReg) || (S.plan2.company || [])[0] || null;
const genFromOf = (p) => { const h = p && hangarState(p.reg); return S.gen.from || (h && h.location) || 'LFPG'; };
async function genLoad() {
  const p = genPlane(); if (!p) { renderPlanning(); return; }
  if (!S.plan2.myReg) S.plan2.myReg = p.reg;
  const cats = GEN_CATS[p.type] || ['court', 'moyen'];
  if (!cats.includes(S.gen.cat)) S.gen.cat = cats[0];
  const o = { type: p.type, cat: S.gen.cat, from: genFromOf(p), seed: S.gen.seed };
  try {
    if (S.gen.mode === 'jour') S.gen.dayRes = await afv.genDay(Object.assign(o, { legs: S.gen.cat === 'court' ? S.gen.legs : 2 }));
    else S.gen.res = await afv.genFlights(o);
  } catch (e) { S.gen[S.gen.mode === 'jour' ? 'dayRes' : 'res'] = { ok: false, error: 'Impossible de générer les vols.' }; }
  renderPlanning();
}
const apName = (icao) => { const a = (S.gen.airports || {})[icao]; return a ? a.city || a.name : ''; };
function renderPlanning() {
  if (!$('genPlanes')) return;
  const P = S.plan2.company || [], cur = genPlane();
  $('genPlanes').innerHTML = P.length ? P.map((p) => {
    const h = hangarState(p.reg), b = bookingOf(p.reg), st = h ? hgStatus(h) : null;
    const state = b && !b.mine ? (b.maint ? '🔧 En maintenance jusqu’à ' + hLocal(b.until) : '✈ Piloté par ' + esc(b.pseudo)) : b && b.mine ? '✈ Réservé pour toi' : st && st.k !== 'ok' ? esc(st.t) : '● Disponible';
    return '<button class="gen-plane' + (cur && cur.reg === p.reg ? ' on' : '') + '" data-genreg="' + esc(p.reg) + '" aria-pressed="' + !!(cur && cur.reg === p.reg) + '">' +
      (p.image ? '<span class="img" style="background-image:url(\'' + esc(p.image) + '\')"></span>' : '') +
      '<span class="bd"><b>' + esc(p.reg) + '</b><span>' + esc(p.type === 'B77W' ? 'Boeing 777-300ER' : 'Airbus A320') + (p.name ? ' · ' + esc(p.name.replace(/^Les Ailes Tricolores\s*[–-]\s*/, 'livrée ')) : '') + '</span><span class="muted small">📍 ' + esc(h ? h.location : '—') + ' · ' + state + '</span></span></button>';
  }).join('') : '<div class="muted">Chargement de la flotte…</div>';
  const cats = GEN_CATS[cur && cur.type] || ['court', 'moyen'];
  $('genCats').innerHTML = ['court', 'moyen', 'long'].map((c) => {
    const ok = cats.includes(c);
    return '<button class="gen-cat' + (S.gen.cat === c ? ' on' : '') + '" data-gencat="' + c + '"' + (ok ? '' : ' disabled title="' + (c === 'long' ? 'Trop loin pour l’A320' : 'Pas de 777 sur les vols courts') + '"') + ' aria-pressed="' + (S.gen.cat === c) + '"><b>' + GEN_CAT[c][0] + '</b><span>' + GEN_CAT[c][1] + '</span></button>';
  }).join('');
  const from = genFromOf(cur), h = cur && hangarState(cur.reg);
  const opts = Object.keys(S.gen.airports || {}).sort().map((k) => '<option value="' + k + '"' + (k === from ? ' selected' : '') + '>' + k + ' – ' + esc(apName(k)) + '</option>').join('');
  $('genFrom').innerHTML = '<span>Départ de <b>' + esc(from) + '</b> ' + esc(apName(from)) + (h && h.location === from ? ' <span class="muted small">(là où est ' + esc(cur.reg) + ')</span>' : '') + '</span>' +
    (opts ? '<label class="muted small">Changer : <select id="genFromSel">' + opts + '</select></label>' : '') +
    (S.gen.from ? '<button class="linkbtn" data-genfromreset>Revenir à l’aéroport de l’avion</button>' : '');
  if (h && h.location && from !== h.location) $('genFrom').innerHTML += '<div class="gen-warn">⚠ ' + esc(cur.reg) + ' est à ' + esc(h.location) + ' : avec l’avion de la compagnie, ton vol doit partir de là.</div>';
  // un vol ou une journée complète
  $('genMode').innerHTML = [['vol', 'Un vol', 'au choix parmi 6'], ['jour', 'Ma journée', S.gen.cat === 'court' ? 'plusieurs vols enchaînés' : 'un aller-retour']].map(([k, l, d]) =>
    '<button class="gen-cat' + (S.gen.mode === k ? ' on' : '') + '" data-genmode="' + k + '" aria-pressed="' + (S.gen.mode === k) + '"><b>' + l + '</b><span>' + d + '</span></button>').join('') +
    (S.gen.mode === 'jour' && S.gen.cat === 'court' ? '<span class="gen-legs">Nombre de vols : ' + [2, 4, 6].map((n) => '<button class="tag' + (S.gen.legs === n ? ' on' : '') + '" data-genlegs="' + n + '" aria-pressed="' + (S.gen.legs === n) + '">' + n + '</button>').join('') + '</span>' : '');
  // vol choisi
  const g = S.gen.flight;
  $('genMine').hidden = !g;
  if (g) {
    const done = !!g.doneAt;
    const planOk = S.plan && samePlan(S.plan, g);
    const di = S.gen.day ? S.gen.day.findIndex((l) => l.key === g.key) : -1;
    $('genMine').innerHTML = '<div class="row between"><h3 class="caps" style="margin:0">' + (done ? (S.gen.day ? '✓ Journée terminée' : '✓ Vol terminé') : S.gen.day ? 'Ta journée · vol ' + (di + 1) + ' sur ' + S.gen.day.length : 'Ton vol') + '</h3><button class="linkbtn" data-gencancel>' + (done ? 'Effacer' : S.gen.day ? 'Annuler la journée' : 'Annuler ce vol') + '</button></div>' +
      '<div class="gen-big"><b>' + esc(g.number) + '</b> ' + esc(g.from) + ' → ' + esc(g.to) + ' <span class="muted">' + esc((g.fromName || '') + ' – ' + (g.toName || '')) + '</span></div>' +
      '<div class="muted small">' + esc(g.reg || '') + ' · ' + esc(g.model || g.type) + ' · ' + fmt(g.distKm) + ' km · ' + hm(g.blockMin) + ' · départ prévu ' + hhZ(g.depEst) + ', arrivée ' + hhZ(g.arrEst) + '</div>' +
      (S.gen.day ? '<div class="gen-legs-list">' + S.gen.day.map((l, i) => { const st = l.doneAt ? 'done' : l.key === g.key && !done ? 'next' : ''; return '<div class="gl ' + st + '"><span class="i">' + (l.doneAt ? '✓' : i + 1) + '</span><b>' + esc(l.number) + '</b> ' + esc(l.from) + ' → ' + esc(l.to) + '<span class="muted small">' + hhZ(l.depEst) + ' – ' + hhZ(l.arrEst) + ' · ' + hm(l.blockMin) + '</span><span class="pst ' + (st === 'done' ? 'arrive' : st === 'next' ? 'en-vol' : '') + '">' + (st === 'done' ? 'Fait' : st === 'next' ? 'En cours' : 'À faire') + '</span></div>'; }).join('') + '</div>' : '') +
      (done ? '<div class="day-guide"><b>Bravo commandant !</b> ' + esc(g.reg || 'L’avion') + ' est maintenant à ' + esc(g.to) + '. Choisis ton prochain vol ci-dessous, au départ de ' + esc(g.to) + '.</div>'
        : '<ol class="dg-steps">' +
        '<li class="ok-' + (planOk ? 1 : 0) + '"><span class="n">1</span><div><b>Prépare le vol dans SimBrief</b><div class="muted small">Le formulaire s’ouvre déjà rempli (LAT, ' + esc(g.reg || '') + ') : clique sur « Generate Flight ».</div></div><a class="btn small red" href="' + esc(planSimbrief(g)) + '" target="_blank" rel="noopener">Ouvrir SimBrief</a></li>' +
        '<li class="ok-' + (planOk ? 1 : 0) + '"><span class="n">2</span><div><b>Charge le plan dans le tracker</b><div class="muted small">' + (planOk ? '✓ Plan ' + esc(g.from) + ' → ' + esc(g.to) + ' chargé.' : S.plan2.dayErr ? '<span style="color:var(--red)">' + esc(S.plan2.dayErr) + '</span>' : S.plan && S.plan.origin ? '<span style="color:var(--red)">Le plan chargé est ' + esc(S.plan.origin.icao) + ' → ' + esc(S.plan.destination.icao) + '.</span>' : 'Le tracker récupère le plan que tu viens de générer.') + '</div></div><button class="btn small ' + (planOk ? 'ghost' : 'red') + '" data-dayload>' + (planOk ? 'Recharger' : 'Charger le plan') + '</button></li>' +
        '<li><span class="n">3</span><div><b>Lance le vol</b><div class="muted small">Dans MSFS, place ' + esc(g.reg || 'ton avion') + ' à ' + esc(g.from) + ' et pars vers ' + hhZ(g.depEst) + ' pour être à l’heure (15 min de marge à l’arrivée).</div></div><button class="btn small ' + (planOk ? 'red' : 'ghost') + '" data-daygo>Aller au tracker</button></li></ol>');
  }
  if (g && !g.doneAt) { $('genList').innerHTML = '<p class="muted small" style="margin-top:16px">' + (S.gen.day ? 'Ta journée est en cours.' : 'Ton vol est prévu.') + ' Pour en choisir un autre, clique d’abord sur « ' + (S.gen.day ? 'Annuler la journée' : 'Annuler ce vol') + ' ».</p>'; return; }
  if (S.gen.mode === 'jour') { renderGenDay(cur, from); return; }
  // vols proposés
  const r = S.gen.res;
  $('planSub').textContent = cur ? 'Vols proposés pour ' + cur.reg + ' · ' + (GEN_CAT[S.gen.cat] || [''])[0].toLowerCase() + ' au départ de ' + from : 'Choisis ton avion et ton type de vol';
  if (!r) { $('genList').innerHTML = '<div class="card muted">Préparation des vols…</div>'; return; }
  if (!r.ok || !r.flights.length) { $('genList').innerHTML = '<div class="card empty">' + esc(r.error || 'Aucune destination ' + (GEN_CAT[S.gen.cat] || [''])[0].toLowerCase() + ' au départ de ' + from + ' pour cet avion. Choisis un autre type de vol.') + '</div>'; return; }
  const busy = cur && bookingOf(cur.reg) && !bookingOf(cur.reg).mine;
  $('genList').innerHTML = (S.gen.msg ? '<div class="gen-warn" style="margin-bottom:10px">' + esc(S.gen.msg) + '</div>' : '') + '<div class="gen-grid">' + r.flights.map((f) =>
    '<div class="card gen-f"><div class="row between"><span class="n">' + esc(f.number) + '</span><span class="cat ' + esc(f.cat) + '">' + esc(GEN_CAT[f.cat][0]) + '</span></div>' +
    '<div class="gen-route"><b>' + esc(f.from) + '</b><i></i><b>' + esc(f.to) + '</b></div><div class="gen-city">' + esc(f.fromName) + ' → ' + esc(f.toName) + '</div>' +
    '<div class="gen-facts"><span><small>Départ</small>' + hhZ(f.depEst) + '</span><span><small>Arrivée</small>' + hhZ(f.arrEst) + '</span><span><small>Durée</small>' + hm(f.blockMin) + '</span><span><small>Distance</small>' + fmt(f.distKm) + ' km</span></div>' +
    '<button class="btn small red" data-gentake="' + esc(f.key) + '"' + (busy || S.gen.busy ? ' disabled' : '') + '>Prendre ce vol</button></div>').join('') + '</div>' +
    (busy ? '<p class="muted small">' + esc(cur.reg) + ' est déjà pris : choisis l’autre avion ou attends qu’il soit libre.</p>' : '') +
    '<p class="muted small">' + r.total + ' destinations possibles · « Autres vols » en haut pour un nouveau tirage.</p>';
}
// Ma journée : les vols enchaînés, avec les escales, et un bouton pour tout prendre
function renderGenDay(cur, from) {
  const r = S.gen.dayRes;
  $('planSub').textContent = cur ? 'Journée de ' + cur.reg + ' · ' + (GEN_CAT[S.gen.cat] || [''])[0].toLowerCase() + ' au départ de ' + from : 'Choisis ton avion et ton type de vol';
  if (!r) { $('genList').innerHTML = '<div class="card muted">Préparation de ta journée…</div>'; return; }
  if (!r.ok) { $('genList').innerHTML = '<div class="card empty">' + esc(r.error || 'Impossible de composer une journée.') + '</div>'; return; }
  const busy = cur && bookingOf(cur.reg) && !bookingOf(cur.reg).mine;
  const turn = (a, b) => Math.round((b.depEst - a.arrEst) / 60000);
  $('genList').innerHTML = (S.gen.msg ? '<div class="gen-warn" style="margin:16px 0 0">' + esc(S.gen.msg) + '</div>' : '') +
    '<div class="card gen-day"><div class="row between wrap"><div><h2 style="margin:0">Ta journée avec ' + esc(cur.reg) + '</h2><div class="muted small">' + r.legs.length + ' vols · ' + hm(r.blockTotal) + ' de vol · de ' + hhZ(r.start) + ' à ' + hhZ(r.end) + ' · retour à ' + esc(r.from) + '</div></div>' +
    '<div class="row"><button class="btn ghost small" data-genother>Autre journée</button><button class="btn red" data-gentakeday' + (busy || S.gen.busy ? ' disabled' : '') + '>Prendre cette journée</button></div></div>' +
    '<div class="gen-tl">' + r.legs.map((f, i) => (i ? '<div class="gen-turn">⏱ Escale à ' + esc(f.from) + ' : ' + hm(turn(r.legs[i - 1], f)) + '</div>' : '') +
      '<div class="gen-leg"><span class="i">' + (i + 1) + '</span><div class="m"><div><b>' + esc(f.number) + '</b> <span class="cat ' + esc(f.cat) + '">' + esc(GEN_CAT[f.cat][0]) + '</span></div><div class="gen-route" style="font-size:18px"><b>' + esc(f.from) + '</b><i></i><b>' + esc(f.to) + '</b></div><div class="gen-city">' + esc(f.fromName) + ' → ' + esc(f.toName) + '</div></div>' +
      '<div class="gen-facts" style="grid-template-columns:repeat(4,90px)"><span><small>Départ</small>' + hhZ(f.depEst) + '</span><span><small>Arrivée</small>' + hhZ(f.arrEst) + '</span><span><small>Durée</small>' + hm(f.blockMin) + '</span><span><small>Distance</small>' + fmt(f.distKm) + ' km</span></div></div>').join('') + '</div>' +
    (busy ? '<p class="muted small">' + esc(cur.reg) + ' est déjà pris : choisis l’autre avion ou attends qu’il soit libre.</p>' : '<p class="muted small">L’avion reste réservé pour toi toute la journée. Chaque vol se coche tout seul une fois au parking, et Max prépare le suivant.</p>') + '</div>';
}
async function genTakeDay(legs) {
  const own = genPlane(); if (!own || !legs.length) return;
  S.gen.busy = true; S.gen.msg = ''; renderPlanning();
  try {
    if (!(bookingOf(own.reg) || {}).mine) {
      const r = await afv.fleetTake(own.reg, legs[legs.length - 1].arrEst + 2 * 3600000);
      await loadBookings(true);
      if (!r || !r.ok) { S.gen.msg = (r && r.error) || 'Réservation de l’avion impossible.'; return; }
    }
    const d = await afv.genPickDay(legs.map((f) => Object.assign({}, f, { reg: own.reg })));
    S.gen.flight = d.flight; S.gen.day = d.day;
    renderDayNext(false); loadInfosNext();
    const f = legs[0];
    maxSays('Ta journée est prête : ' + legs.length + ' vols avec ' + own.reg + '. On commence par ' + f.number + ', ' + f.from + ' vers ' + f.to + ', départ prévu ' + sayTime(f.depEst) + '.');
    loadNextPlan(f, f.number);
  } finally { S.gen.busy = false; renderPlanning(); }
}
// prendre un vol (générateur du Planning du jour) : l'avion de la compagnie est réservé, puis SimBrief s'ouvre déjà rempli
async function genTake(f) {
  const own = planeFor(f) || genPlane();
  S.gen.busy = true; S.gen.msg = ''; renderPlanning();
  try {
    if (own && !(bookingOf(own.reg) || {}).mine) {
      const r = await afv.fleetTake(own.reg, (f.arrEst || Date.now() + 6 * 3600000) + 2 * 3600000);
      await loadBookings(true);
      if (!r || !r.ok) { S.gen.msg = (r && r.error) || 'Réservation de l’avion impossible.'; return; }
    }
    S.gen.flight = await afv.genPick(Object.assign({}, f, { reg: own ? own.reg : '', dep: f.dep || new Date(f.depEst).toISOString().slice(11, 16), block: f.block || f.blockMin }));
    if (own) S.plan2.myReg = own.reg;
    renderDayNext(false); loadInfosNext();
    maxSays('C’est noté : ' + f.number + ', ' + f.from + ' vers ' + f.to + (own ? ' avec ' + own.reg : '') + ', départ prévu ' + sayTime(f.depEst) + '.');
    loadNextPlan(f, f.number);
  } finally { S.gen.busy = false; renderPlanning(); }
}
document.addEventListener('click', async (e) => {
  const rg = e.target.closest('[data-genreg]'); if (rg) { S.plan2.myReg = rg.dataset.genreg; try { localStorage.setItem('lat.myReg', S.plan2.myReg); } catch (err) { /* rien */ } S.gen.from = null; S.gen.res = null; renderPlanning(); genLoad(); return; }
  const md = e.target.closest('[data-genmode]'); if (md) { S.gen.mode = md.dataset.genmode; renderPlanning(); genLoad(); return; }
  const lg = e.target.closest('[data-genlegs]'); if (lg) { S.gen.legs = +lg.dataset.genlegs; S.gen.dayRes = null; renderPlanning(); genLoad(); return; }
  if (e.target.closest('[data-genother]')) { S.gen.seed++; genLoad(); return; }
  if (e.target.closest('[data-gentakeday]')) { if (S.gen.dayRes && S.gen.dayRes.ok) genTakeDay(S.gen.dayRes.legs); return; }
  const c = e.target.closest('[data-gencat]'); if (c && !c.disabled) { S.gen.cat = c.dataset.gencat; S.gen.res = null; renderPlanning(); genLoad(); return; }
  if (e.target.closest('[data-genfromreset]')) { S.gen.from = null; genLoad(); return; }
  const t = e.target.closest('[data-gentake]'); if (t) { const f = S.gen.res && S.gen.res.flights.find((x) => x.key === t.dataset.gentake); if (f) genTake(f); return; }
  if (e.target.closest('[data-gencancel]')) {
    const g = S.gen.flight;
    S.gen.flight = await afv.genPick(null); S.gen.day = null;
    if (g && !g.doneAt && g.reg && (bookingOf(g.reg) || {}).mine) { await afv.fleetRelease(g.reg, 0); await loadBookings(true); }
    renderPlanning(); renderDayNext(false); return;
  }
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'genFromSel') { S.gen.from = e.target.value; genLoad(); }
});
afv.on('gen:changed', (g) => { S.gen.flight = g.flight; S.gen.day = g.day; renderPlanning(); renderDayNext(false); loadInfosNext(); });
$('btnPlanRefresh').addEventListener('click', () => { S.gen.seed++; genLoad(); });
// l'heure de départ conseillée avance avec le temps : nouveau tirage toutes les 10 minutes si l'écran est affiché
setInterval(() => { if ($('tab-planning').classList.contains('on')) genLoad(); }, 10 * 60 * 1000);

// Max, rubrique « Ma journée » : avec l'avion choisi, un seul vol ou toute sa journée à respecter ?
const MAX_AVATAR = '<svg class="max-avatar" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20" fill="#0A1E4A"/><rect x="11" y="15" width="22" height="13" rx="6" fill="#fff"/><circle class="blink" cx="17" cy="21" r="2.4" fill="#0A1E4A"/><circle class="blink" cx="27" cy="21" r="2.4" fill="#0A1E4A"/><path d="M17 31 Q22 34 27 31" stroke="#C8102E" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>';
const hhZ = (ms) => ms ? new Date(ms).toISOString().slice(11, 16) + 'Z' : 'heure inconnue';
const sayTime = (ms) => ms ? (+new Date(ms).toISOString().slice(11, 13)) + ' heures ' + new Date(ms).toISOString().slice(14, 16) + ' UTC' : '';

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
// « Démarrer un vol » : un seul clic charge le dernier plan SimBrief puis démarre le suivi.
let goFlyBusy = false;
async function goFly() {
  showTab('vol');
  if (S.flight || goFlyBusy) return;
  goFlyBusy = true;
  try {
    await loadPlanForStart();
    if (!S.simOk) { waitForSim(); return; }
    await startFlight('sim');
  } finally { goFlyBusy = false; }
}
// Charge le dernier plan SimBrief (si le pilote a un identifiant SimBrief) ; garde l'ancien plan en cas d'échec.
async function loadPlanForStart() {
  if (!S.store || !S.store.settings.simbrief) return false;
  $('sbMsg').textContent = 'Chargement de ton dernier plan SimBrief…';
  try {
    const p = await afv.loadSimbrief();
    const changed = !S.plan || planKey(S.plan) !== planKey(p) || S.plan.callsign !== p.callsign;
    S.plan = p;
    $('sbMsg').textContent = 'Plan chargé : ' + (p.callsign ? p.callsign + ' · ' : '') + p.origin.icao + ' → ' + p.destination.icao + '.';
    renderPlan(); renderDayNext(false); renderMissionHint();
    return changed;
  } catch (e) {
    $('sbMsg').textContent = (S.plan ? 'Plan SimBrief non rechargé, je garde celui déjà chargé. ' : 'Plan SimBrief non chargé : le vol sera suivi sans plan. ') + String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return false;
  }
}
$('btnGoFly').addEventListener('click', goFly);
// Clic avant d'être dans le simu : le suivi démarre tout seul dès que l'avion est prêt dans MSFS
// (simulateur connecté, avion posé au départ du plan ; sans plan, avion posé quelque part depuis quelques secondes).
function waitForSim() {
  S.waitStart = { since: 0 };
  $('startMsg').innerHTML = 'En attente du simulateur… Le suivi démarrera tout seul dès que ton avion sera prêt' + (S.plan ? ' à ' + esc(S.plan.origin.icao) : '') + ' dans MSFS. <button class="linkbtn" data-waitcancel>Annuler</button>';
  maxSays('Plan prêt. Je démarre le suivi tout seul dès que tu es dans le cockpit' + (S.plan ? ' à ' + S.plan.origin.icao : '') + '.');
}
function waitTick(t) {
  const w = S.waitStart;
  if (S.plan && S.plan.origin.lat && Number.isFinite(t.lat) && t.onGround && hav(t, S.plan.origin) > 10 && !w.told && Math.abs(t.lat) + Math.abs(t.lon) > 0.5) {
    w.told = true; $('startMsg').innerHTML = 'En attente : ton avion n’est pas à ' + esc(S.plan.origin.icao) + ' (départ du plan). Place-le à ' + esc(S.plan.origin.icao) + ' ou clique sur « Démarrer le suivi » pour démarrer quand même. <button class="linkbtn" data-waitcancel>Annuler</button>';
  }
  if (!S.simOk || !Number.isFinite(t.lat) || Math.abs(t.lat) + Math.abs(t.lon) < 0.5 || !t.onGround) { w.since = 0; return; } // menu de MSFS : pas encore d'avion
  if (!w.since) w.since = Date.now();
  const near = S.plan && S.plan.origin.lat ? hav(t, S.plan.origin) <= 10 : true;
  const held = Date.now() - w.since;
  // avec un plan : avion posé à l'aéroport de départ depuis 5 s (le menu de MSFS n'y est pas) ; sans plan : posé depuis 20 s
  if (S.plan ? near && held >= 5000 : held >= 20000) { S.waitStart = null; $('startMsg').textContent = ''; startFlight('sim'); }
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-waitcancel]')) { S.waitStart = null; $('startMsg').textContent = 'Démarrage automatique annulé.'; } });
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
  if (!$('tab-infos').classList.contains('on')) return;
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
  const svg = $('liveMap'); if (!svg || !$('tab-infos').classList.contains('on')) return;
  mapSkeleton(svg);
  if (!liveVB) liveVB = VIEWS.europe.slice();
  const [x, y, w, h] = liveVB;
  const ratio = (svg.clientHeight || 420) / (svg.clientWidth || 1000);
  const hh = w * ratio, yy = y + h / 2 - hh / 2;
  liveVB = [x, yy, w, hh];
  svg.setAttribute('viewBox', liveVB.join(' '));
  const ppu = (svg.clientWidth || 1000) / w;
  applyLayers(svg, 'ligne', [1, 0, 0, 1, 0, 0], [x, yy, x + w, yy + hh], ppu, () => renderLiveMap());
  const k = Math.pow(w / 360, 0.6) * (w < 20 ? Math.pow(w / 20, 0.4) : 1), sat = S.layers.ligne.sat;
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
  $('liveCredit').textContent = svg.dataset.credit || '';
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
    const w = Math.min(360, Math.max(0.03, liveVB[2] * f)); const h = w * (liveVB[3] / liveVB[2]);
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
// le programme Les Ailes Tricolores est calculé pour le jour même : il n'est jamais « en retard »
function planStale() { return ''; }
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
// ---------------- direction : programme des vols ----------------
S.fadm = { rows: [], q: '', edit: null, msg: '' };
const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
async function renderFlightAdmin(reload) {
  const box = $('flightAdmin'); if (!box) return;
  if (!S.plan2.data) { try { S.plan2.data = await afv.getPlanning(false); } catch (e) { /* hors ligne */ } }
  if (!S.plan2.data || !S.plan2.data.admin) { box.hidden = true; return; }
  box.hidden = false;
  if (reload || !S.fadm.loaded) { const r = await afv.flightRows(); S.fadm.rows = r.rows || []; S.fadm.loaded = true; if (r.error) S.fadm.msg = r.error; }
  const e = S.fadm.edit || { number: '', from: 'LFPG', to: '', dep: '08:00', block: 90, type: 'A320', days: [1, 2, 3, 4, 5, 6, 7], note: '' };
  const q = S.fadm.q.trim().toUpperCase();
  const rows = S.fadm.rows.filter((r) => !q || [r.number, r.dep_airport, r.arr_airport].some((x) => String(x).includes(q))).sort((a, b) => (b.active - a.active) || a.number.localeCompare(b.number, 'fr', { numeric: true }));
  const inp = (id, v, ph, w, extra) => '<input id="' + id + '" value="' + esc(v) + '" placeholder="' + ph + '" style="width:' + w + 'px;height:34px;border:1px solid var(--line);border-radius:8px;padding:0 8px" ' + (extra || '') + '>';
  box.innerHTML = '<div class="row between wrap"><h2>Direction · programme des vols</h2><span class="muted small">' + S.fadm.rows.filter((r) => r.active).length + ' vols actifs · réservé à la direction</span></div>' +
    '<div class="card" style="background:#F7F8FB;box-shadow:none"><h3 class="caps">' + (S.fadm.edit && S.fadm.edit.existing ? 'Modifier ' + esc(e.number) : 'Ajouter un vol') + '</h3>' +
    '<div class="row wrap" style="gap:8px;align-items:end">' +
    '<label class="field">Numéro ' + inp('faNum', e.number, 'LAT1234', 100, S.fadm.edit && S.fadm.edit.existing ? 'readonly' : '') + '</label>' +
    '<label class="field">Départ ' + inp('faFrom', e.from, 'LFPG', 70) + '</label><label class="field">Arrivée ' + inp('faTo', e.to, 'LFMN', 70) + '</label>' +
    '<label class="field">Heure (UTC) ' + inp('faDep', e.dep, '08:00', 70) + '</label><label class="field">Durée (min) ' + inp('faBlock', e.block, '90', 70, 'type="number" min="20" max="1200"') + '</label>' +
    '<label class="field">Avion <select id="faType" style="height:34px;border:1px solid var(--line);border-radius:8px"><option value="A320"' + (e.type === 'A320' ? ' selected' : '') + '>A320</option><option value="B77W"' + (e.type === 'B77W' ? ' selected' : '') + '>777-300ER</option></select></label>' +
    '<div class="field">Jours <div class="row" style="gap:4px">' + DAYS.map((l, i) => '<label class="check" title="' + ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'][i] + '" style="gap:2px"><input type="checkbox" data-faday="' + (i + 1) + '"' + (e.days.includes(i + 1) ? ' checked' : '') + '>' + l + '</label>').join('') + '</div></div>' +
    '<label class="field">Note ' + inp('faNote', e.note || '', 'facultatif', 180) + '</label>' +
    '<button class="btn red" data-fasave>' + (S.fadm.edit && S.fadm.edit.existing ? 'Enregistrer' : 'Ajouter') + '</button>' + (S.fadm.edit ? '<button class="btn ghost" data-facancel>Annuler</button>' : '') + '</div>' +
    '<div class="small" id="faMsg" style="margin-top:6px;color:var(--red)">' + esc(S.fadm.msg) + '</div></div>' +
    '<div class="row" style="margin:10px 0"><input id="faSearch" value="' + esc(S.fadm.q) + '" placeholder="Rechercher un vol, un aéroport…" style="width:260px;height:34px;border:1px solid var(--line);border-radius:8px;padding:0 10px"></div>' +
    '<div style="max-height:360px;overflow:auto"><table class="plan-t"><thead><tr><th>Vol</th><th>Trajet</th><th>Départ</th><th>Durée</th><th>Avion</th><th>Jours</th><th></th></tr></thead><tbody>' +
    rows.slice(0, 300).map((r) => '<tr' + (r.active ? '' : ' style="opacity:.45"') + '><td class="n">' + esc(r.number) + '</td><td><b>' + esc(r.dep_airport) + ' → ' + esc(r.arr_airport) + '</b>' + (r.note ? '<div class="muted small">' + esc(r.note) + '</div>' : '') + '</td><td>' + esc(r.dep_utc) + 'Z</td><td>' + hm(r.block_min) + '</td><td>' + (r.aircraft_type === 'B77W' ? '777-300ER' : 'A320') + '</td>' +
      '<td class="small">' + ((r.days || []).length === 7 ? 'tous' : (r.days || []).map((d) => DAYS[d - 1]).join(' ')) + '</td><td><div class="row">' +
      (r.active ? '<button class="btn small ghost" data-faedit="' + esc(r.number) + '">Modifier</button><button class="btn small ghost" data-faoff="' + esc(r.number) + '">Retirer</button>' : '<span class="muted small">retiré</span><button class="btn small ghost" data-faon="' + esc(r.number) + '">Remettre</button>') + '</div></td></tr>').join('') +
    '</tbody></table></div>';
}
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'faSearch') { S.fadm.q = e.target.value; const pos = e.target.selectionStart; renderFlightAdmin().then(() => { const i = $('faSearch'); i.focus(); i.setSelectionRange(pos, pos); }); } });
document.addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-faedit]');
  if (ed) { const r = S.fadm.rows.find((x) => x.number === ed.dataset.faedit); S.fadm.edit = { existing: true, number: r.number, from: r.dep_airport, to: r.arr_airport, dep: r.dep_utc, block: r.block_min, type: r.aircraft_type, days: r.days || [], note: r.note || '' }; S.fadm.msg = ''; renderFlightAdmin(); $('flightAdmin').scrollIntoView({ behavior: 'smooth' }); return; }
  if (e.target.closest('[data-facancel]')) { S.fadm.edit = null; S.fadm.msg = ''; renderFlightAdmin(); return; }
  const off = e.target.closest('[data-faoff]');
  if (off) { if (!window.confirm('Retirer le vol ' + off.dataset.faoff + ' du programme ? Tu pourras le remettre plus tard.')) return; const r = await afv.flightRemove(off.dataset.faoff); S.fadm.msg = r.ok ? '' : r.error; await renderFlightAdmin(true); return; }
  const on = e.target.closest('[data-faon]');
  if (on) { const r0 = S.fadm.rows.find((x) => x.number === on.dataset.faon); const r = await afv.flightSave({ number: r0.number, from: r0.dep_airport, to: r0.arr_airport, dep: r0.dep_utc, block: r0.block_min, type: r0.aircraft_type, days: r0.days, note: r0.note, active: true }); S.fadm.msg = r.ok ? '' : r.error; await renderFlightAdmin(true); return; }
  if (e.target.closest('[data-fasave]')) {
    const f = { number: $('faNum').value.trim().toUpperCase().replace(/\s+/g, ''), from: $('faFrom').value.trim().toUpperCase(), to: $('faTo').value.trim().toUpperCase(), dep: $('faDep').value.trim(), block: +$('faBlock').value, type: $('faType').value,
      days: [...document.querySelectorAll('[data-faday]')].filter((x) => x.checked).map((x) => +x.dataset.faday), note: $('faNote').value.trim() };
    const bad = !/^LAT\d{2,4}[A-Z]?$/.test(f.number) ? 'Numéro de vol : LAT suivi de 2 à 4 chiffres (ex. LAT1234).'
      : !/^[A-Z0-9]{4}$/.test(f.from) || !/^[A-Z0-9]{4}$/.test(f.to) || f.from === f.to ? 'Aéroports : deux codes OACI différents de 4 lettres (ex. LFPG, LFMN).'
      : !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.dep) ? 'Heure de départ en UTC, au format 08:30.'
      : !(f.block >= 20 && f.block <= 1200) ? 'Durée entre 20 et 1 200 minutes.' : !f.days.length ? 'Choisis au moins un jour.' : '';
    if (bad) { $('faMsg').textContent = bad; return; }
    if (!(S.fadm.edit && S.fadm.edit.existing) && S.fadm.rows.some((r) => r.number === f.number && r.active)) { $('faMsg').textContent = 'Ce numéro de vol existe déjà.'; return; }
    const r = await afv.flightSave(f);
    if (!r.ok) { $('faMsg').textContent = r.error; return; }
    S.fadm.edit = null; S.fadm.msg = '';
    await renderFlightAdmin(true);
  }
});

// ---------------- succès ----------------
S.ach = { list: [], cat: 'tous' };
async function loadAchievements() {
  try { S.ach.list = await afv.getAchievements(); } catch (e) { S.ach.list = []; }
  renderAchievements();
}
function renderAchievements() {
  const L = S.ach.list, done = L.filter((a) => a.done);
  $('chipAch').hidden = !done.length; $('chipAch').textContent = done.length + '/' + L.length;
  if (!$('tab-succes').classList.contains('on') && L.length) return;
  $('achCount').textContent = done.length + ' / ' + L.length;
  $('achBar').style.width = (L.length ? Math.round(done.length / L.length * 100) : 0) + '%';
  const last = done.filter((a) => a.doneAt).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)))[0];
  $('achLast').textContent = last ? 'Dernier succès : ' + last.title + ' (' + new Date(last.doneAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + ')' : 'Aucun succès pour le moment : à toi de jouer !';
  const cats = ['tous', ...new Set(L.map((a) => a.cat))];
  $('achCats').innerHTML = cats.map((c) => '<button class="tag' + (S.ach.cat === c ? ' on' : '') + '" data-achcat="' + esc(c) + '" aria-pressed="' + (S.ach.cat === c) + '">' + (c === 'tous' ? 'Tous' : esc(c)) + ' · ' + (c === 'tous' ? done.length + '/' + L.length : L.filter((a) => a.cat === c && a.done).length + '/' + L.filter((a) => a.cat === c).length) + '</button>').join('');
  const show = L.filter((a) => S.ach.cat === 'tous' || a.cat === S.ach.cat).sort((a, b) => (b.done - a.done) || (b.value / b.target - a.value / a.target));
  $('achGrid').innerHTML = show.map((a) => '<div class="ach' + (a.done ? ' done' : '') + '"><div class="i" aria-hidden="true">' + a.icon + '</div><div style="flex:1;min-width:0"><div class="t">' + esc(a.title) + '</div><div class="d">' + esc(a.desc) + '</div>' +
    '<div class="p"><i style="width:' + Math.round(a.value / a.target * 100) + '%"></i></div><div class="v">' + (a.done ? '✔ Débloqué' + (a.doneAt ? ' le ' + new Date(a.doneAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '') : fmt(a.value) + ' / ' + fmt(a.target)) + '</div></div></div>').join('');
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-achcat]'); if (c) { S.ach.cat = c.dataset.achcat; renderAchievements(); return; }
  if (e.target.closest('[data-achclose]')) { $('achToast').hidden = true; return; }
  if (e.target.closest('[data-achgo]')) { $('achToast').hidden = true; showTab('succes'); }
});
document.querySelector('[data-tab=succes]').addEventListener('click', loadAchievements);
// nouveau succès après un vol : petite annonce + Max
const achQueue = [];
function achShowNext() {
  const a = achQueue.shift(); if (!a) return;
  $('achToast').innerHTML = '<div class="i" aria-hidden="true">' + a.icon + '</div><div><b>Succès débloqué</b><div class="t">' + esc(a.title) + '</div><div class="d">' + esc(a.desc) + '</div><button class="btn small ghost" data-achgo style="margin-top:8px;color:#fff;border-color:#5F76AD">Voir mes succès</button></div><button data-achclose aria-label="Fermer">×</button>';
  $('achToast').hidden = false;
  try { maxSays('Bravo ! Nouveau succès débloqué : ' + a.title + '.'); } catch (e) { /* Max indisponible */ }
  setTimeout(() => { $('achToast').hidden = true; achShowNext(); }, 9000);
}
afv.on('ach:new', (list) => { for (const a of list || []) achQueue.push(a); if ($('achToast').hidden) achShowNext(); loadAchievements(); });
setTimeout(loadAchievements, 2000);
setTimeout(loadLive, 1500);

// ---------------- carte de roulage de Max ----------------
S.taxi = { data: null, vb: null, saidFor: '' };
function taxiInfo() {
  const p = S.plan; if (!p || !p.origin || !p.origin.icao) return null;
  const rwy = (S.pistes && S.pistes.dep && S.pistes.dep.rwy) || p.origin.rwy || '';
  const t = S.lastT && S.lastT.lat != null ? { lat: S.lastT.lat, lon: S.lastT.lon } : null;
  return { ap: { icao: p.origin.icao, lat: p.origin.lat, lon: p.origin.lon }, rwy, pos: t };
}
async function loadTaxi() {
  const i = taxiInfo();
  if (!i) { $('taxiSay').textContent = 'Charge d’abord ton plan SimBrief : je trouverai ta piste de départ.'; $('taxiMap').innerHTML = ''; return null; }
  $('taxiSub').textContent = i.ap.icao + (i.rwy ? ' · piste ' + i.rwy : '');
  $('taxiSay').textContent = 'Je regarde le plan de ' + i.ap.icao + '…';
  const d = await afv.getRoulage(i.ap, i.rwy, i.pos);
  S.taxi.data = d; S.taxi.vb = null;
  $('taxiSay').textContent = d.ok ? d.say : d.error;
  renderTaxi();
  return d;
}
function renderTaxi() {
  const d = S.taxi.data, svg = $('taxiMap');
  if (!d || !d.ok) { svg.innerHTML = ''; return; }
  const lat0 = d.center.lat, lon0 = d.center.lon, kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
  const P = (a, b) => [((b - lon0) * kx).toFixed(1), (-(a - lat0) * ky).toFixed(1)];
  const r = d.route;
  if (!S.taxi.vb) {
    // cadrage : le chemin (avec de la marge), sinon tout l'aéroport
    const pts = r ? r.path.map((p) => P(p.lat, p.lon)).concat(d.thr ? [P(d.thr.lat, d.thr.lon)] : []) : d.ways.flatMap((w) => w.g.map((g) => P(g[0], g[1])));
    const xs = pts.map((p) => +p[0]), ys = pts.map((p) => +p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = Math.max(150, (x1 - x0) * 0.12, (y1 - y0) * 0.12);
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const ratio = (svg.clientHeight || 600) / (svg.clientWidth || 1000);
    let w = x1 - x0, h = y1 - y0;
    if (h / w < ratio) { const nh = w * ratio; y0 -= (nh - h) / 2; h = nh; } else { const nw = h / ratio; x0 -= (nw - w) / 2; w = nw; }
    S.taxi.vb = [x0, y0, w, h];
  }
  const [vx, vy, vw, vh] = S.taxi.vb;
  svg.setAttribute('viewBox', S.taxi.vb.join(' '));
  const px = vw / (svg.clientWidth || 1000); // mètres par pixel écran
  const line = (g) => g.map((q, i) => (i ? 'L' : 'M') + P(q[0], q[1]).join(' ')).join('');
  let h = '<rect x="' + vx + '" y="' + vy + '" width="' + vw + '" height="' + vh + '" fill="#EEF2F8"/>';
  for (const w of d.ways.filter((x) => x.k === 'rwy')) h += '<path d="' + line(w.g) + '" stroke="#3B4660" stroke-width="45" fill="none" stroke-linecap="butt"/><path d="' + line(w.g) + '" stroke="#fff" stroke-width="' + Math.max(1, px * 1.2) + '" stroke-dasharray="' + (30) + ' ' + (25) + '" fill="none"/>';
  for (const w of d.ways.filter((x) => x.k !== 'rwy')) h += '<path d="' + line(w.g) + '" stroke="' + (w.k === 'lane' ? '#D9DFEA' : '#C9D2E3') + '" stroke-width="' + (w.k === 'lane' ? 10 : 18) + '" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  if (r) {
    const rp = r.path.map((q) => P(q.lat, q.lon).join(' '));
    h += '<polyline points="' + rp.join(' ') + '" stroke="#fff" stroke-width="' + Math.max(14, px * 9) + '" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
    h += '<polyline points="' + rp.join(' ') + '" stroke="#C8102E" stroke-width="' + Math.max(8, px * 5) + '" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  // noms des taxiways (une fois par nom visible) et des pistes
  const fs = Math.max(9, px * 12), seen = new Set();
  const onRoute = new Set(r ? r.legs.join(', ').split(/, | à /) : []);
  for (const w of d.ways.slice().sort((a, b) => (onRoute.has(b.ref) - onRoute.has(a.ref)))) {
    if (!w.ref || seen.has(w.ref) || w.g.length < 2) continue;
    const m = w.g[Math.floor(w.g.length / 2)], [x, y] = P(m[0], m[1]).map(Number);
    if (x < vx || x > vx + vw || y < vy || y > vy + vh) continue;
    seen.add(w.ref);
    const hot = onRoute.has(w.ref), rw = w.k === 'rwy';
    const label = rw ? w.ref : w.ref;
    const bw = (label.length * 0.62 + 0.8) * fs * (rw ? 1.1 : 1);
    h += '<g transform="translate(' + x + ' ' + y + ')"><rect x="' + (-bw / 2) + '" y="' + (-fs * 0.75) + '" width="' + bw + '" height="' + (fs * 1.5) + '" rx="' + (fs * 0.3) + '" fill="' + (rw ? '#3B4660' : hot ? '#C8102E' : '#FFD45C') + '" stroke="#0A1E4A" stroke-width="' + (px * 0.8) + '"/>' +
      '<text text-anchor="middle" y="' + (fs * 0.38) + '" font-size="' + (fs * (rw ? 1.05 : 1)) + '" font-weight="800" fill="' + (rw || hot ? '#fff' : '#111') + '">' + esc(label) + '</text></g>';
  }
  if (d.thr) { const [x, y] = P(d.thr.lat, d.thr.lon); h += '<g transform="translate(' + x + ' ' + y + ')"><circle r="' + (fs * 0.9) + '" fill="#C8102E" stroke="#fff" stroke-width="' + (px * 2) + '"/><text y="' + (-fs * 1.4) + '" text-anchor="middle" font-size="' + (fs * 1.25) + '" font-weight="800" fill="#C8102E" paint-order="stroke" stroke="#fff" stroke-width="' + (px * 3) + '">Piste ' + esc(d.rwy) + '</text></g>'; }
  if (r) {
    const [ex, ey] = P(r.end.lat, r.end.lon); h += '<rect x="' + (+ex - fs * 0.6) + '" y="' + (+ey - fs * 0.6) + '" width="' + (fs * 1.2) + '" height="' + (fs * 1.2) + '" fill="#E0A800" stroke="#0A1E4A" stroke-width="' + (px) + '" transform="rotate(45 ' + ex + ' ' + ey + ')"/>';
    const [sx, sy] = P(r.path[0].lat, r.path[0].lon), hdg = S.lastT && S.lastT.hdg != null ? S.lastT.hdg : 0;
    h += '<g transform="translate(' + sx + ' ' + sy + ') rotate(' + hdg + ') scale(' + (fs * 0.35) + ')"><path d="' + PLANE + '" fill="#0A1E4A" stroke="#fff" stroke-width=".7"/></g>';
  }
  svg.innerHTML = h;
}
async function openTaxi() { $('taxiModal').hidden = false; await loadTaxi(); }
$('btnTaxi').addEventListener('click', openTaxi);
$('btnTaxiClose').addEventListener('click', () => { $('taxiModal').hidden = true; });
$('taxiModal').addEventListener('click', (e) => { if (e.target === $('taxiModal')) $('taxiModal').hidden = true; });
$('btnTaxiAgain').addEventListener('click', loadTaxi);
$('btnTaxiListen').addEventListener('click', () => { const d = S.taxi.data; if (d && (d.say || d.error)) { maxStop(); maxSpeak(d.say || d.error, true); } });
(function taxiControls() {
  const svg = $('taxiMap');
  const toMap = (ev) => { const r = svg.getBoundingClientRect(), v = S.taxi.vb; return [v[0] + ((ev.clientX - r.left) / r.width) * v[2], v[1] + ((ev.clientY - r.top) / r.height) * v[3]]; };
  svg.addEventListener('wheel', (ev) => {
    if (!S.taxi.vb) return; ev.preventDefault();
    const [mx, my] = toMap(ev), v = S.taxi.vb, f = ev.deltaY > 0 ? 1.25 : 0.8;
    const w = Math.min(12000, Math.max(150, v[2] * f)), h = w * (v[3] / v[2]);
    S.taxi.vb = [mx - (mx - v[0]) * (w / v[2]), my - (my - v[1]) * (h / v[3]), w, h]; renderTaxi();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => { if (!S.taxi.vb) return; drag = { x: ev.clientX, y: ev.clientY, vb: S.taxi.vb.slice() }; svg.setPointerCapture(ev.pointerId); });
  svg.addEventListener('pointermove', (ev) => { if (!drag) return; const r = svg.getBoundingClientRect(); S.taxi.vb = [drag.vb[0] - ((ev.clientX - drag.x) / r.width) * drag.vb[2], drag.vb[1] - ((ev.clientY - drag.y) / r.height) * drag.vb[3], drag.vb[2], drag.vb[3]]; renderTaxi(); });
  svg.addEventListener('pointerup', () => { drag = null; });
})();
// Au roulage, Max annonce une fois le chemin jusqu'à la piste (vol réel, pas en démo)
setInterval(async () => {
  if (!S.flight || !S.plan || S.plan.demo || S.phase !== 1) return;
  const i = taxiInfo(); if (!i || !i.pos || !i.rwy) return;
  if (S.taxi.saidFlight === S.flight) return; // une fois par vol
  S.taxi.saidFlight = S.flight;
  try { const d = await afv.getRoulage(i.ap, i.rwy, i.pos); if (d && d.ok && d.route) { S.taxi.data = d; S.taxi.vb = null; maxSays(d.say); } } catch (e) { /* plan de l'aéroport indisponible */ }
}, 4000);

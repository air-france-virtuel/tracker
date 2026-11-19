'use strict';
/* global afv */
// Panneau compact : reçoit les données du tracker principal et les affiche en grand.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Check-lists courtes par phase (cochées sur ce PC, remises à zéro à chaque phase).
const CHECKLISTS = [
  ['Avant le départ', ['Plan SimBrief chargé', 'Carburant embarqué', 'ATIS et clairance obtenus', 'Annonce d’embarquement']],
  ['Roulage', ['Volets réglés pour le décollage', 'Commandes de vol vérifiées', 'Transpondeur sur TA/RA', 'Briefing décollage']],
  ['Décollage', ['Phares et feux allumés', 'Piste et finale dégagées', 'Poussée de décollage']],
  ['Montée', ['Train rentré', 'Volets rentrés', 'Altimètres sur 1013 au niveau de transition', '250 kt sous 10 000 ft']],
  ['Croisière', ['Niveau de croisière atteint', 'Suivi carburant', 'Préparer l’arrivée (ATIS, STAR, piste)']],
  ['Avant descente', ['Briefing approche', 'Altimètres QNH prévus', 'Vitesse de descente réglée', 'Annonce de descente']],
  ['Approche', ['Altimètres sur QNH', 'Volets et train sortis', 'Vitesse d’approche stabilisée']],
  ['Après atterrissage', ['Spoilers et inverseurs rentrés', 'Volets rentrés', 'Phares éteints']],
  ['Parking', ['Frein de parking serré', 'Moteurs coupés', 'Ceintures : signal éteint']]
];
let curPhase = -2;
let pinned = true;
$('pin').addEventListener('click', async () => { pinned = !pinned; await afv.compactPin(pinned); $('pin').setAttribute('aria-pressed', String(pinned)); $('pin').textContent = pinned ? 'Épinglé' : 'Épingler'; });

function renderChecklist(phase) {
  const idx = phase == null ? 0 : Math.max(0, Math.min(CHECKLISTS.length - 1, phase === 4 ? 4 : phase));
  const [title, items] = CHECKLISTS[idx];
  $('chkT').textContent = 'CHECK-LIST · ' + title.toUpperCase();
  $('chk').innerHTML = items.map((t) => '<li><button aria-pressed="false"><span class="box"></span><span>' + esc(t) + '</span></button></li>').join('');
}
$('chk').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); });

function renderMap(d) {
  const svg = $('map');
  const W = 400, H = 220;
  const pts = d.route.map((p) => ({ lat: p[0], lon: p[1] }));
  const pos = d.pos ? { lat: d.pos[0], lon: d.pos[1] } : null;
  const all = pts.concat(pos ? [pos] : []);
  if (!all.length) { svg.innerHTML = ''; return; }
  let minLat = Math.min(...all.map((p) => p.lat)), maxLat = Math.max(...all.map((p) => p.lat));
  let minLon = Math.min(...all.map((p) => p.lon)), maxLon = Math.max(...all.map((p) => p.lon));
  const pad = 0.6; minLat -= pad; maxLat += pad; minLon -= pad; maxLon += pad;
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const sc = Math.min((W - 30) / ((maxLon - minLon) * k), (H - 30) / (maxLat - minLat));
  const ox = W / 2 - ((minLon + maxLon) / 2) * k * sc, oy = H / 2 + ((minLat + maxLat) / 2) * sc;
  const X = (p) => (p.lon * k * sc + ox).toFixed(1), Y = (p) => (oy - p.lat * sc).toFixed(1);
  const line = (a) => a.map((p, i) => (i ? 'L' : 'M') + X(p) + ' ' + Y(p)).join(' ');
  let h = '<rect x="-50" y="-50" width="500" height="320" fill="#071733"/><path d="' + (window.WORLD_PATH || '') + '" transform="matrix(' + (k * sc) + ' 0 0 ' + sc + ' ' + (ox - 180 * k * sc) + ' ' + (oy - 90 * sc) + ')" fill="#12305F" stroke="#26467F" stroke-width="0.8" vector-effect="non-scaling-stroke"/>';
  if (pts.length > 1) h += '<path d="' + line(pts) + '" fill="none" stroke="#6E8AC8" stroke-width="2" stroke-dasharray="6 5"/>';
  const tr = (d.trail || []).map((p) => ({ lat: p[0], lon: p[1] }));
  if (tr.length > 1) h += '<path d="' + line(tr) + '" fill="none" stroke="#3DDC84" stroke-width="3"/>';
  if (pts.length) for (const [p, n] of [[pts[0], d.from], [pts[pts.length - 1], d.to]]) h += '<circle cx="' + X(p) + '" cy="' + Y(p) + '" r="5" fill="#071733" stroke="#fff" stroke-width="2.5"/><text x="' + (+X(p) + 8) + '" y="' + (+Y(p) + 4) + '" font-size="12" font-weight="700" fill="#fff">' + esc(n) + '</text>';
  if (pos) h += '<g transform="translate(' + X(pos) + ' ' + Y(pos) + ') rotate(' + ((d.pos[2] || 0) - 90).toFixed(0) + ')"><path d="M12 0 L-8 -8 L-4 0 L-8 8 Z" fill="#F0374E" stroke="#fff" stroke-width="1.5"/></g>';
  svg.innerHTML = h;
}

afv.on('compact:data', (d) => {
  $('cs').textContent = d.callsign;
  $('rt').textContent = d.from ? d.from + ' → ' + d.to : '';
  $('ph').hidden = !d.phaseName; $('ph').textContent = (d.phaseName || '').toUpperCase();
  $('pg').style.width = (d.progress || 0) + '%';
  $('evL').textContent = d.next.label; $('evV').textContent = d.next.value || ''; $('evS').textContent = d.next.sub || '';
  $('params').innerHTML = (d.params.length ? d.params : [['ALT', '—'], ['IAS', '—'], ['GS', '—'], ['V/S', '—'], ['HDG', '—'], ['FUEL', '—']])
    .map(([k, v]) => '<div><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>').join('');
  renderMap(d);
  const ph = d.phase == null ? null : d.phase;
  if (ph !== curPhase) { curPhase = ph; renderChecklist(ph); }
  $('max').innerHTML = '<b>Max :</b> ' + esc(d.max || '');
});
renderChecklist(null);
$('params').innerHTML = [['ALT', '—'], ['IAS', '—'], ['GS', '—'], ['V/S', '—'], ['HDG', '—'], ['FUEL', '—']].map(([k, v]) => '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');

'use strict';
// Carnet de vol imprimable (PDF) : tous les vols du pilote (démo exclue), totaux par avion, signature.
const ponct = require('./ponctualite');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hm = (min) => (min == null ? '—' : Math.floor(min / 60) + ':' + String(Math.round(min) % 60).padStart(2, '0'));
const hz = (t) => (t ? new Date(t).toISOString().slice(11, 16) : '—');
const day = (t) => new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const typeOf = (r) => {
  const t = String(r.planAircraft || r.aircraft || '').toUpperCase();
  if (/B77W|777/.test(t)) return '777-300ER';
  if (/A20N/.test(t)) return 'A320neo';
  if (/A320|A32/.test(t)) return 'A320';
  return t.slice(0, 10) || '—';
};

// reports : du plus récent au plus ancien ; info : { pilot, grade, logo (data URL), program }
function html(reports, info) {
  const real = (reports || []).filter((r) => r && r.mode !== 'demo' && r.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const rows = real.map((r) => {
    const inAt = Date.parse(r.date), outAt = r.blockMinutes != null ? inAt - r.blockMinutes * 60000 : null;
    const p = r.ponctualite || ponct.check(r, info.program);
    return { r, inAt, outAt, p, type: typeOf(r) };
  });
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const byType = {};
  for (const x of rows) { const t = byType[x.type] || (byType[x.type] = { n: 0, block: 0, fl: 0 }); t.n++; t.block += x.r.blockMinutes || 0; t.fl += x.r.flightMinutes || 0; }
  const punct = rows.filter((x) => x.p);
  const onTime = punct.filter((x) => x.p.onTime).length;
  const soft = rows.filter((x) => typeof x.r.landingRate === 'number' && Math.abs(x.r.landingRate) <= 150).length;
  const now = new Date();
  const tr = rows.map((x, i) => '<tr><td>' + (i + 1) + '</td><td>' + day(x.outAt || x.inAt) + '</td><td class="b">' + esc(x.r.flightNumber || x.r.callsign || '—') + '</td>' +
    '<td class="b">' + esc(x.r.from || '—') + '</td><td>' + hz(x.outAt) + '</td><td class="b">' + esc(x.r.to || '—') + '</td><td>' + hz(x.inAt) + '</td>' +
    '<td>' + esc(x.type) + '</td><td>' + esc(x.r.registration || '—') + '</td><td class="n">' + hm(x.r.blockMinutes) + '</td><td class="n">' + hm(x.r.flightMinutes) + '</td>' +
    '<td class="n">' + (typeof x.r.landingRate === 'number' ? x.r.landingRate : '—') + '</td>' +
    '<td>' + (x.p ? (x.p.onTime ? '<span class="ok">À l’heure</span>' : '<span class="late">+' + x.p.arrDelay + ' min</span>') : '—') + '</td>' +
    '<td>' + (x.r.mission ? (x.r.mission.validated ? 'Validée +' + (x.r.mission.points || 0) : 'Non validée') : '—') + '</td></tr>').join('');
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Carnet de vol</title><style>' +
    '@page{size:A4 landscape}*{box-sizing:border-box}body{font-family:"Segoe UI",Arial,sans-serif;color:#0A1E4A;font-size:10.5px;margin:0}' +
    '.head{display:flex;align-items:center;gap:16px;border-bottom:3px solid #0A1E4A;padding-bottom:10px;margin-bottom:12px}.head img{width:58px;height:58px}' +
    '.head h1{margin:0;font-size:22px}.head .sub{color:#5B667D;font-size:12px}.tri{height:4px;background:linear-gradient(90deg,#1F3E9C 33%,#fff 33% 66%,#C8102E 66%);margin:-10px 0 14px}' +
    '.tot{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:12px}.tot div{border:1px solid #CBD3E3;border-radius:6px;padding:7px 9px}.tot b{display:block;font-size:16px}.tot span{color:#5B667D;font-size:9.5px;text-transform:uppercase;letter-spacing:.04em}' +
    'table{width:100%;border-collapse:collapse}thead{display:table-header-group}th{background:#0A1E4A;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.03em;padding:5px 4px;text-align:left}' +
    'td{border-bottom:1px solid #E1E6EF;padding:4px}tr:nth-child(even) td{background:#F6F8FB}tr{page-break-inside:avoid}.b{font-weight:700}.n{text-align:right;font-variant-numeric:tabular-nums;padding-right:10px}' +
    '.ok{color:#1B5E32;font-weight:600}.late{color:#B00020;font-weight:600}.types{margin:10px 0 0;font-size:10px}.types td,.types th{padding:3px 8px}' +
    '.sign{display:flex;justify-content:space-between;margin-top:22px;page-break-inside:avoid}.sign div{width:40%;border-top:1px solid #0A1E4A;padding-top:5px;color:#5B667D}' +
    '.note{color:#5B667D;font-size:9px;margin-top:8px}</style></head><body>' +
    '<div class="head">' + (info.logo ? '<img src="' + info.logo + '" alt="">' : '') + '<div><h1>Carnet de vol</h1><div class="sub">Les Ailes Tricolores · compagnie aérienne virtuelle</div></div>' +
    '<div style="margin-left:auto;text-align:right"><div style="font-size:16px;font-weight:700">' + esc(info.pilot || 'Pilote') + '</div><div class="sub">' + esc(info.grade || '') + '</div><div class="sub">Édité le ' + now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) + '</div></div></div><div class="tri"></div>' +
    '<div class="tot"><div><span>Vols</span><b>' + rows.length + '</b></div><div><span>Temps de bloc</span><b>' + hm(sum(rows, (x) => x.r.blockMinutes)) + '</b></div><div><span>Temps de vol</span><b>' + hm(sum(rows, (x) => x.r.flightMinutes)) + '</b></div>' +
    '<div><span>Destinations</span><b>' + new Set(rows.map((x) => x.r.to).filter(Boolean)).size + '</b></div><div><span>Ponctualité</span><b>' + (punct.length ? Math.round(onTime / punct.length * 100) + ' %' : '—') + '</b></div><div><span>Atterrissages ≤ 150 ft/min</span><b>' + soft + '</b></div></div>' +
    (rows.length ? '<table><thead><tr><th>#</th><th>Date (UTC)</th><th>Vol</th><th>Départ</th><th>Heure</th><th>Arrivée</th><th>Heure</th><th>Avion</th><th>Immat.</th><th>Bloc</th><th>Vol</th><th>Atterr. ft/min</th><th>Ponctualité</th><th>Mission</th></tr></thead><tbody>' + tr + '</tbody></table>'
      : '<p>Aucun vol enregistré pour le moment.</p>') +
    (Object.keys(byType).length ? '<table class="types" style="width:auto"><thead><tr><th>Avion</th><th>Vols</th><th>Bloc</th><th>Vol</th></tr></thead><tbody>' + Object.entries(byType).map(([t, v]) => '<tr><td class="b">' + esc(t) + '</td><td class="n">' + v.n + '</td><td class="n">' + hm(v.block) + '</td><td class="n">' + hm(v.fl) + '</td></tr>').join('') + '</tbody></table>' : '') +
    '<div class="sign"><div>Signature du pilote</div><div>Visa de la direction des Ailes Tricolores</div></div>' +
    '<div class="note">Heures en UTC (départ = sortie du parking, arrivée = arrivée au parking). Ponctualité : à l’heure si l’arrivée est au plus 15 minutes après l’horaire du programme. Document de loisir, sans valeur réglementaire.</div>' +
    '</body></html>';
}

module.exports = { html };

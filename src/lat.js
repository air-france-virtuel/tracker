'use strict';
// Vols du jour de la compagnie Les Ailes Tricolores, construits à partir du programme (horaires UTC, jours de la semaine).
// Le programme vient du serveur de la compagnie (modifiable par la direction) ; sinon, programme fixe intégré au tracker.
const fs = require('fs');
const path = require('path');
const BUNDLED = require('./data/vols.json');

const R_KM = 6371;
function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R_KM * Math.asin(Math.sqrt(h)));
}
const category = (distKm, blockMin) => {
  const d = distKm != null ? distKm : (blockMin || 0) * 11;
  return d < 1500 ? 'court' : d < 4000 ? 'moyen' : 'long';
};
const MODEL = { A320: 'A320', B77W: '777-300ER' };
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
// jour ISO : 1 = lundi … 7 = dimanche
const isoDay = (t) => { const d = new Date(t).getUTCDay(); return d === 0 ? 7 : d; };

// lignes du serveur → format du programme
function fromRows(rows) {
  return (rows || []).filter((r) => r.active !== false).map((r) => ({
    number: r.number, from: r.dep_airport, to: r.arr_airport, dep: r.dep_utc, block: r.block_min, type: r.aircraft_type,
    days: Array.isArray(r.days) && r.days.length ? r.days : [1, 2, 3, 4, 5, 6, 7], note: r.note || ''
  }));
}

// Vols d'un jour UTC (+ ceux de la veille encore en l'air), avec leur statut à l'instant « now ».
function dayFlights(program, now, airports) {
  const aps = airports || BUNDLED.airports;
  const today = dayKey(now);
  const out = [];
  for (const offset of [-1, 0]) {
    const base = Date.parse(today + 'T00:00:00Z') + offset * 86400000;
    const day = dayKey(base);
    for (const f of program) {
      if (f.days && !f.days.includes(isoDay(base))) continue;
      const [h, m] = String(f.dep).split(':').map(Number);
      const depEst = base + (h * 60 + m) * 60000;
      const arrEst = depEst + f.block * 60000;
      if (offset === -1 && arrEst <= now) continue; // vol de la veille déjà arrivé
      const A = aps[f.from], B = aps[f.to];
      const distKm = A && B ? km(A, B) : null;
      out.push({
        key: f.number + '-' + day, number: f.number, callsign: f.number, from: f.from, to: f.to,
        fromName: A ? A.city : '', toName: B ? B.city : '', fromPos: A ? [A.lat, A.lon] : null, toPos: B ? [B.lat, B.lon] : null,
        depEst, arrEst, blockMin: f.block, distKm, cat: category(distKm, f.block), type: f.type, model: MODEL[f.type] || f.type,
        status: now < depEst ? 'Programmé' : now < arrEst ? 'En vol' : 'Arrivé', scheduled: true, note: f.note || ''
      });
    }
  }
  return out.sort((a, b) => a.depEst - b.depEst);
}

// « Ma journée » : vols choisis par le pilote, gardés par jour sur son PC.
class MyDay {
  constructor(dir) { this.dir = dir; }
  file(day) { return path.join(this.dir, 'ma-journee-' + day + '.json'); }
  get(now) { try { return JSON.parse(fs.readFileSync(this.file(dayKey(now)), 'utf8')); } catch (e) { return []; } }
  toggle(key, now) {
    const list = this.get(now);
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1); else list.push(key);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(dayKey(now)), JSON.stringify(list));
    return list;
  }
}

module.exports = { BUNDLED, fromRows, dayFlights, MyDay, km, category, dayKey };

'use strict';
// Planning du jour : les vrais vols Air France vus aujourd'hui (en l'air pendant que le tracker était ouvert),
// avec l'avion utilisé, classés en court, moyen et long-courrier. Enregistré sur le PC, un fichier par jour (UTC).
const fs = require('fs');
const path = require('path');

const R_KM = 6371;
function km(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
const LONG_TYPES = /^(A33|A34|A35|A38|B74|B76|B77|B78)/;
// Classement : distance d'abord (moins de 1 500 km, 1 500 à 4 000 km, plus de 4 000 km), sinon le type d'avion.
function category(distKm, type) {
  if (distKm != null) return distKm < 1500 ? 'court' : distKm < 4000 ? 'moyen' : 'long';
  if (type) return LONG_TYPES.test(type) ? 'long' : 'court-moyen';
  return 'inconnu';
}
// Durée de vol estimée (bloc à bloc) selon la distance.
function blockMinutes(distKm, cat) {
  if (distKm == null) return null;
  const kt = cat === 'long' ? 480 : cat === 'moyen' ? 440 : 400;
  return Math.round((distKm / 1.852) / kt * 60 + 30);
}
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

class Planning {
  constructor(dir) { this.dir = dir; this.day = null; this.data = null; }
  file(day) { return path.join(this.dir, 'planning-' + day + '.json'); }
  load(now) {
    const day = dayKey(now || Date.now());
    if (this.day === day && this.data) return this.data;
    this.day = day;
    try { this.data = JSON.parse(fs.readFileSync(this.file(day), 'utf8')); } catch (e) { this.data = { day, flights: {}, mine: [] }; }
    // on ne garde que les 3 derniers jours de fichiers
    try { for (const f of fs.readdirSync(this.dir)) if (/^planning-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(9, 19) < dayKey(Date.now() - 3 * 86400000)) fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* rien */ }
    return this.data;
  }
  save() { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file(this.day), JSON.stringify(this.data)); }
  // Ajoute ou met à jour les vols vus en direct.
  record(flights, now) {
    const d = this.load(now);
    const t = now || Date.now();
    for (const f of flights) {
      if (!f.from || !f.to) continue;
      const key = f.callsign + ':' + f.from + '-' + f.to;
      const old = d.flights[key];
      const dist = f.fromPos && f.toPos ? Math.round(km(f.fromPos, f.toPos)) : (old ? old.distKm : null);
      // heure de décollage estimée : distance déjà parcourue / vitesse sol
      let depEst = old ? old.depEst : null;
      if (!depEst && f.fromPos && f.gsKt > 150) depEst = Math.round(t - (km(f.fromPos, [f.lat, f.lon]) / 1.852) / f.gsKt * 3600000);
      let arrEst = null;
      if (f.toPos && f.gsKt > 150) arrEst = Math.round(t + (km([f.lat, f.lon], f.toPos) / 1.852) / f.gsKt * 3600000);
      const type = f.type || (old && old.type) || '';
      const cat = category(dist, type);
      d.flights[key] = {
        key, callsign: f.callsign, number: f.number || '', from: f.from, to: f.to,
        fromName: f.fromName || (old && old.fromName) || '', toName: f.toName || (old && old.toName) || '',
        type, reg: f.reg || (old && old.reg) || '', distKm: dist, cat, blockMin: blockMinutes(dist, cat),
        depEst, arrEst: arrEst || (old && old.arrEst) || null, lastSeen: t
      };
    }
    this.save();
    return d;
  }
  get(now) { const d = this.load(now); return { day: d.day, flights: Object.values(d.flights), mine: d.mine }; }
  toggle(key, now) {
    const d = this.load(now);
    if (d.mine.includes(key)) d.mine = d.mine.filter((k) => k !== key);
    else if (key) d.mine.push(key);
    this.save();
    return this.get(now);
  }
  // Fusionne le programme officiel du jour (s'il existe) avec les vols vus en direct.
  // liveNow : indicatifs des vols Air France en l'air au dernier relevé.
  merged(sched, liveNow, now) {
    const t = now || Date.now();
    const base = this.get(t);
    const live = new Set((liveNow || []).map((cs) => String(cs).replace(/^AFR/, '')));
    const digits = (n) => String(n || '').replace(/\D/g, '').replace(/^0+/, '');
    const fresh = sched && sched.flights && sched.generatedAt && t - Date.parse(sched.generatedAt) < 36 * 3600000;
    const out = [];
    const seen = new Set();
    if (fresh) {
      for (const f of sched.flights) {
        const key = f.number + '|' + f.from + '|' + f.to;
        const dg = digits(f.number);
        seen.add(dg + '|' + f.from + '|' + f.to);
        let status = 'Programmé';
        if (/cancel/i.test(f.status)) status = 'Annulé';
        else if ([...live].some((c) => c.replace(/^0+/, '') === dg)) status = 'En vol';
        else if (f.arrUtc && f.arrUtc < t) status = 'Arrivé';
        else if (f.depUtc && f.depUtc < t) status = 'En cours';
        out.push(Object.assign({}, f, { key, callsign: 'AFR' + dg, depEst: f.depUtc, arrEst: f.arrUtc, scheduled: true, status, lastSeen: f.depUtc || 0 }));
      }
    }
    for (const f of base.flights) {
      if (seen.has(digits(f.number || f.callsign.replace(/^AFR/, '')) + '|' + f.from + '|' + f.to)) continue;
      out.push(Object.assign({}, f, { scheduled: false, status: live.has(f.callsign.replace(/^AFR/, '')) ? 'En vol' : 'Vu en vol' }));
    }
    return { day: base.day, flights: out, mine: base.mine, source: fresh ? { name: sched.source, generatedAt: sched.generatedAt, count: sched.flights.length } : null };
  }
}

module.exports = { Planning, category, blockMinutes, km };

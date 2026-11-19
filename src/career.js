'use strict';
// Mode carrière (enregistré sur le PC du pilote) : grades, missions et rôles, missions du jour de Max.
// Le catalogue des missions et les infos du jour peuvent être modifiés par la direction
// directement sur GitHub (dossier src/data du dépôt) : le tracker les télécharge au démarrage.

const fs = require('fs');
const path = require('path');

const REMOTE = 'https://raw.githubusercontent.com/air-france-virtuel/tracker/main/src/data/';

const GRADES = [
  { name: 'Cadet', req: 'Entrée dans la compagnie', unlock: 'Court-courrier en A220', hours: 0 },
  { name: 'Second Officier', req: '100 h · 1 mission de formation', unlock: 'Moyen-courrier en A320', hours: 100, training: 1 },
  { name: 'Premier Officier', req: '250 h · 5 vols réguliers', unlock: 'Long-courrier, cargo, qualifications A350 et B777', hours: 250, regular: 5 },
  { name: 'Commandant de bord', req: '600 h · contrôle en ligne commandant', unlock: 'Charter / VIP, humanitaire', hours: 600, qual: 'Commandant' },
  { name: 'Commandant Senior · Instructeur', req: '1 200 h · évaluation instructeur', unlock: 'Encadrement des formations', hours: 1200, qual: 'Instructeur' }
];
const BASE_QUALS = ['A220', 'A320'];
const QUAL_OF = { A350: 'A350', B777: 'B777', B777F: 'B777' };
const CATS = { pass: 'Passagers', cargo: 'Cargo', charter: 'Charter / VIP', human: 'Humanitaire', form: 'Formation' };
// Types SimBrief pour préparer le plan.
const SB_TYPE = { A220: 'BCS3', A320: 'A320', A350: 'A359', B777: 'B77W', B777F: 'B77L' };
// Codes OACI acceptés pour chaque famille d'appareil (plan SimBrief).
const FAMILY = {
  A220: /^(BCS1|BCS3|A221|A223)$/, A320: /^(A318|A319|A320|A321|A19N|A20N|A21N)$/,
  A350: /^(A359|A35K)$/, B777: /^(B77[2-9LWF]|B778|B779)$/, B777F: /^(B77[2-9LWF])$/
};

// ---------- données (catalogue et infos du jour) ----------
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
const bundled = (name) => readJson(path.join(__dirname, 'data', name), null);

class CareerData {
  constructor(dir) { this.dir = dir; this.cache = {}; }
  local(name) {
    const c = readJson(path.join(this.dir, name), null);
    return c && c.data ? c : { data: bundled(name), fetchedAt: null };
  }
  get(name) { return this.cache[name] || this.local(name); }
  async refresh(name) {
    try {
      const r = await fetch(REMOTE + name + '?t=' + Date.now(), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (name === 'missions.json' && !Array.isArray(data)) throw new Error('format');
      const c = { data, fetchedAt: Date.now() };
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, name), JSON.stringify(c));
      this.cache[name] = c;
    } catch (e) { this.cache[name] = this.local(name); }
    return this.cache[name];
  }
}

// ---------- calculs ----------
function minutesOf(r) { return r.blockMinutes != null ? r.blockMinutes : (r.flightMinutes || 0); }

// Tirage du jour, toujours le même pour une date donnée.
function seeded(seed) {
  let s = 0;
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const dayKey = (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };

function compute(reports, store, missions, now) {
  const real = reports.filter((r) => r.mode !== 'demo');
  const minutes = real.reduce((a, r) => a + minutesOf(r), 0);
  const hours = Math.floor(minutes / 60);
  const landings = real.map((r) => r.landingRate).filter((x) => typeof x === 'number');
  const done = real.filter((r) => r.mission && r.mission.validated);
  const count = {};
  for (const r of done) count[r.mission.id] = (count[r.mission.id] || 0) + 1;
  const byId = Object.fromEntries(missions.map((m) => [m.id, m]));
  const quals = BASE_QUALS.slice();
  for (const m of missions) if (m.gives && (count[m.id] || 0) >= (m.repeat || 1) && !quals.includes(m.gives)) quals.push(m.gives);
  const training = done.filter((r) => (byId[r.mission.id] || {}).kind === 'training').length;
  const regular = done.filter((r) => (byId[r.mission.id] || {}).kind === 'regular').length;
  const points = done.reduce((a, r) => a + (r.mission.points || 0), 0);

  const meets = (g) => hours >= g.hours && (!g.training || training >= g.training) && (!g.regular || regular >= g.regular) && (!g.qual || quals.includes(g.qual));
  let grade = 0;
  while (grade + 1 < GRADES.length && meets(GRADES[grade + 1])) grade++;
  const next = GRADES[grade + 1] || null;
  const todo = [];
  if (next) {
    if (hours < next.hours) todo.push((next.hours - hours) + ' h de vol');
    if (next.training && training < next.training) todo.push((next.training - training) + ' mission de formation');
    if (next.regular && regular < next.regular) todo.push((next.regular - regular) + ' vol' + (next.regular - regular > 1 ? 's' : '') + ' régulier' + (next.regular - regular > 1 ? 's' : ''));
    if (next.qual && !quals.includes(next.qual)) todo.push(next.qual === 'Commandant' ? 'le contrôle en ligne commandant' : 'l’évaluation instructeur');
  }

  const accepted = (store.accepted || []).filter((id) => byId[id]);
  const status = (m) => {
    const q = QUAL_OF[m.aircraft];
    let lock = '';
    if (m.grade > grade) lock = 'Grade minimum : ' + GRADES[m.grade].name;
    else if (m.minHours && hours < m.minHours) lock = 'Il faut ' + m.minHours + ' h de vol';
    else if (q && !quals.includes(q) && m.gives !== q) lock = 'Qualification ' + q + ' nécessaire';
    else if (m.gives && quals.includes(m.gives)) lock = 'Déjà obtenue';
    return lock;
  };
  const daily = dailyPicks(missions.filter((m) => m.kind === 'regular' && !status(m)), now);
  const list = missions.map((m) => {
    const lock = status(m);
    const isAccepted = accepted.includes(m.id);
    const dailyRank = daily.indexOf(m.id);
    return Object.assign({}, m, {
      category: CATS[m.cat] || m.cat, gradeName: GRADES[m.grade] ? GRADES[m.grade].name : '',
      locked: lock, accepted: isAccepted, validated: count[m.id] || 0,
      daily: dailyRank >= 0, bonus: dailyRank === 0 ? 2 : 1,
      status: lock ? 'Verrouillée' : isAccepted ? (store.active === m.id ? 'En cours' : 'Acceptée') : 'Disponible',
      simbrief: simbriefUrl(m)
    });
  });
  const recent = real.slice(0, 5).map((r) => ({ date: r.date, from: r.from, to: r.to, mission: r.mission || null, landingRate: r.landingRate }));
  return {
    grades: GRADES.map((g, i) => ({ name: g.name, req: g.req, unlock: g.unlock, state: i < grade ? 'done' : i === grade ? 'current' : 'locked' })),
    grade, gradeName: GRADES[grade].name, next: next ? next.name : null, nextHours: next ? next.hours : null, todo,
    hours, minutes, flights: real.length, points, quals, training, regular,
    avgLanding: landings.length ? Math.round(landings.reduce((a, b) => a + b, 0) / landings.length) : null,
    missions: list, daily, active: accepted.includes(store.active) ? store.active : null, recent
  };
}

function dailyPicks(pool, now) {
  const rnd = seeded(dayKey(now || Date.now()));
  const p = pool.slice();
  const out = [];
  while (p.length && out.length < 3) out.push(p.splice(Math.floor(rnd() * p.length), 1)[0].id);
  return out;
}

function simbriefUrl(m) {
  const q = new URLSearchParams({ orig: m.from, dest: m.to, type: SB_TYPE[m.aircraft] || m.aircraft });
  return 'https://dispatch.simbrief.com/options/custom?' + q.toString();
}

// Vérifie un vol terminé par rapport à la mission choisie.
function judge(m, rep, bonus, hard2) {
  if (!m) return null;
  const res = { id: m.id, title: m.title, validated: false, points: 0, reason: '' };
  if (rep.mode === 'demo') { res.reason = 'Le vol de démonstration ne compte pas pour la carrière.'; return res; }
  if (!rep.from || !rep.to) { res.reason = 'Pas de plan SimBrief chargé : impossible de vérifier le trajet.'; return res; }
  if (rep.from !== m.from || rep.to !== m.to) { res.reason = 'Trajet ' + rep.from + ' → ' + rep.to + ' différent de la mission (' + m.from + ' → ' + m.to + ').'; return res; }
  const type = String(rep.planAircraft || '').toUpperCase();
  if (type && FAMILY[m.aircraft] && !FAMILY[m.aircraft].test(type)) { res.reason = 'Appareil ' + type + ' différent de celui de la mission (' + m.aircraft + ').'; return res; }
  if (typeof rep.landingRate === 'number' && Math.abs(rep.landingRate) > hard2) { res.reason = 'Atterrissage trop dur (' + rep.landingRate + ' ft/min).'; return res; }
  res.validated = true;
  res.points = (m.reward || 0) * (bonus || 1);
  res.reason = bonus > 1 ? 'Vol du jour : points doublés !' : '';
  return res;
}

module.exports = { CareerData, compute, judge, dayKey, GRADES };

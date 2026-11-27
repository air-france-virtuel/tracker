'use strict';
// Ponctualité : heure réelle d'arrivée au parking comparée à l'horaire du programme Les Ailes Tricolores.
// Comme dans les vraies compagnies : un vol est « à l'heure » s'il arrive au plus 15 minutes après l'horaire.
const ON_TIME_MIN = 15;

const numOf = (r) => {
  const m = /^LAT0*(\d{2,4}[A-Z]?)$/.exec(String(r.flightNumber || r.callsign || '').toUpperCase().replace(/\s+/g, ''));
  return m ? m[1] : null;
};

// report : rapport de vol (date = arrivée au parking, blockMinutes) ; program : [{ number, from, to, dep 'HH:MM' UTC, block, days }]
function check(report, program) {
  const n = numOf(report);
  if (!n || !report || !report.date) return null;
  const f = (program || []).find((x) => String(x.number).toUpperCase().replace(/^LAT0*/, '') === n);
  if (!f) return null;
  const inAt = Date.parse(report.date);
  const outAt = report.blockMinutes != null ? inAt - report.blockMinutes * 60000 : null;
  const [h, m] = String(f.dep).split(':').map(Number);
  // l'horaire du jour le plus proche du départ réel (le vol de la veille ou du lendemain si on vole autour de minuit)
  const ref = outAt || inAt - f.block * 60000;
  const d0 = Date.UTC(new Date(ref).getUTCFullYear(), new Date(ref).getUTCMonth(), new Date(ref).getUTCDate());
  const cands = [-1, 0, 1].map((k) => d0 + k * 86400000 + (h * 60 + m) * 60000);
  const schedDep = cands.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0];
  const schedArr = schedDep + f.block * 60000;
  // parti plus de 3 h en avance ou 6 h en retard : ce n'est pas ce vol-là (vol refait à une autre heure), pas de note
  if (ref - schedDep < -3 * 3600000 || ref - schedDep > 6 * 3600000) return null;
  const arrDelay = Math.round((inAt - schedArr) / 60000);
  return {
    number: String(f.number).toUpperCase(), from: f.from, to: f.to, schedDep, schedArr, actualOut: outAt, actualIn: inAt,
    depDelay: outAt != null ? Math.round((outAt - schedDep) / 60000) : null, arrDelay, onTime: arrDelay <= ON_TIME_MIN
  };
}

// Phrase courte : « À l'heure (3 min d'avance) » / « En retard de 27 min »
function label(p) {
  if (!p) return '';
  if (p.arrDelay < -1) return 'À l’heure (' + -p.arrDelay + ' min d’avance)';
  if (p.arrDelay <= 1) return 'Pile à l’heure';
  if (p.onTime) return 'À l’heure (+' + p.arrDelay + ' min)';
  return 'En retard de ' + (p.arrDelay >= 60 ? Math.floor(p.arrDelay / 60) + ' h ' + String(p.arrDelay % 60).padStart(2, '0') : p.arrDelay + ' min');
}

module.exports = { check, label, ON_TIME_MIN };

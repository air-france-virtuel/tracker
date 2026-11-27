'use strict';
// Horaires d'ouverture des aéroports, comme dans la réalité (heure locale) : couvre-feux de nuit (Orly, Francfort,
// Zurich…), petits aéroports régionaux fermés la nuit, grands hubs ouverts 24 h/24.
// Et la règle de la compagnie : pas de court ni de moyen-courrier en pleine nuit.

// fuseau horaire de chaque aéroport, d'après le préfixe OACI (les exceptions d'abord)
const TZ_ICAO = {
  LPPD: 'Atlantic/Azores', LPMA: 'Atlantic/Madeira', TFFF: 'America/Martinique', TNCM: 'America/Lower_Princes', MMUN: 'America/Cancun',
  KORD: 'America/Chicago', KLAX: 'America/Los_Angeles', KSFO: 'America/Los_Angeles', CYVR: 'America/Vancouver', EIDW: 'Europe/Dublin'
};
const TZ_PREFIX = [
  ['LF', 'Europe/Paris'], ['EG', 'Europe/London'], ['ED', 'Europe/Berlin'], ['EH', 'Europe/Amsterdam'], ['GC', 'Atlantic/Canary'], ['LE', 'Europe/Madrid'],
  ['LI', 'Europe/Rome'], ['LS', 'Europe/Zurich'], ['EB', 'Europe/Brussels'], ['LP', 'Europe/Lisbon'], ['LO', 'Europe/Vienna'], ['EK', 'Europe/Copenhagen'],
  ['EN', 'Europe/Oslo'], ['ES', 'Europe/Stockholm'], ['EP', 'Europe/Warsaw'], ['LG', 'Europe/Athens'], ['LM', 'Europe/Malta'], ['GM', 'Africa/Casablanca'],
  ['DT', 'Africa/Tunis'], ['DA', 'Africa/Algiers'], ['LK', 'Europe/Prague'], ['LH', 'Europe/Budapest'], ['LD', 'Europe/Zagreb'], ['LT', 'Europe/Istanbul'],
  ['LC', 'Asia/Nicosia'], ['LL', 'Asia/Jerusalem'], ['HE', 'Africa/Cairo'], ['OJ', 'Asia/Amman'], ['LR', 'Europe/Bucharest'], ['LB', 'Europe/Sofia'],
  ['EF', 'Europe/Helsinki'], ['EV', 'Europe/Riga'], ['BI', 'Atlantic/Reykjavik'], ['GO', 'Africa/Dakar'], ['DI', 'Africa/Abidjan'], ['FI', 'Indian/Mauritius'],
  ['HK', 'Africa/Nairobi'], ['OT', 'Asia/Qatar'], ['OM', 'Asia/Dubai'], ['VI', 'Asia/Kolkata'], ['WS', 'Asia/Singapore'], ['VH', 'Asia/Hong_Kong'],
  ['RK', 'Asia/Seoul'], ['RJ', 'Asia/Tokyo'], ['VT', 'Asia/Bangkok'], ['SO', 'America/Cayenne'], ['SB', 'America/Sao_Paulo'], ['SA', 'America/Argentina/Buenos_Aires'],
  ['MM', 'America/Mexico_City'], ['MD', 'America/Santo_Domingo'], ['TF', 'America/Guadeloupe'], ['FM', 'Indian/Reunion'], ['FA', 'Africa/Johannesburg'],
  ['CY', 'America/Toronto'], ['K', 'America/New_York']
];
const tzOf = (icao) => TZ_ICAO[icao] || (TZ_PREFIX.find(([p]) => icao.startsWith(p)) || [null, 'UTC'])[1];

// heures d'ouverture locales [ouverture, fermeture] ; absent = ouvert 24 h/24
const HOURS = {
  // couvre-feux et restrictions de nuit des grands aéroports
  LFPO: ['06:00', '23:30'], LFMN: ['06:00', '23:30'], LFBO: ['06:00', '24:00'], EDDF: ['05:00', '23:00'], EDDM: ['06:00', '24:00'], EDDB: ['05:00', '24:00'],
  EDDH: ['06:00', '23:00'], LSZH: ['06:00', '23:30'], LSGG: ['06:00', '24:00'], EGLL: ['06:00', '23:30'], EBBR: ['06:00', '23:00'], LPPT: ['06:00', '24:00'],
  LIRN: ['06:00', '24:00'], LFSB: ['05:00', '24:00'], LFRS: ['06:00', '24:00'], LPPD: ['06:00', '24:00'], TFFR: ['05:30', '24:00'], TFFF: ['05:30', '24:00'],
  // aéroports régionaux fermés la nuit
  LFKJ: ['06:30', '22:00'], LFKB: ['06:30', '22:00'], LFBP: ['06:00', '22:00'], LFBZ: ['06:00', '23:00'], LFRB: ['06:00', '23:00'], LFMT: ['06:00', '23:00'],
  LFTH: ['06:00', '23:00'], LFLC: ['06:00', '22:30'], LFRN: ['06:00', '23:00'], LFQQ: ['06:00', '23:00'], LFLB: ['07:00', '21:00'], LFMP: ['06:00', '22:30'],
  LFST: ['06:00', '23:00'], LFBD: ['06:00', '24:00'], GCRR: ['07:00', '23:00'], LPMA: ['07:00', '23:00'], TNCM: ['07:00', '22:00'], SOCA: ['06:00', '23:00'],
  LDDU: ['06:00', '23:00'], LGIR: ['06:00', '24:00'], LGRP: ['06:00', '24:00'], DTTJ: ['06:00', '24:00'], GMAD: ['06:00', '24:00'], GMFF: ['06:00', '23:00'],
  DAOO: ['06:00', '23:00'], LICJ: ['06:00', '24:00'], LICC: ['06:00', '24:00'], EVRA: ['06:00', '24:00'], LBSF: ['06:00', '24:00']
};
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

const fmtCache = {};
function localMin(icao, ms) {
  const tz = tzOf(icao);
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const [h, m] = f.format(new Date(ms)).split(':').map(Number);
  return h * 60 + m;
}
const localHM = (icao, ms) => { const m = localMin(icao, ms); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

// aéroport ouvert à cet instant ?
function open(icao, ms) {
  const h = HOURS[icao]; if (!h) return true;
  const t = localMin(icao, ms), o = toMin(h[0]), c = toMin(h[1]);
  return c > o ? t >= o && t < c : t >= o || t < c;
}
// règle de la compagnie : court et moyen-courrier entre 06:00 et 22:30 au départ, arrivée avant minuit (heure locale)
function companyOk(from, to, dep, arr, cat) {
  if (cat === 'long') return true;
  const d = localMin(from, dep), a = localMin(to, arr);
  return d >= 360 && d <= 1350 && a >= 360 && a <= 1439 && arr - dep < 18 * 3600000;
}
// le vol peut-il partir à « dep » ? (départ ouvert au décollage, arrivée ouverte à l'atterrissage)
const legOk = (from, to, dep, blockMin, cat) => { const arr = dep + blockMin * 60000; return open(from, dep) && open(to, arr) && companyOk(from, to, dep, arr, cat); };
// premier départ possible à partir de t (par pas de 5 min), au plus tard maxWaitMin après ; null sinon
function earliest(from, to, t, blockMin, cat, maxWaitMin) {
  const step = 5 * 60000, end = t + (maxWaitMin == null ? 36 * 60 : maxWaitMin) * 60000;
  for (let x = Math.ceil(t / step) * step; x <= end; x += step) if (legOk(from, to, x, blockMin, cat)) return x;
  return null;
}

module.exports = { tzOf, localMin, localHM, open, legOk, earliest, HOURS };

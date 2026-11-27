'use strict';
// Générateur de vols du « Planning du jour » : le pilote choisit l'avion de la compagnie et le type de vol
// (court, moyen ou long-courrier) ; on propose des vols au hasard au départ de l'aéroport où se trouve l'avion.
const lat = require('./lat');

// ce que chaque avion de la compagnie peut faire (pas de 777 sur un Paris-Lyon, pas d'A320 sur un Paris-Tokyo)
const TYPES = {
  A320: { label: 'Airbus A320', cats: ['court', 'moyen'], maxKm: 5200, kmh: 780, taxi: 25 },
  B77W: { label: 'Boeing 777-300ER', cats: ['moyen', 'long'], maxKm: 13500, kmh: 880, taxi: 35 }
};
// aéroports qui reçoivent des gros-porteurs : le 777 ne va que là (pas de 777 à Toulon ou à Brest)
const WIDE = new Set(('LFPG LFPO LFMN LFBO LFML LFLL LFBD EGLL EHAM EDDF EDDM LEMD LEBL LIRF LIMC LSGG LSZH EBBR LPPT LOWW EKCH ENGM ESSA EPWA LGAV LEPA LMML GMMN DTTA DAAG ' +
  'KJFK KLAX KMIA CYUL TFFR TFFF FMEE RJTT FAOR SBGR OMDB VTBS MMMX KSFO EIDW EGCC EDDB EDDH LKPR LHBP LIPZ LIRN LEMG LPPR LTFM LTAI LCLK LLBG HECA OJAI LROP EFHK BIKF ' +
  'GCLP GCTS GOBD DIAP FIMP HKJK OTHH VIDP WSSS VHHH RKSI SOCA SBGL SAEZ MMUN MDPC KBOS KIAD KATL KORD CYYZ CYVR TNCM').split(' '));
const CAT_KM = { court: [150, 1500], moyen: [1500, 4000], long: [4000, 99999] };

// tirage au sort reproductible (même graine → mêmes vols : « Autres vols » change la graine)
function rng(seed) {
  let a = 0; for (const c of String(seed)) a = (Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0);
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 1000003; return h; };

// numéro de vol : celui du programme si la ligne existe, sinon un numéro fixe pour cette ligne
// (LAT5xxx court-courrier, LAT6xxx moyen-courrier, LAT8xxx long-courrier)
function flightNumber(from, to, cat, program) {
  const p = (program || []).find((f) => f.from === from && f.to === to);
  if (p) return p.number;
  const h = hash(from + to);
  return 'LAT' + (cat === 'long' ? 8 : cat === 'moyen' ? 6 : 5) + String(h % 1000).padStart(3, '0');
}

// temps de bloc estimé (roulage compris), arrondi à 5 min
const blockMin = (distKm, type) => { const t = TYPES[type] || TYPES.A320; return Math.round((t.taxi + distKm * 1.06 / t.kmh * 60) / 5) * 5; };

// départ conseillé : dans 1 h, arrondi aux 5 minutes suivantes
const nextSlot = (now) => Math.ceil((now + 60 * 60000) / 300000) * 300000;

// opts : { type 'A320'|'B77W', cat, from (OACI), count, seed, now, program, airports }
function generate(opts) {
  const type = TYPES[opts.type] ? opts.type : 'A320';
  const spec = TYPES[type];
  const airports = opts.airports || lat.BUNDLED.airports;
  const from = String(opts.from || '').toUpperCase();
  const dep = airports[from];
  if (!dep) return { ok: false, error: 'Aéroport de départ inconnu : ' + from };
  const cat = spec.cats.includes(opts.cat) ? opts.cat : spec.cats[0];
  const [lo, hi] = CAT_KM[cat];
  const cands = Object.entries(airports).filter(([icao]) => icao !== from)
    .map(([icao, a]) => ({ icao, a, d: lat.km(dep, a) }))
    .filter((x) => x.d >= lo && x.d < hi && x.d <= spec.maxKm && (type !== 'B77W' || WIDE.has(x.icao)));
  // tirage sans remise ; les grandes villes un peu plus souvent que les autres
  const r = rng([from, type, cat, opts.seed || 0].join('|'));
  const pool = cands.map((x) => ({ x, w: r() * (/^(LF|EG|ED|LE|LI|KJ|KL|RJ|OM)/.test(x.icao) ? 1.25 : 1) })).sort((p, q) => q.w - p.w).map((p) => p.x);
  const depAt = nextSlot(opts.now || Date.now());
  const used = new Set();
  const flights = pool.slice(0, opts.count || 6).map(({ icao, a, d }) => {
    const prog = (opts.program || []).find((f) => f.from === from && f.to === icao);
    const block = prog && prog.block ? prog.block : blockMin(d, type); // durée du programme si la ligne existe (vents compris)
    let number = flightNumber(from, icao, cat, opts.program);
    while (used.has(number)) number = number.slice(0, 4) + String((+number.slice(4) + 1) % 1000).padStart(3, '0');
    used.add(number);
    return {
      key: 'gen-' + number + '-' + depAt, number, from, to: icao, fromName: dep.city || dep.name, toName: a.city || a.name, toAirport: a.name,
      fromPos: [dep.lat, dep.lon], toPos: [a.lat, a.lon], distKm: d, cat, type, model: spec.label, blockMin: block,
      depEst: depAt, arrEst: depAt + block * 60000, dep: new Date(depAt).toISOString().slice(11, 16), block, generated: true
    };
  });
  return { ok: true, from, fromName: dep.city || dep.name, type, cat, cats: spec.cats, total: cands.length, flights };
}

module.exports = { generate, TYPES, CAT_KM, WIDE, blockMin, flightNumber };

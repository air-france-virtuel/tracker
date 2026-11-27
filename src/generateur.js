'use strict';
// Générateur de vols du « Planning du jour » : le pilote choisit l'avion de la compagnie et le type de vol
// (court, moyen ou long-courrier) ; on propose des vols au hasard au départ de l'aéroport où se trouve l'avion.
const lat = require('./lat');
const H = require('./horaires');

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

// un vol, avec ses heures UTC et locales
function leg(number, from, to, A, B, distKm, cat, type, model, block, depAt) {
  const arr = depAt + block * 60000;
  return {
    key: 'gen-' + number + '-' + depAt, number, from, to, fromName: A.city || A.name, toName: B.city || B.name, toAirport: B.name,
    fromPos: [A.lat, A.lon], toPos: [B.lat, B.lon], distKm, cat, type, model, blockMin: block,
    depEst: depAt, arrEst: arr, dep: new Date(depAt).toISOString().slice(11, 16), block, generated: true,
    depLocal: H.localHM(from, depAt), arrLocal: H.localHM(to, arr)
  };
}

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
  const slot = nextSlot(opts.now || Date.now());
  const used = new Set();
  const flights = [];
  // chaque vol part au premier horaire où les deux aéroports sont ouverts (et pas de court ou moyen-courrier en pleine nuit)
  for (const { icao, a, d } of pool) {
    if (flights.length >= (opts.count || 6)) break;
    const prog = (opts.program || []).find((f) => f.from === from && f.to === icao);
    const block = prog && prog.block ? prog.block : blockMin(d, type); // durée du programme si la ligne existe (vents compris)
    const depAt = opts.noHours ? slot : H.earliest(from, icao, slot, block, cat, opts.maxWait);
    if (depAt == null) continue;
    let number = flightNumber(from, icao, cat, opts.program);
    while (used.has(number)) number = number.slice(0, 4) + String((+number.slice(4) + 1) % 1000).padStart(3, '0');
    used.add(number);
    flights.push(leg(number, from, icao, dep, a, d, cat, type, spec.label, block, depAt));
  }
  if (!opts.keepOrder) flights.sort((x, y) => x.depEst - y.depEst || x.distKm - y.distKm);
  return { ok: true, from, fromName: dep.city || dep.name, type, cat, cats: spec.cats, total: cands.length, flights };
}

// Journée complète : des allers-retours au départ de l'aéroport de l'avion, enchaînés avec un temps d'escale réaliste.
// opts : comme generate, plus legs (nombre de vols, pair). Court : 2, 4 ou 6 vols ; moyen et long : un aller-retour.
const TURN = { court: 45, moyen: 60, long: 90 }; // minutes entre l'arrivée et le départ suivant
function day(opts) {
  const base = generate(Object.assign({}, opts, { count: 60, noHours: true, keepOrder: true }));
  if (!base.ok) return base;
  const cat = base.cat;
  // c'est la compagnie qui fixe la rotation, comme dans la réalité : en court-courrier 2, 4 ou 6 vols (le plus souvent 4)
  const pick = rng([base.from, base.type, cat, opts.seed || 0, 'rotation'].join('|'))();
  const imposed = cat === 'court' ? (pick < 0.2 ? 2 : pick < 0.7 ? 4 : 6) : 2;
  const legs = Math.max(2, Math.min(cat === 'court' ? 6 : 2, Math.round((+opts.legs || imposed) / 2) * 2));
  // plusieurs allers-retours courts dans la journée : on préfère les destinations proches
  const near = cat === 'court' && legs >= 4 ? base.flights.filter((f) => f.distKm <= (legs >= 6 ? 900 : 1200)) : [];
  const cands = near.concat(base.flights.filter((f) => !near.includes(f)));
  const airports = opts.airports || lat.BUNDLED.airports;
  const A0 = airports[base.from];
  const DUTY = 13 * 3600000;
  const used = new Set(), done = new Set();
  const num = (from, to) => { let n = flightNumber(from, to, cat, opts.program); while (used.has(n)) n = n.slice(0, 4) + String((+n.slice(4) + 1) % 1000).padStart(3, '0'); return n; };
  const blockOf = (from, to, d) => { const p = (opts.program || []).find((x) => x.from === from && x.to === to); return p && p.block ? p.block : blockMin(d, base.type); };
  const out = [];
  let t = base.flights[0].depEst; // prochain créneau (dans 1 h)
  // aller-retour par aller-retour : la destination doit être ouverte à l'arrivée, puis au départ du retour, et la base au retour ;
  // pas plus de 1 h 30 d'attente en plus de l'escale entre deux vols, ni plus de 13 h de service en court-courrier
  while (out.length < legs) {
    let ok = null;
    for (const f of cands) {
      if (done.has(f.to)) continue;
      const bOut = blockOf(base.from, f.to, f.distKm), bBack = blockOf(f.to, base.from, f.distKm);
      const d1 = H.earliest(base.from, f.to, t, bOut, cat, out.length ? 90 : null);
      if (d1 == null) continue;
      const d2 = H.earliest(f.to, base.from, d1 + (bOut + TURN[cat]) * 60000, bBack, cat, cat === 'long' ? 12 * 60 : 90);
      if (d2 == null) continue;
      if (cat === 'court' && out.length && d2 + bBack * 60000 - out[0].depEst > DUTY) continue;
      ok = { f, bOut, bBack, d1, d2 }; break;
    }
    if (!ok) break;
    done.add(ok.f.to);
    const B = airports[ok.f.to];
    const n1 = num(base.from, ok.f.to); used.add(n1);
    out.push(leg(n1, base.from, ok.f.to, A0, B, ok.f.distKm, cat, base.type, ok.f.model, ok.bOut, ok.d1));
    const n2 = num(ok.f.to, base.from); used.add(n2);
    out.push(leg(n2, ok.f.to, base.from, B, A0, ok.f.distKm, cat, base.type, ok.f.model, ok.bBack, ok.d2));
    t = ok.d2 + (ok.bBack + TURN[cat]) * 60000;
  }
  if (!out.length) return { ok: false, error: 'Aucune rotation possible pour le moment : les aéroports sont fermés. Réessaie plus tard.' };
  const last = out[out.length - 1];
  return { ok: true, from: base.from, fromName: base.fromName, type: base.type, cat, cats: base.cats, legs: out,
    blockTotal: out.reduce((a2, f) => a2 + f.blockMin, 0), start: out[0].depEst, end: last.arrEst };
}

module.exports = { generate, day, TURN, TYPES, CAT_KM, WIDE, blockMin, flightNumber };

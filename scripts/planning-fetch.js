'use strict';
// Récupère le programme du jour des vols Air France au départ et à l'arrivée de Paris (CDG et Orly)
// avec AeroDataBox (offre gratuite, clé dans le secret GitHub AERODATABOX_KEY), puis écrit
// planning/AAAA-MM-JJ.json et planning/latest.json. Lancé une fois par jour par GitHub Actions.
// Usage : AERODATABOX_KEY=... node scripts/planning-fetch.js <dossier de sortie>
const fs = require('fs');
const path = require('path');

const KEY = process.env.AERODATABOX_KEY || '';
const HOST = 'aerodatabox.p.rapidapi.com';
const HUBS = ['LFPG', 'LFPO'];
const AIRPORTS_CSV = 'https://davidmegginson.github.io/ourairports-data/airports.csv'; // OurAirports, domaine public

// Modèle d'avion (texte AeroDataBox) → code OACI pour SimBrief
function icaoType(model) {
  const m = String(model || '').toUpperCase().replace(/\s+/g, ' ');
  const rules = [
    [/A220-100|BD-500-1A10/, 'BCS1'], [/A220|BD-500/, 'BCS3'],
    [/A318/, 'A318'], [/A319.*(NEO|NX)|A319N/, 'A19N'], [/A319/, 'A319'],
    [/A320.*(NEO|NX)|A320N/, 'A20N'], [/A320/, 'A320'], [/A321.*(NEO|NX)|A321N/, 'A21N'], [/A321/, 'A321'],
    [/A330-900|A330NEO/, 'A339'], [/A330-200/, 'A332'], [/A330-300/, 'A333'], [/A330/, 'A332'],
    [/A350-1000/, 'A35K'], [/A350/, 'A359'], [/A380/, 'A388'],
    [/777-300|777-3/, 'B77W'], [/777F|777-F/, 'B77L'], [/777-200LR/, 'B77L'], [/777/, 'B772'],
    [/787-10/, 'B78X'], [/787-9/, 'B789'], [/787-8|787/, 'B788'],
    [/E?MBRAER (ERJ )?190|E190|E-190/, 'E190'], [/E?MBRAER (ERJ )?195|E195/, 'E195'], [/E?MBRAER (ERJ )?175|E175/, 'E175'], [/E?MBRAER (ERJ )?170|E170/, 'E170'],
    [/CRJ.?1000/, 'CRJX'], [/CRJ.?700/, 'CRJ7'], [/ATR 72|ATR72/, 'AT76']
  ];
  for (const [re, t] of rules) if (re.test(m)) return t;
  return '';
}
function km(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))));
}
const category = (d) => (d == null ? 'inconnu' : d < 1500 ? 'court' : d < 4000 ? 'moyen' : 'long');
const utcMs = (t) => { if (!t) return null; const v = Date.parse(String(t).replace(' ', 'T').replace(/Z?$/, 'Z')); return Number.isFinite(v) ? v : null; };

// Un mouvement AeroDataBox → un vol du planning (null si ce n'est pas un vol Air France)
function toFlight(mv, hub, dir) {
  const al = mv.airline || {};
  const num = String(mv.number || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if ((al.iata && al.iata !== 'AF') || !/^AF\s?\d+/.test(num)) return null;
  if (mv.isCargo) return null;
  const dep = mv.departure || {}, arr = mv.arrival || {};
  // sans withLeg, la partie « hub » n'est pas répétée : on la complète
  const depAp = (dep.airport && dep.airport.icao) || (dir === 'Departure' ? hub : '');
  const arrAp = (arr.airport && arr.airport.icao) || (dir === 'Arrival' ? hub : '');
  if (!depAp || !arrAp) return null;
  const t = (x) => utcMs(x && (x.scheduledTime ? x.scheduledTime.utc : x.scheduledTimeUtc));
  const ac = mv.aircraft || {};
  return {
    number: num.replace(/^AF\s?/, 'AF '), from: depAp, to: arrAp,
    fromName: (dep.airport && (dep.airport.municipalityName || dep.airport.name)) || '',
    toName: (arr.airport && (arr.airport.municipalityName || arr.airport.name)) || '',
    depUtc: t(dep), arrUtc: t(arr), model: ac.model || '', type: icaoType(ac.model), reg: ac.reg || '',
    status: mv.status || ''
  };
}

async function airports() {
  const r = await fetch(AIRPORTS_CSV);
  if (!r.ok) throw new Error('OurAirports HTTP ' + r.status);
  const lines = (await r.text()).split('\n');
  const head = lines[0].split(',').map((h) => h.replace(/"/g, ''));
  const i = (n) => head.indexOf(n);
  const [iId, iLat, iLon, iMun, iType] = [i('ident'), i('latitude_deg'), i('longitude_deg'), i('municipality'), i('type')];
  const out = {};
  for (const l of lines.slice(1)) {
    const c = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g); if (!c) continue;
    const v = c.map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    if (!/airport/.test(v[iType] || '') || !/^[A-Z]{4}$/.test(v[iId])) continue;
    out[v[iId]] = [+v[iLat], +v[iLon], v[iMun]];
  }
  return out;
}

async function fidsWindow(hub, from, to) {
  const url = 'https://' + HOST + '/flights/airports/icao/' + hub + '/' + from + '/' + to +
    '?withLeg=true&direction=Both&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';
  const r = await fetch(url, { headers: { 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': HOST } });
  const txt = await r.text();
  if (!r.ok) throw new Error(hub + ' ' + from + ' : HTTP ' + r.status + ' ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : {};
}

function parisDate(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }

async function main() {
  const out = process.argv[2] || 'out';
  if (!KEY) { console.error('Secret AERODATABOX_KEY manquant.'); process.exit(1); }
  const day = parisDate(new Date());
  const flights = new Map();
  for (const hub of HUBS) {
    for (const [a, b] of [['00:00', '11:59'], ['12:00', '23:59']]) {
      const j = await fidsWindow(hub, day + 'T' + a, day + 'T' + b);
      let n = 0;
      for (const [list, dir] of [[j.departures || [], 'Departure'], [j.arrivals || [], 'Arrival']]) {
        for (const mv of list) { const f = toFlight(mv, hub, dir); if (f) { flights.set(f.number + '|' + f.from + '|' + f.to, f); n++; } }
      }
      console.log(hub, a + '-' + b, ':', (j.departures || []).length, 'départs,', (j.arrivals || []).length, 'arrivées,', n, 'vols Air France');
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  const ap = await airports().catch((e) => { console.error('Aéroports :', e.message); return {}; });
  const list = [...flights.values()].map((f) => {
    const a = ap[f.from], b = ap[f.to];
    const distKm = a && b ? km(a, b) : null;
    return Object.assign(f, {
      fromName: f.fromName || (a && a[2]) || '', toName: f.toName || (b && b[2]) || '',
      fromPos: a ? [a[0], a[1]] : null, toPos: b ? [b[0], b[1]] : null,
      distKm, cat: category(distKm), blockMin: f.depUtc && f.arrUtc ? Math.round((f.arrUtc - f.depUtc) / 60000) : null
    });
  }).sort((x, y) => (x.depUtc || 0) - (y.depUtc || 0));
  const doc = { day, generatedAt: new Date().toISOString(), source: 'AeroDataBox', hubs: HUBS, count: list.length, flights: list };
  fs.mkdirSync(path.join(out, 'planning'), { recursive: true });
  fs.writeFileSync(path.join(out, 'planning', day + '.json'), JSON.stringify(doc));
  fs.writeFileSync(path.join(out, 'planning', 'latest.json'), JSON.stringify(doc));
  console.log('Planning du', day, ':', list.length, 'vols Air France écrits.');
  if (!list.length) process.exit(2);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { toFlight, icaoType, category };

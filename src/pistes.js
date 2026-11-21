'use strict';
// Pistes en service, comme dans la vraie vie :
// 1. trafic réel : les avions en approche ou au décollage autour de l'aéroport (données ADS-B publiques d'adsb.lol)
//    montrent quelle piste est utilisée à l'instant ;
// 2. NOTAM du plan SimBrief : les pistes fermées sont écartées ;
// 3. à défaut de trafic, la piste la plus face au vent du METAR.
// Les pistes (numéros, seuils, orientations) viennent de la base libre OurAirports (domaine public).

const fs = require('fs');
const path = require('path');

const RUNWAYS_URL = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv';
const ADSB_POINT = 'https://api.adsb.lol/v2/point/';
const RUNWAYS_MAX_AGE = 30 * 86400000;

const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
function distNm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const angle = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

// ---------- base des pistes ----------
function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
// Renvoie les extrémités de piste utilisables d'un aéroport : [{ ident, hdg, lat, lon, other, lengthFt }]
function runwayEnds(csv, icao) {
  icao = String(icao || '').toUpperCase();
  if (!icao || !csv) return [];
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0]);
  const col = (n) => head.indexOf(n);
  const ix = { ap: col('airport_ident'), len: col('length_ft'), closed: col('closed'), surf: col('surface') };
  const ends = [];
  const needle = '"' + icao + '"';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].indexOf(needle) < 0) continue;
    const r = splitCsv(lines[i]);
    if (r[ix.ap] !== icao || r[ix.closed] === '1') continue;
    const len = +r[ix.len] || 0;
    if (len && len < 3000) continue; // pistes d'herbe, hélisurfaces : pas pour un avion de ligne
    const side = (p) => ({ ident: r[col(p + '_ident')], lat: parseFloat(r[col(p + '_latitude_deg')]), lon: parseFloat(r[col(p + '_longitude_deg')]), hdg: parseFloat(r[col(p + '_heading_degT')]) });
    const le = side('le'), he = side('he');
    if (!le.ident || !he.ident || /H$/i.test(le.ident) || !Number.isFinite(le.lat) || !Number.isFinite(he.lat)) continue;
    if (!Number.isFinite(le.hdg)) le.hdg = bearing(le, he);
    if (!Number.isFinite(he.hdg)) he.hdg = bearing(he, le);
    ends.push(Object.assign(le, { other: he.ident, lengthFt: len }), Object.assign(he, { other: le.ident, lengthFt: len }));
  }
  return ends;
}

// ---------- NOTAM : pistes fermées ----------
// notams : [{ text, from, to }] (dates en ms ou absentes). Renvoie [{ rwy, text, partial }]
function closedRunways(notams, ends, now) {
  now = now || Date.now();
  const known = new Set((ends || []).map((e) => e.ident));
  const out = [];
  for (const n of notams || []) {
    const text = String(n.text || '').toUpperCase().replace(/\s+/g, ' ');
    if (n.from && now < n.from) continue;
    if (n.to && now > n.to) continue;
    const re = /\bRWY\s+((?:\d{2}[LRC]?)(?:\s*\/\s*\d{2}[LRC]?)*)\s+(?:IS\s+)?(CLSD|CLOSED)\b/g;
    let m;
    while ((m = re.exec(text))) {
      // fermeture partielle (une partie de la piste, quelques heures par jour, ou seulement à certains avions)
      const partial = /\b(BTN|BETWEEN|FM|EXC|EXCEPT|DAILY|\d{4}-\d{4}|TWY|PORTION|PART|FOR ACFT)\b/.test(text);
      for (const r of m[1].split('/').map((x) => x.trim())) if (!known.size || known.has(r)) out.push({ rwy: r, text: text.slice(0, 160), partial });
    }
  }
  const seen = new Set();
  return out.filter((c) => { const k = c.rwy + (c.partial ? 'p' : ''); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- trafic réel ----------
// ac : [{ lat, lon, alt (ft, ou 'ground'), gs (kt), track (°), vr (ft/min) }], apt : { lat, lon, elev }
// Renvoie { arr: [{ rwy, n }], dep: [{ rwy, n }], seen } triés du plus utilisé au moins utilisé.
function runwaysFromTraffic(ac, apt, ends) {
  const arr = {}, dep = {};
  let seen = 0;
  for (const a of ac || []) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(a.track) || a.alt === 'ground') continue;
    const agl = (+a.alt || 0) - (apt.elev || 0);
    if (agl > 4500 || agl < -200 || !(a.gs > 90 && a.gs < 230)) continue;
    if (distNm(a, apt) > 14) continue;
    let best = null;
    for (const e of ends) {
      if (angle(a.track, e.hdg) > 15) continue;
      const d = distNm(a, e);
      const brg = bearing(e, a); // depuis le seuil vers l'avion
      // écart latéral avec l'axe de la piste prolongé (des deux côtés du seuil)
      const off = d * Math.sin(rad(angle(brg, e.hdg)));
      if (off > 0.8) continue;
      const before = angle(brg, (e.hdg + 180) % 360) < 90; // l'avion est en amont du seuil (côté approche)
      if (!best || off < best.off) best = { e, off, before, d };
    }
    if (!best) continue;
    const vr = Number.isFinite(a.vr) ? a.vr : 0;
    if (best.before && vr < -200 && best.d < 12) { arr[best.e.ident] = (arr[best.e.ident] || 0) + 1; seen++; }
    else if (!best.before && vr > 300 && agl < 4500) { dep[best.e.ident] = (dep[best.e.ident] || 0) + 1; seen++; }
  }
  const list = (o) => Object.entries(o).map(([rwy, n]) => ({ rwy, n })).sort((x, y) => y.n - x.n);
  return { arr: list(arr), dep: list(dep), seen };
}

// ---------- vent ----------
function windOf(metar) {
  const m = /\b(\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?KT\b/.exec(metar || '');
  return m ? { dir: m[1] === 'VRB' ? null : +m[1], kt: +m[2] } : null;
}
// Piste la plus face au vent parmi celles qui ne sont pas fermées (null si vent calme ou variable).
function runwayFromWind(metar, ends, closed) {
  const w = windOf(metar);
  const shut = new Set((closed || []).filter((c) => !c.partial).map((c) => c.rwy));
  const open = (ends || []).filter((e) => !shut.has(e.ident) && !shut.has(e.other));
  if (!open.length) return null;
  if (!w || w.dir == null || w.kt < 4) return { rwy: null, wind: w };
  const best = open.map((e) => ({ e, head: w.kt * Math.cos(rad(angle(w.dir, e.hdg))) })).sort((a, b) => b.head - a.head || b.e.lengthFt - a.e.lengthFt)[0];
  return { rwy: best.e.ident, head: Math.round(best.head), wind: w };
}

// ---------- synthèse pour un aéroport ----------
// kind : 'dep' ou 'arr'. Renvoie { icao, rwy, source, detail, closed, planRwy, differs }
function decide(o) {
  const { icao, kind, ends, closed, traffic, metar, planRwy } = o;
  const shut = new Set((closed || []).filter((c) => !c.partial).map((c) => c.rwy));
  const ok = (r) => r && !shut.has(r) && !shut.has((ends.find((e) => e.ident === r) || {}).other);
  const fromT = ((traffic && traffic[kind]) || []).filter((x) => ok(x.rwy));
  // un aéroport peut utiliser deux pistes à la fois (ex. Roissy) : on garde celles vues sur le trafic
  const twoWay = (traffic && traffic[kind === 'arr' ? 'dep' : 'arr']) || [];
  let rwy = null, source = '', detail = '';
  if (fromT.length) {
    rwy = fromT[0].rwy; source = 'trafic';
    detail = fromT.map((x) => x.rwy + ' (' + x.n + ' avion' + (x.n > 1 ? 's' : '') + ')').join(', ');
  } else if (!fromT.length && twoWay.length && kind === 'dep') {
    // pas de décollage vu : on prend le sens des arrivées (les avions décollent dans le même sens)
    const a = ends.find((e) => e.ident === twoWay[0].rwy);
    const same = a && ends.filter((e) => angle(e.hdg, a.hdg) < 30 && ok(e.ident));
    if (same && same.length) { rwy = same.map((e) => e.ident).includes(planRwy) ? planRwy : same[0].ident; source = 'sens'; detail = 'même sens que les arrivées en ' + twoWay[0].rwy; }
  } else if (!fromT.length && twoWay.length && kind === 'arr') {
    const a = ends.find((e) => e.ident === twoWay[0].rwy);
    const same = a && ends.filter((e) => angle(e.hdg, a.hdg) < 30 && ok(e.ident));
    if (same && same.length) { rwy = same.map((e) => e.ident).includes(planRwy) ? planRwy : same[0].ident; source = 'sens'; detail = 'même sens que les départs en ' + twoWay[0].rwy; }
  }
  if (!rwy) {
    const w = runwayFromWind(metar, ends, closed);
    if (w && w.rwy) {
      const best = ends.find((e) => e.ident === w.rwy), pl = ends.find((e) => e.ident === planRwy);
      if (best && pl && ok(planRwy) && angle(best.hdg, pl.hdg) < 30) w.rwy = planRwy; // même sens : on garde la piste du plan
    }
    if (w && w.rwy) { rwy = w.rwy; source = 'vent'; detail = 'vent du ' + String(w.wind.dir).padStart(3, '0') + ', ' + w.wind.kt + ' nœuds'; }
    else if (planRwy && ok(planRwy)) { rwy = planRwy; source = 'plan'; detail = w && w.wind ? 'vent faible' : ''; }
  }
  // même axe que la piste du plan (07L contre 07R) : pas un vrai changement de sens
  const sameDir = (a, b) => { const x = ends.find((e) => e.ident === a), y = ends.find((e) => e.ident === b); return x && y && angle(x.hdg, y.hdg) < 30; };
  const planClosed = !!planRwy && !ok(planRwy);
  return { icao, kind, rwy, source, detail, closed: closed || [], planRwy: planRwy || '', differs: !!(rwy && planRwy && rwy !== planRwy), reversed: !!(rwy && planRwy && !sameDir(rwy, planRwy)), planClosed };
}

// Phrase de Max pour un aéroport.
function sentence(d) {
  if (!d || !d.rwy) return '';
  const what = d.kind === 'dep' ? 'Au départ de ' + d.icao : 'À l’arrivée à ' + d.icao;
  const why = d.source === 'trafic' ? ', vue sur le trafic réel' : d.source === 'sens' ? ' (' + d.detail + ')' : d.source === 'vent' ? ', la plus face au vent' : '';
  let s = what + ', piste en service ' + d.rwy + why + '.';
  if (d.planClosed) s += ' Attention : la piste ' + d.planRwy + ' de ton plan SimBrief est fermée par NOTAM.';
  else if (d.reversed) s += ' Attention : ton plan SimBrief prévoit la ' + d.planRwy + ', dans l’autre sens. Refais le plan ou change la piste dans le FMS.';
  else if (d.differs) s += ' Ton plan prévoit la ' + d.planRwy + ', parallèle : vérifie avec l’ATIS.';
  return s;
}

// ---------- accès réseau ----------
class Pistes {
  constructor(dir, http) {
    this.dir = dir;
    this.http = http || ((u, o) => fetch(u, o));
    this.csv = null;
    this.loading = null;
  }
  async base() {
    if (this.csv) return this.csv;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const file = path.join(this.dir, 'pistes.csv');
      let st = null; try { st = fs.statSync(file); } catch (e) { /* pas encore téléchargée */ }
      if (st && Date.now() - st.mtimeMs < RUNWAYS_MAX_AGE) { this.csv = fs.readFileSync(file, 'utf8'); return this.csv; }
      try {
        const r = await this.http(RUNWAYS_URL, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(String(r.status));
        const t = await r.text();
        if (!/airport_ident/.test(t.slice(0, 400))) throw new Error('fichier inattendu');
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, t);
        this.csv = t;
      } catch (e) {
        if (st) this.csv = fs.readFileSync(file, 'utf8'); // ancienne version : mieux que rien
        else throw new Error('Liste des pistes indisponible (' + ((e && e.message) || e) + ').');
      }
      return this.csv;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  async traffic(apt) {
    try {
      const r = await this.http(ADSB_POINT + apt.lat.toFixed(4) + '/' + apt.lon.toFixed(4) + '/15', { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      return (j.ac || j.aircraft || []).map((a) => ({ lat: a.lat, lon: a.lon, alt: a.alt_baro, gs: a.gs, track: a.track, vr: a.baro_rate != null ? a.baro_rate : a.geom_rate }));
    } catch (e) { return null; }
  }
  // apt : { icao, lat, lon, elev, rwy (du plan), metar, notams: [{ text, from, to }] }, kind : 'dep' | 'arr'
  async active(apt, kind) {
    const ends = runwayEnds(await this.base(), apt.icao);
    if (!ends.length) return { icao: apt.icao, kind, rwy: null, error: 'Pistes de ' + apt.icao + ' inconnues.' };
    const closed = closedRunways(apt.notams, ends);
    const ac = apt.lat != null ? await this.traffic(apt) : null;
    const traffic = ac ? runwaysFromTraffic(ac, apt, ends) : null;
    const d = decide({ icao: apt.icao, kind, ends, closed, traffic, metar: apt.metar, planRwy: apt.rwy });
    d.trafficOk = !!ac;
    d.at = Date.now();
    d.say = sentence(d);
    return d;
  }
}

module.exports = { Pistes, runwayEnds, closedRunways, runwaysFromTraffic, runwayFromWind, decide, sentence, RUNWAYS_URL };

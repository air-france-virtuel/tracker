'use strict';
// Lecture du dernier plan de vol SimBrief d'un pilote (API publique de SimBrief).

const num = (v, d = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)));
const asArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

// NOTAM du dossier SimBrief pour un aéroport : [{ text, from, to }] (dates en ms quand elles sont données)
function notamsFor(j, icao, side) {
  const mine = asArray((j[side] || {}).notam).map((n) => [n, true]);
  const all = mine.concat(asArray((j.notams || {}).notamdrec).concat(asArray((j.notams || {}).notam)).map((n) => [n, false]));
  const t = (v) => { const n = Date.parse(str(v)); return Number.isFinite(n) ? n : null; };
  const out = [];
  for (const [n, own] of all) {
    if (!n || typeof n !== 'object') continue;
    const loc = str(n.location_icao || n.icao_id || n.location_id || n.icao || '').toUpperCase();
    if (loc ? loc !== icao : !own) continue;
    const text = str(n.notam_raw || n.notam_text || n.text || n.raw || '');
    if (text) out.push({ text: text.slice(0, 600), from: t(n.date_effective), to: t(n.date_expire) });
  }
  return out.slice(0, 200);
}

// Transforme la réponse JSON de SimBrief en un plan simple utilisé par le tracker.
function parseOfp(j) {
  if (!j || typeof j !== 'object') throw new Error('Réponse SimBrief vide');
  if (j.fetch && j.fetch.status && !/success/i.test(str(j.fetch.status))) {
    throw new Error('SimBrief : ' + str(j.fetch.status));
  }
  const o = j.origin || {};
  const d = j.destination || {};
  const g = j.general || {};
  const units = /lb/i.test(str((j.params || {}).units)) ? 'lbs' : 'kgs';
  const toKg = (v) => (units === 'lbs' ? num(v) * 0.4536 : num(v));
  const fixes = asArray((j.navlog || {}).fix).map((f) => ({
    ident: str(f.ident),
    lat: num(f.pos_lat),
    lon: num(f.pos_long),
    alt: num(f.altitude_feet),
    stage: str(f.stage),
    via: str(f.via_airway),
    sidStar: str(f.is_sid_star) === '1',
    fuelKg: f.fuel_plan_onboard != null ? Math.round(toKg(f.fuel_plan_onboard)) : null,
    // pour les questions à Max sur le plan
    windDir: f.wind_dir != null ? num(f.wind_dir) : null, windKt: f.wind_spd != null ? num(f.wind_spd) : null,
    oat: f.oat != null ? num(f.oat) : null, eltSec: f.time_total != null ? num(f.time_total) : null,
    name: str(f.name), freq: str(f.frequency)
  })).filter((f) => f.lat || f.lon);

  // Paliers de montée : en croisière, chaque point où l'altitude prévue augmente.
  const steps = [];
  let prevAlt = 0;
  let inCruise = false;
  for (const f of fixes) {
    if (f.ident === 'TOC') { inCruise = true; prevAlt = f.alt; continue; }
    if (f.ident === 'TOD') break;
    if (inCruise && f.alt > prevAlt + 900) steps.push({ ident: f.ident, lat: f.lat, lon: f.lon, alt: f.alt });
    if (inCruise) prevAlt = Math.max(prevAlt, f.alt);
  }
  const tod = fixes.find((f) => f.ident === 'TOD') || null;
  const toc = fixes.find((f) => f.ident === 'TOC') || null;
  // SID et STAR prévues (points de la procédure dans le navlog)
  const sidFix = fixes.find((f) => f.sidStar && f.stage === 'CLB' && f.via && f.via !== 'DCT');
  const starFix = fixes.slice().reverse().find((f) => f.sidStar && f.stage === 'DSC' && f.via && f.via !== 'DCT');

  return {
    callsign: str((j.atc || {}).callsign) || (str(g.icao_airline) + str(g.flight_number)),
    flightNumber: str(g.icao_airline) + str(g.flight_number),
    aircraft: str((j.aircraft || {}).icaocode),
    registration: str((j.aircraft || {}).reg),
    origin: { icao: str(o.icao_code), name: str(o.name), lat: num(o.pos_lat), lon: num(o.pos_long), elev: num(o.elevation), rwy: str(o.plan_rwy), notams: notamsFor(j, str(o.icao_code).toUpperCase(), 'origin') },
    destination: { icao: str(d.icao_code), name: str(d.name), lat: num(d.pos_lat), lon: num(d.pos_long), elev: num(d.elevation), rwy: str(d.plan_rwy), notams: notamsFor(j, str(d.icao_code).toUpperCase(), 'destination') },
    cruiseAlt: num(g.initial_altitude),
    stepString: str(g.stepclimb_string),
    route: str(g.route),
    distanceNm: num(g.air_distance) || num(g.route_distance),
    eteSec: num((j.times || {}).est_time_enroute),
    fuelPlanKg: Math.round(toKg((j.fuel || {}).plan_ramp)),
    metarDep: str((j.weather || {}).orig_metar),
    metarArr: str((j.weather || {}).dest_metar),
    route_points: fixes.map((f) => ({ ident: f.ident, lat: f.lat, lon: f.lon, alt: f.alt, fuelKg: f.fuelKg, windDir: f.windDir, windKt: f.windKt, oat: f.oat, eltSec: f.eltSec, name: f.name, via: f.via })),
    toc, tod, steps,
    sid: sidFix ? sidFix.via : '', star: starFix ? starFix.via : '',
    climbProfile: str(g.climb_profile), cruiseProfile: str(g.cruise_profile), descentProfile: str(g.descent_profile),
    transAlt: num(o.trans_alt) || null, transLevel: num(d.trans_level) || null,
    // pour le briefing de Max
    alternate: { icao: str((j.alternate || {}).icao_code), name: str((j.alternate || {}).name), rwy: str((j.alternate || {}).plan_rwy) },
    pax: num((j.weights || {}).pax_count),
    zfwKg: Math.round(toKg((j.weights || {}).est_zfw)) || null,
    towKg: Math.round(toKg((j.weights || {}).est_tow)) || null,
    costIndex: str(g.costindex),
    avgWindComp: num(g.avg_wind_comp),
    schedOut: num((j.times || {}).sched_out) ? num((j.times || {}).sched_out) * 1000 : null,
    metarAltn: str((j.weather || {}).altn_metar),
    tafDep: str((j.weather || {}).orig_taf), tafArr: str((j.weather || {}).dest_taf),
    blockSec: num((j.times || {}).est_block) || null,
    fuel: (() => { const F = j.fuel || {}; const k = (v) => (v != null && v !== '' ? Math.round(toKg(v)) : null);
      return { taxi: k(F.taxi), trip: k(F.enroute_burn), contingency: k(F.contingency), alternate: k(F.alternate_burn), reserve: k(F.reserve), extra: k(F.extra), minTakeoff: k(F.min_takeoff), takeoff: k(F.plan_takeoff), landing: k(F.plan_landing), ramp: k(F.plan_ramp) }; })()
  };
}

async function fetchOfp(username, fetchImpl) {
  const u = str(username);
  if (!u) throw new Error('Indique ton nom d’utilisateur SimBrief dans les réglages.');
  const f = fetchImpl || fetch;
  const url = 'https://www.simbrief.com/api/xml.fetcher.php?json=1&username=' + encodeURIComponent(u);
  const res = await f(url);
  if (!res.ok) {
    let msg = 'SimBrief ne répond pas (code ' + res.status + ').';
    try {
      const body = await res.json();
      if (body && body.fetch && body.fetch.status) msg = 'SimBrief : ' + body.fetch.status;
    } catch (e) { /* rien */ }
    throw new Error(msg);
  }
  return parseOfp(await res.json());
}

module.exports = { parseOfp, fetchOfp };

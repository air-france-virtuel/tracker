'use strict';
// Lecture du dernier plan de vol SimBrief d'un pilote (API publique de SimBrief).

const num = (v, d = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)));
const asArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

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
    fuelKg: f.fuel_plan_onboard != null ? Math.round(toKg(f.fuel_plan_onboard)) : null
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

  return {
    callsign: str((j.atc || {}).callsign) || (str(g.icao_airline) + str(g.flight_number)),
    flightNumber: str(g.icao_airline) + str(g.flight_number),
    aircraft: str((j.aircraft || {}).icaocode),
    registration: str((j.aircraft || {}).reg),
    origin: { icao: str(o.icao_code), name: str(o.name), lat: num(o.pos_lat), lon: num(o.pos_long), elev: num(o.elevation), rwy: str(o.plan_rwy) },
    destination: { icao: str(d.icao_code), name: str(d.name), lat: num(d.pos_lat), lon: num(d.pos_long), elev: num(d.elevation), rwy: str(d.plan_rwy) },
    cruiseAlt: num(g.initial_altitude),
    stepString: str(g.stepclimb_string),
    route: str(g.route),
    distanceNm: num(g.air_distance) || num(g.route_distance),
    eteSec: num((j.times || {}).est_time_enroute),
    fuelPlanKg: Math.round(toKg((j.fuel || {}).plan_ramp)),
    metarDep: str((j.weather || {}).orig_metar),
    metarArr: str((j.weather || {}).dest_metar),
    route_points: fixes.map((f) => ({ ident: f.ident, lat: f.lat, lon: f.lon, alt: f.alt, fuelKg: f.fuelKg })),
    toc, tod, steps
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

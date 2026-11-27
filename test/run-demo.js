'use strict';
// Test : fait passer le vol de démonstration dans le moteur et vérifie les phases.
const assert = require('assert');
const { FlightEngine, PHASES } = require('../src/flight');
const { DemoFlight, demoPlan } = require('../src/demo');
const { parseOfp } = require('../src/simbrief');

function run(hard) {
  const plan = demoPlan();
  const eng = new FlightEngine({ plan });
  const demo = new DemoFlight({ hardLanding: hard });
  const seen = [];
  const events = [];
  let n = 0;
  while (!demo.done && n < 20000) {
    const t = demo.step();
    for (const e of eng.update(t, t.time)) {
      events.push(e);
      if (e.type === 'phase') seen.push(e.name);
    }
    n++;
  }
  return { seen, events, report: eng.report(), n };
}

const a = run(false);
console.log('Phases :', a.seen.join(' > '));
console.log('Événements :', a.events.filter((e) => e.type !== 'phase').map((e) => e.type + (e.rate ? '(' + e.rate + ')' : '') + (e.key ? '(' + e.key + ')' : '')).join(', '));
console.log('Rapport :', JSON.stringify(a.report), 'secondes simulées', a.n);
assert.deepStrictEqual(a.seen, PHASES.slice(1));
assert.ok(a.events.some((e) => e.type === 'tod10'), 'alerte TOD 10 min');
assert.ok(a.events.some((e) => e.type === 'todNow'), 'alerte TOD atteint');
const land = a.events.find((e) => e.type === 'landing');
assert.ok(land && land.level === 'normal', 'atterrissage normal');

const b = run(true);
const landB = b.events.find((e) => e.type === 'landing');
console.log('Atterrissage dur :', landB);
assert.ok(landB && landB.level === 'dur');

// Lecture d'un plan SimBrief type
const ofp = parseOfp({
  fetch: { status: 'Success' },
  params: { units: 'kgs' },
  general: { icao_airline: 'AFV', flight_number: '650', initial_altitude: '35000', air_distance: '3800', climb_profile: '250/300/78', descent_profile: '78/300/250', cruise_profile: 'CI 30' },
  atc: { callsign: 'AFV650' },
  aircraft: { icaocode: 'A359', reg: 'F-HTYH' },
  origin: { icao_code: 'LFPG', pos_lat: '49.0', pos_long: '2.5', plan_rwy: '27L', elevation: '392', trans_alt: '5000' },
  destination: { icao_code: 'TFFR', pos_lat: '16.26', pos_long: '-61.53', plan_rwy: '12', elevation: '36', trans_level: '4000' },
  fuel: { plan_ramp: '60000' },
  weather: { orig_metar: 'LFPG ...', dest_metar: 'TFFR ...' },
  navlog: { fix: [
    { ident: 'OPALE', pos_lat: '49.2', pos_long: '2', altitude_feet: '9000', stage: 'CLB', via_airway: 'OPAL5A', is_sid_star: '1' },
    { ident: 'TOC', pos_lat: '48', pos_long: '0', altitude_feet: '35000', stage: 'CLB' },
    { ident: 'ABC', pos_lat: '40', pos_long: '-20', altitude_feet: '35000', stage: 'CRZ' },
    { ident: 'DEF', pos_lat: '35', pos_long: '-30', altitude_feet: '37000', stage: 'CRZ' },
    { ident: 'GHI', pos_lat: '30', pos_long: '-40', altitude_feet: '37000', stage: 'CRZ' },
    { ident: 'TOD', pos_lat: '18', pos_long: '-60', altitude_feet: '37000', stage: 'CRZ' },
    { ident: 'BOREL', pos_lat: '16.5', pos_long: '-61.4', altitude_feet: '6000', stage: 'DSC', via_airway: 'BOREL1A', is_sid_star: '1' }
  ] }
});
assert.strictEqual(ofp.steps.length, 1);
assert.strictEqual(ofp.steps[0].alt, 37000);
assert.strictEqual(ofp.tod.ident, 'TOD');
assert.strictEqual(ofp.destination.rwy, '12');
assert.strictEqual(ofp.sid, 'OPAL5A'); assert.strictEqual(ofp.star, 'BOREL1A');
assert.strictEqual(ofp.climbProfile, '250/300/78'); assert.strictEqual(ofp.transAlt, 5000); assert.strictEqual(ofp.transLevel, 4000);
console.log('SimBrief OK :', ofp.callsign, ofp.origin.icao, '->', ofp.destination.icao, 'palier', ofp.steps[0].ident);
// suivi démarré avion déjà en vol : la phase est rejointe directement (plus de « Boarding » à 4 000 ft)
{
  const { FlightEngine: FE } = require('../src/flight');
  const join = (t, plan) => { const e = new FE({ plan }); for (let i = 0; i < 8; i++) e.update(Object.assign({ lat: 41.4, lon: 2.1, onGround: false, fuelKg: 3000, engOn: true }, t), 100 + i); return e.phase; };
  assert.strictEqual(join({ alt: 4190, agl: 2600, gs: 180, vs: -700 }), 6, 'approche');
  assert.strictEqual(join({ alt: 15000, agl: 14990, gs: 300, vs: -1800 }), 5, 'descente');
  assert.strictEqual(join({ alt: 37000, agl: 36990, gs: 450, vs: 0 }, { cruiseAlt: 37000 }), 4, 'croisière');
  assert.strictEqual(join({ alt: 12000, agl: 11990, gs: 300, vs: 2000 }, { cruiseAlt: 37000 }), 3, 'montée');
  assert.strictEqual(join({ alt: 400, agl: 0, gs: 0, vs: 0, onGround: true }), 0, 'au sol : reste en boarding');
}
console.log('TOUS LES TESTS PASSENT');

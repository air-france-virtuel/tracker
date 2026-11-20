'use strict';
// Check-lists de Max : chaque phase a sa liste, cochée par le simulateur quand c'est possible, sinon par le pilote.
const assert = require('assert');
const C = require('../renderer/checklists');
const { DemoFlight } = require('../src/demo');

// une liste pour chacune des 9 phases
assert.deepStrictEqual(C.LISTS.map((l) => l.phase), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
// montée : le simulateur confirme train et volets rentrés, pilote auto, altimètre standard
const ck = C.create(3);
assert.ok(/train rentré, volets rentrés/.test(C.announce(ck)));
let n = C.update(ck, { t: { gearDown: false, flapsIdx: 0, ap: true, alt: 9000, baroMb: 1013.25 } });
assert.deepStrictEqual(n.map((i) => i.id), ['gear', 'flaps0', 'ap', 'std']);
assert.strictEqual(ck.complete, false, '250 kt reste à cocher');
C.toggle(ck, 'spd'); assert.strictEqual(ck.complete, true);
// au-dessus de 10 000 ft, Max ne parle plus des 250 kt
const hi = C.create(3);
C.update(hi, { t: { gearDown: false, flapsIdx: 0, ap: true, alt: 12000, baroMb: 1013.25 } });
assert.strictEqual(hi.complete, true); assert.ok(!/250/.test(C.announce(hi)));
// une donnée absente (avion qui ne la donne pas) ne coche rien et ne plante pas
const ap = C.create(6);
C.update(ap, { t: { gearDown: true } });
assert.deepStrictEqual(ap.items.filter((i) => i.done).map((i) => i.id), ['gear']);
assert.ok(/Check-list approche : altimètres sur QNH/.test(C.announce(ap)));
// parking : tout est vu dans le simulateur
const pk = C.create(8);
C.update(pk, { t: { parkBrake: true, engOn: false, beacon: false } });
assert.strictEqual(pk.complete, true);
assert.strictEqual(C.announce(pk), 'Check-list parking : tout est déjà bon.');
// carburant : comparé au plan SimBrief
const dep = C.create(0);
C.update(dep, { t: { fuelKg: 9100, beacon: false }, plan: { cruiseAlt: 35000 }, fuelPlanKg: 112800 });
assert.deepStrictEqual(dep.items.filter((i) => i.done).map((i) => i.id), ['plan']);
// vol de démonstration : les données des check-lists sont présentes
const d = new DemoFlight({}); const t = d.step();
for (const k of ['flapsIdx', 'landLt', 'beacon', 'strobe', 'baroMb', 'spoilers', 'ap']) assert.ok(k in t, k);
console.log('CHECK-LISTS DE MAX : TOUS LES TESTS PASSENT');

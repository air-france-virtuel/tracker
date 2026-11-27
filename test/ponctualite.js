'use strict';
const assert = require('assert');
const ponct = require('../src/ponctualite');
const carnet = require('../src/carnet');
const ach = require('../src/achievements');
const prog = [{ number: 'LAT1001', from: 'LFPG', to: 'LFBO', dep: '07:30', block: 85 }, { number: 'LAT012', from: 'LFPG', to: 'KJFK', dep: '23:40', block: 500 }];
const rep = (num, outIso, block) => ({ flightNumber: num, blockMinutes: block, date: new Date(Date.parse(outIso) + block * 60000).toISOString(), from: 'LFPG', to: 'LFBO', mode: 'reel' });

// à l'heure : départ +5, bloc identique
let p = ponct.check(rep('LAT1001', '2026-11-20T07:35:00Z', 85), prog);
assert.strictEqual(p.arrDelay, 5); assert.ok(p.onTime); assert.strictEqual(p.depDelay, 5);
assert.strictEqual(ponct.label(p), 'À l’heure (+5 min)');
// en retard : départ +30, 10 min de plus
p = ponct.check(rep('LAT1001', '2026-11-20T08:00:00Z', 95), prog);
assert.strictEqual(p.arrDelay, 40); assert.ok(!p.onTime); assert.strictEqual(ponct.label(p), 'En retard de 40 min');
// avance
p = ponct.check(rep('LAT 1001', '2026-11-20T07:25:00Z', 80), prog);
assert.strictEqual(p.arrDelay, -10); assert.strictEqual(ponct.label(p), 'À l’heure (10 min d’avance)');
// autour de minuit : départ prévu 23:40, réel 00:10 le lendemain
p = ponct.check(rep('LAT012', '2026-11-21T00:10:00Z', 500), prog);
assert.strictEqual(p.depDelay, 30); assert.strictEqual(new Date(p.schedDep).toISOString(), '2026-11-20T23:40:00.000Z');
// vol hors programme / sans numéro / trop loin de l'horaire
assert.strictEqual(ponct.check(rep('AFR123', '2026-11-20T07:35:00Z', 85), prog), null);
assert.strictEqual(ponct.check(rep('', '2026-11-20T07:35:00Z', 85), prog), null);
assert.strictEqual(ponct.check(rep('LAT1001', '2026-11-20T19:45:00Z', 85), prog), null);

// carnet : HTML complet, démo exclue, échappement
const reps = [rep('LAT1001', '2026-11-20T07:35:00Z', 85), Object.assign(rep('LAT1001', '2026-11-19T07:35:00Z', 85), { mode: 'demo' }), Object.assign(rep('LAT1001', '2026-11-18T08:00:00Z', 95), { registration: 'F-HLAT', planAircraft: 'A320', landingRate: -120, flightMinutes: 70 })];
const h = carnet.html(reps, { pilot: 'Jean <Test>', grade: 'Copilote', program: prog });
assert.ok(h.includes('Jean &lt;Test&gt;')); assert.ok(!h.includes('<Test>'));
assert.strictEqual((h.match(/<tr><td>\d+<\/td>/g) || []).length, 2, 'deux vols (démo exclue)');
assert.ok(h.includes('50 %'), 'ponctualité 1/2'); assert.ok(h.includes('F-HLAT')); assert.ok(h.includes('+40 min'));
assert.ok(carnet.html([], { pilot: 'X' }).includes('Aucun vol'));

// succès ponctualité
const withP = reps.filter((r) => r.mode !== 'demo').map((r) => Object.assign({}, r, { ponctualite: ponct.check(r, prog) }));
const list = ach.compute(withP, {});
assert.ok(list.find((a) => a.id === 'a-l-heure').done);
assert.strictEqual(list.find((a) => a.id === 'horloge').value, 1);
console.log('ponctualité + carnet : OK');

'use strict';
const assert = require('assert');
const g = require('../src/generateur');
const lat = require('../src/lat');
const prog = lat.BUNDLED.flights, A = lat.BUNDLED.airports;
const now = Date.UTC(2026, 10, 27, 18, 7);
for (const [type, cat, from] of [['A320', 'court', 'LFPG'], ['A320', 'moyen', 'LFMN'], ['B77W', 'long', 'LFPG'], ['B77W', 'moyen', 'KJFK'], ['B77W', 'long', 'TFFR']]) {
  const r = g.generate({ type, cat, from, now, program: prog });
  assert.ok(r.ok && r.flights.length === 6, type + ' ' + cat + ' ' + from);
  for (const f of r.flights) {
    assert.strictEqual(f.from, from); assert.ok(A[f.to]); assert.strictEqual(lat.category(f.distKm), cat, f.to + ' ' + f.distKm);
    assert.ok(f.distKm <= g.TYPES[type].maxKm); if (type === 'B77W') assert.ok(g.WIDE.has(f.to), '777 vers ' + f.to); assert.ok(/^LAT\d{3,4}$/.test(f.number), f.number); assert.ok(f.blockMin >= 30);
    assert.strictEqual(f.depEst, Date.UTC(2026, 10, 27, 19, 10)); assert.strictEqual(f.dep, '19:10'); assert.strictEqual(f.arrEst, f.depEst + f.blockMin * 60000);
  }
  assert.strictEqual(new Set(r.flights.map((f) => f.number)).size, 6, 'numéros uniques');
  assert.strictEqual(new Set(r.flights.map((f) => f.to)).size, 6, 'destinations différentes');
}
// pas de long-courrier en A320, pas de court-courrier en 777 : on retombe sur une catégorie possible
assert.strictEqual(g.generate({ type: 'A320', cat: 'long', from: 'LFPG', now }).cat, 'court');
assert.strictEqual(g.generate({ type: 'B77W', cat: 'court', from: 'LFPG', now }).cat, 'moyen');
// même graine → mêmes vols ; autre graine → autres vols
const a = g.generate({ type: 'A320', cat: 'court', from: 'LFPG', now, seed: 1 }), b = g.generate({ type: 'A320', cat: 'court', from: 'LFPG', now, seed: 1 }), c = g.generate({ type: 'A320', cat: 'court', from: 'LFPG', now, seed: 2 });
assert.deepStrictEqual(a.flights.map((f) => f.to), b.flights.map((f) => f.to));
assert.notDeepStrictEqual(a.flights.map((f) => f.to), c.flights.map((f) => f.to));
// ligne du programme : son numéro et sa durée
const p = prog.find((f) => f.from === 'LFPG' && f.to === 'KJFK');
assert.strictEqual(g.flightNumber('LFPG', 'KJFK', 'long', prog), p.number);
let found = null; for (let s = 0; s < 60 && !found; s++) found = g.generate({ type: 'B77W', cat: 'long', from: 'LFPG', now, seed: s, program: prog }).flights.find((f) => f.to === 'KJFK');
assert.ok(found && found.blockMin === p.block);
assert.ok(!g.generate({ type: 'A320', cat: 'court', from: 'XXXX', now }).ok);
for (const k of g.WIDE) assert.ok(A[k], 'aéroport gros-porteur inconnu ' + k);
for (let s = 0; s < 40; s++) for (const f of g.generate({ type: 'B77W', cat: 'long', from: 'KJFK', now, seed: s }).flights) assert.ok(g.WIDE.has(f.to));
console.log('générateur de vols : OK');

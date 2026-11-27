'use strict';
const assert = require('assert');
const { compute, LIST } = require('../src/achievements');
const r = (i, o) => Object.assign({ date: new Date(Date.UTC(2026, 10, 1 + Math.floor(i / 3), 8 + (i % 3) * 3)).toISOString(), mode: 'live', from: 'LFPG', to: 'LFMN', flightMinutes: 80, landingRate: -150, bounces: 0, overspeed250: false, maxTaxiSpeed: 25, planAircraft: 'A320', callsign: 'LAT1002' }, o);
// aucun vol
let L = compute([], { grade: 0 });
assert.strictEqual(L.length, LIST.length); assert.ok(L.every((a) => !a.done));
// vols de démo ignorés
L = compute([r(0, { mode: 'demo' })], { grade: 0 });
assert.ok(!L.find((a) => a.id === 'premier-vol').done);
const reps = [r(0, { landingRate: -90 }), r(1, { to: 'KJFK', flightMinutes: 500, planAircraft: 'B77W', landingRate: -300 }), r(2, { to: 'TFFR' }), r(3, { to: 'LFBO' })].reverse();
L = compute(reps, { grade: 2 });
const g = (id) => L.find((a) => a.id === id);
for (const id of ['premier-vol', 'premier-lat', 'premier-a320', 'premier-777', 'velours', 'long-courrier', 'atlantique', 'outre-mer', 'rotation', 'grade-po']) assert.ok(g(id).done, id);
assert.ok(!g('grade-cdb').done); assert.ok(!g('marathon').done);
assert.strictEqual(g('dest-5').value, 4);
assert.strictEqual(g('premier-777').doneAt, reps[2].date);
assert.strictEqual(g('serie-douce').value, 2); // série cassée par l'atterrissage à 300 ft/min
console.log('SUCCÈS : TOUS LES TESTS PASSENT');

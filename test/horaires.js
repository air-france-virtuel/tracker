'use strict';
const assert = require('assert');
const H = require('../src/horaires');
const g = require('../src/generateur');
const lat = require('../src/lat');
const A = lat.BUNDLED.airports;
for (const k of Object.keys(A)) assert.notStrictEqual(H.tzOf(k), 'UTC', 'fuseau horaire de ' + k);
for (const k of Object.keys(H.HOURS)) assert.ok(A[k], 'aéroport inconnu dans les horaires : ' + k);
// Orly : couvre-feu 23:30 – 06:00 heure de Paris (hiver UTC+1)
assert.ok(!H.open('LFPO', Date.UTC(2026, 10, 27, 23, 0)));   // 00:00 à Paris
assert.ok(H.open('LFPO', Date.UTC(2026, 10, 27, 5, 0)));     // 06:00
assert.ok(!H.open('LFPO', Date.UTC(2026, 10, 27, 4, 55)));
assert.ok(H.open('LFPG', Date.UTC(2026, 10, 27, 2, 0)));     // Roissy ouvert 24 h/24
assert.strictEqual(H.localHM('KJFK', Date.UTC(2026, 10, 27, 12, 0)), '07:00');
assert.strictEqual(H.localHM('TFFR', Date.UTC(2026, 10, 27, 12, 0)), '08:00');
// pas de court-courrier de nuit ; premier départ possible le lendemain matin à 06:00 heure locale
const night = Date.UTC(2026, 10, 27, 22, 0);
assert.ok(!H.legOk('LFPG', 'LFMN', night, 95, 'court'));
const e = H.earliest('LFPG', 'LFMN', night, 95, 'court');
assert.strictEqual(H.localHM('LFPG', e), '06:00');
// tous les vols générés respectent les horaires, de jour comme de nuit, en vol seul comme en rotation
const prog = lat.BUNDLED.flights;
for (const now of [Date.UTC(2026, 10, 27, 7, 3), Date.UTC(2026, 10, 27, 19, 20), Date.UTC(2026, 10, 27, 23, 50), Date.UTC(2026, 6, 14, 13, 0)]) {
  for (const [type, cat, from] of [['A320', 'court', 'LFPG'], ['A320', 'court', 'LFPO'], ['A320', 'moyen', 'LFMN'], ['B77W', 'long', 'LFPG'], ['B77W', 'moyen', 'KJFK']]) {
    const r = g.generate({ type, cat, from, now, program: prog });
    assert.ok(r.flights.length >= 4, 'vols ' + type + cat + from);
    for (const f of r.flights) { assert.ok(H.legOk(f.from, f.to, f.depEst, f.blockMin, cat), f.number + ' ' + f.from + f.to); assert.ok(f.depEst >= now + 3600000); }
    for (let s = 0; s < 8; s++) {
      const d = g.day({ type, cat, from, now, program: prog, seed: s });
      assert.ok(d.ok, 'rotation ' + type + cat + from);
      d.legs.forEach((f, i) => {
        assert.ok(H.legOk(f.from, f.to, f.depEst, f.blockMin, cat), 'rotation ' + f.number);
        if (i) { assert.strictEqual(f.from, d.legs[i - 1].to); assert.ok(f.depEst - d.legs[i - 1].arrEst >= g.TURN[cat] * 60000); }
      });
      if (cat === 'court') assert.ok(d.end - d.start <= 13 * 3600000);
    }
  }
}
console.log('horaires des aéroports : OK');

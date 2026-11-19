// Tests du mode carrière : grades, verrous, missions du jour et validation d'un vol.
const assert = require('assert');
const { compute, judge } = require('../src/career');
const missions = require('../src/data/missions.json');
const R = (o) => Object.assign({ mode: 'sim', date: '2026-11-19T10:00:00Z', blockMinutes: 60, landingRate: -150 }, o);
const now = new Date('2026-11-19T12:00:00Z').getTime();

let c = compute([], { accepted: [], active: null }, missions, now);
assert.strictEqual(c.gradeName, 'Cadet');
assert.strictEqual(c.missions.find((m) => m.id === 'p-cdg-nce').status, 'Verrouillée');
assert.ok(c.daily.length === 3 && c.daily.every((id) => c.missions.find((m) => m.id === id).grade === 0));
assert.deepStrictEqual(c.daily, compute([], {}, missions, now).daily, 'missions du jour stables pour une date');
console.log('Débutant :', c.gradeName, '· missions du jour', c.daily.join(', '));

// 100 h + 1 formation → Second Officier
const reps = [R({ blockMinutes: 6000 }), R({ mission: { id: 't-base', validated: true, points: 80 } })];
c = compute(reps, {}, missions, now);
assert.strictEqual(c.gradeName, 'Second Officier');
assert.strictEqual(c.missions.find((m) => m.id === 'p-cdg-nce').status, 'Disponible');
assert.strictEqual(c.points, 80);
// Les vols de démo ne comptent pas
c = compute([R({ mode: 'demo', blockMinutes: 99999 })], {}, missions, now);
assert.strictEqual(c.hours, 0);
// Qualification A350 après 4 vols de formation
const q = [R({ blockMinutes: 15000 })].concat([1, 2, 3, 4, 5].map(() => R({ mission: { id: 'p-cdg-nce', validated: true, points: 120 } })))
  .concat([R({ mission: { id: 't-base', validated: true, points: 80 } })]);
c = compute(q, {}, missions, now);
assert.strictEqual(c.gradeName, 'Premier Officier');
assert.ok(c.missions.find((m) => m.id === 'p-cdg-ptp').locked.includes('A350'));
c = compute(q.concat([1, 2, 3, 4].map(() => R({ mission: { id: 't-a350', validated: true, points: 150 } }))), {}, missions, now);
assert.ok(c.quals.includes('A350'));
assert.strictEqual(c.missions.find((m) => m.id === 'p-cdg-ptp').locked, '');
console.log('Progression OK :', c.gradeName, c.quals.join(', '), c.points + ' pts');

// Validation d'un vol
const m = missions.find((x) => x.id === 'p-cdg-nce');
assert.strictEqual(judge(m, R({ from: 'LFPG', to: 'LFMN', planAircraft: 'A20N' }), 2, 900).points, 240);
assert.ok(!judge(m, R({ from: 'LFPG', to: 'LFML' }), 1, 900).validated);
assert.ok(!judge(m, R({ from: 'LFPG', to: 'LFMN', planAircraft: 'B77W' }), 1, 900).validated);
assert.ok(!judge(m, R({ from: 'LFPG', to: 'LFMN', landingRate: -950 }), 1, 900).validated);
assert.ok(!judge(m, R({ mode: 'demo', from: 'LFPG', to: 'LFMN' }), 1, 900).validated);
console.log('CARRIÈRE : TOUS LES TESTS PASSENT');

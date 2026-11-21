'use strict';
// Pistes en service : trafic réel, NOTAM, vent.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../src/pistes');
const csv = fs.readFileSync(path.join(__dirname, 'fixtures', 'pistes.csv'), 'utf8');

const ends = P.runwayEnds(csv, 'LEBL');
assert.deepStrictEqual(ends.map((e) => e.ident).sort(), ['02', '06L', '06R', '20', '24L', '24R']);
assert.ok(!P.runwayEnds(csv, 'LFPG').some((e) => /H$/.test(e.ident)), 'pas d’hélisurface ni de piste en herbe');

// point à d nm d'un seuil, dans la direction brg
function pt(e, dnm, brg) {
  const R = 3440.065, d = dnm / R, b = (brg * Math.PI) / 180, la = (e.lat * Math.PI) / 180, lo = (e.lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (lo2 * 180) / Math.PI };
}
const E = (id) => ends.find((e) => e.ident === id);
const apt = { lat: 41.297, lon: 2.078, elev: 14 };
const ac = [
  Object.assign(pt(E('24R'), 6, 66), { alt: 2000, gs: 150, track: 246, vr: -750 }), // en finale 24R
  Object.assign(pt(E('24R'), 9, 66), { alt: 3000, gs: 170, track: 247, vr: -800 }),
  Object.assign(pt(E('24L'), 3, 246), { alt: 1800, gs: 170, track: 246, vr: 2000 }), // vient de décoller de la 24L
  { lat: 41.5, lon: 2.3, alt: 12000, gs: 300, track: 10, vr: 0 }, // trop haut
  Object.assign(pt(E('24R'), 1, 66), { alt: 'ground', gs: 10, track: 246 }) // au sol
];
const tr = P.runwaysFromTraffic(ac, apt, ends);
assert.deepStrictEqual(tr.arr, [{ rwy: '24R', n: 2 }]);
assert.deepStrictEqual(tr.dep, [{ rwy: '24L', n: 1 }]);

// trafic contre le plan : piste dans l'autre sens → Max prévient
let d = P.decide({ icao: 'LEBL', kind: 'arr', ends, closed: [], traffic: tr, metar: 'LEBL 211200Z 06008KT', planRwy: '06R' });
assert.strictEqual(d.rwy, '24R'); assert.strictEqual(d.source, 'trafic'); assert.ok(d.reversed);
assert.ok(/24R.*trafic réel.*06R.*autre sens/.test(P.sentence(d)));
// même sens, piste parallèle : simple vérification
d = P.decide({ icao: 'LEBL', kind: 'arr', ends, closed: [], traffic: tr, planRwy: '24L' });
assert.ok(d.differs && !d.reversed);
// aucun départ vu : même sens que les arrivées, piste du plan gardée si elle va dans ce sens
d = P.decide({ icao: 'LEBL', kind: 'dep', ends, closed: [], traffic: { arr: tr.arr, dep: [] }, planRwy: '24L' });
assert.strictEqual(d.rwy, '24L'); assert.strictEqual(d.source, 'sens'); assert.ok(!d.differs);

// NOTAM : piste fermée écartée, fermetures partielles signalées sans être écartées, dates respectées
const now = Date.parse('2026-11-21T12:00:00Z');
const closed = P.closedRunways([
  { text: 'RWY 06R/24L CLSD DUE TO WIP' },
  { text: 'RWY 02/20 CLSD DAILY 2300-0600' },
  { text: 'RWY 06L/24R CLSD', from: now + 86400000 }, // pas encore en vigueur
  { text: 'TWY K CLSD' }
], ends, now);
assert.deepStrictEqual(closed.map((c) => c.rwy + (c.partial ? '*' : '')), ['06R', '24L', '02*', '20*']);
d = P.decide({ icao: 'LEBL', kind: 'dep', ends, closed, traffic: { arr: [], dep: [{ rwy: '24L', n: 3 }, { rwy: '24R', n: 1 }] }, planRwy: '24L' });
assert.strictEqual(d.rwy, '24R', 'la 24L fermée est écartée même si le trafic semble l’utiliser');
assert.ok(d.planClosed && /fermée par NOTAM/.test(P.sentence(d)));

// sans trafic : face au vent, en gardant la piste du plan si elle va dans le même sens
d = P.decide({ icao: 'LEBL', kind: 'dep', ends, closed: [], traffic: null, metar: 'LEBL 211200Z 25012KT 9999', planRwy: '24L' });
assert.strictEqual(d.rwy, '24L'); assert.strictEqual(d.source, 'vent');
d = P.decide({ icao: 'LEBL', kind: 'dep', ends, closed: [], traffic: null, metar: 'LEBL 211200Z 07015KT 9999', planRwy: '24L' });
assert.strictEqual(d.rwy, '06L'); assert.ok(d.reversed);
d = P.decide({ icao: 'LEBL', kind: 'dep', ends, closed: [], traffic: null, metar: 'LEBL 211200Z VRB02KT', planRwy: '24L' });
assert.strictEqual(d.rwy, '24L'); assert.strictEqual(d.source, 'plan');

// NOTAM lus dans le dossier SimBrief
const S = require('../src/simbrief');
const ofp = S.parseOfp({ origin: { icao_code: 'LFPG', plan_rwy: '09R', notam: [{ location_icao: 'LFPG', notam_raw: 'RWY 09R/27L CLSD' }] }, destination: { icao_code: 'LEBL' }, notams: { notamdrec: [{ icao_id: 'LEBL', notam_text: 'RWY 06R/24L CLSD' }, { icao_id: 'LFBO', notam_text: 'RWY 14L CLSD' }] }, general: {}, navlog: { fix: [] } });
assert.deepStrictEqual(ofp.origin.notams.map((n) => n.text), ['RWY 09R/27L CLSD']);
assert.deepStrictEqual(ofp.destination.notams.map((n) => n.text), ['RWY 06R/24L CLSD']);

// Max répond avec la piste en service
const A = require('../renderer/askmax.js');
const pistes = { arr: { say: 'À l’arrivée à LEBL, piste en service 24R, vue sur le trafic réel.' }, dep: { say: 'Au départ de LFPG, piste en service 27L, vue sur le trafic réel.' } };
const plan = { origin: { icao: 'LFPG', name: 'Paris', rwy: '09R' }, destination: { icao: 'LEBL', name: 'Barcelona', rwy: '06R' } };
assert.ok(/24R/.test(A.answer('quelle piste à l’arrivée', { plan, pistes }).text));
assert.ok(/27L/.test(A.answer('piste à LFPG', { plan, pistes }).text));

console.log('PISTES EN SERVICE : TOUS LES TESTS PASSENT');

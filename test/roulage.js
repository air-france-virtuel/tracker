'use strict';
// Carte de roulage : chemin réel sur les taxiways de Toulouse-Blagnac (données OpenStreetMap enregistrées)
const assert = require('assert');
const R = require('../src/roulage');
const d = require('./fixtures/lfbo-osm.json');
const p50 = d.ways.find((w) => w.ref === 'P50');
const start = { lat: p50.g[0][0], lon: p50.g[0][1] };
const r14 = R.route(d, start, { ident: '14R', lat: 43.644121, lon: 1.345931 });
assert.ok(r14.ok, r14.error);
assert.ok(r14.lengthM > 2000 && r14.lengthM < 5000, 'longueur ' + r14.lengthM);
assert.ok(R.distM(r14.end, { lat: 43.644121, lon: 1.345931 }) < 400, 'arrivée près du seuil');
assert.ok(r14.legs.some((l) => / à /.test(l)), 'lignes numérotées regroupées');
const r32 = R.route(d, start, { ident: '32L', lat: 43.618981, lon: 1.372106 });
assert.ok(r32.ok && r32.lengthM < r14.lengthM, 'piste 32L plus proche');
assert.ok(/^Roule via .* piste 32L/.test(R.sentence(r32, '32L')));
const far = R.route(d, { lat: 43.7, lon: 1.5 }, { ident: '14R', lat: 43.644121, lon: 1.345931 });
assert.ok(!far.ok && /trop loin/.test(far.error));
assert.ok(/aeroway/.test(R.query(43.6, 1.36)));
console.log('CARTE DE ROULAGE : TOUS LES TESTS PASSENT');

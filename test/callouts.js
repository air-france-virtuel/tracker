'use strict';
// Annonces de copilote de Max sur un vol complet (vol de démonstration) : chaque annonce une seule fois, dans l'ordre.
const assert = require('assert');
const C = require('../renderer/callouts');
const { DemoFlight, demoPlan } = require('../src/demo');
const { FlightEngine } = require('../src/flight');

const plan = Object.assign(demoPlan(), { transAlt: 5000, transLevel: 5000 });
const demo = new DemoFlight({}); const eng = new FlightEngine({ plan }); const st = C.create();
const said = [];
for (let i = 0; i < 200000 && !demo.done; i++) {
  const t = demo.step(); eng.update(t, t.time);
  for (const c of C.update(st, t, eng.phase, plan)) said.push(c);
}
console.log(said.join(' | '));
const order = ['Cent nœuds.', 'Vario positif.', 'Altitude de transition, calage standard.', 'Niveau cent.', 'Mille pieds avant le niveau.',
  'Niveau cent, phares allumés.', 'Niveau de transition, calage QNH.', 'Deux mille cinq cents.', 'Cinq cents.', 'Cent au-dessus.', 'Minimums.', 'Soixante-dix nœuds.'];
let k = -1;
for (const o of order) { const j = said.indexOf(o); assert.ok(j > k, 'annonce manquante ou dans le désordre : ' + o); k = j; }
assert.ok(said.some((s) => /^Mille, /.test(s)), 'annonce des 1 000 ft');
assert.strictEqual(new Set(said).size, said.length, 'aucune annonce répétée');
assert.ok(!said.some((s) => /250/.test(s)));

// remise des gaz : annoncée, puis les annonces d'approche repartent pour la nouvelle approche
const g = C.create(); const out = [];
const feed = (t) => out.push(...C.update(g, Object.assign({ onGround: false, gearDown: true, flapsIdx: 3, ias: 140 }, t), 6, plan));
feed({ alt: 1500, agl: 1500, vs: -700 }); feed({ alt: 900, agl: 900, vs: -700 }); feed({ alt: 600, agl: 600, vs: -700 });
feed({ alt: 650, agl: 650, vs: 1500 }); feed({ alt: 900, agl: 900, vs: 1500 });
assert.ok(out.includes('Remise des gaz, vario positif.'));
feed({ alt: 1100, agl: 1100, vs: -700 }); feed({ alt: 950, agl: 950, vs: -700 });
assert.strictEqual(out.filter((s) => /^Mille, /.test(s)).length, 2, 'nouvelle annonce des 1 000 ft après la remise des gaz');
console.log('ANNONCES DE COPILOTE : TOUS LES TESTS PASSENT');

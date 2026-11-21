'use strict';
// Questions à Max pendant le vol : chaque question courante trouve la bonne réponse, avec les données du vol.
const assert = require('assert');
const { answer } = require('../renderer/askmax');
const now = Date.parse('2026-11-21T12:00:00Z');
const plan = { origin: { icao: 'LFPG', rwy: '27L' }, destination: { icao: 'LFMN', rwy: '04R' }, alternate: { icao: 'LFML', name: 'Marseille', rwy: '31R' },
  cruiseAlt: 35000, sid: 'OPAL5A', star: 'MERLU1A', transAlt: 5000, transLevel: 5000, steps: [{ alt: 37100, ident: 'BAXOD' }], pax: 162, zfwKg: 61200, towKg: 67900,
  metarDep: 'LFPG 211130Z 27012G22KT 9999 FEW030 08/03 Q1018', metarArr: 'LFMN 211130Z 05006KT CAVOK 15/08 Q1021', tod: {} };
const c = { t: { alt: 34980, vs: 0, ias: 275, gs: 460, fuelKg: 6100 }, plan, ops: { remaining: 212, eta: now + 28 * 60000, next: { ident: 'MTL', cum: 400 }, along: 360, fuelPlan: 6400 },
  tod: { distNm: 95, minutes: 12 }, phase: 4, phaseName: 'Croisière', ck: { title: 'Croisière', items: [{ text: 'Niveau de croisière atteint', done: true }, { text: 'Arrivée préparée (ATIS, STAR, piste)', done: false }] }, now };
const A = (q) => answer(q, c);
const t = (q, id, re) => { const r = A(q); assert.strictEqual(r.id, id, q + ' → ' + r.id); if (re) assert.ok(re.test(r.text), q + ' : ' + r.text); };
t('Combien de temps reste-t-il ?', 'temps', /28 minutes/);
t('on arrive quand ?', 'eta', /12h28 UTC/);
t('quelle distance avant Nice', 'distance', /212 nautiques/);
t('il reste combien de carburant ?', 'carburant', /6,1 tonnes.*300 kilos de moins/);
t('Quand commence la descente', 'tod', /95 nautiques.*12 minutes/);
t('quelle météo à l’arrivée ?', 'meteo', /LFMN.*vent du 050, 6 nœuds.*CAVOK.*15 degrés.*QNH 1021/);
t('météo au départ', 'meteo', /LFPG.*rafales 22/);
t('QNH ?', 'qnh', /QNH 1021.*FL50/);
t('quelle piste à l’arrivée', 'piste', /04R/);
t('piste de départ', 'piste', /27L/);
t('quelle est la STAR', 'star', /MERLU1A/);
t('SID ?', 'sid', /OPAL5A/);
t('dégagement', 'degagement', /LFML.*Marseille/);
t('prochain point ?', 'point', /MTL.*40 nautiques/);
t('les paliers', 'palier', /FL370 à BAXOD/);
t('à quelle altitude on est', 'altitude', /niveau 350.*FL350/);
t('vitesse', 'vitesse', /275.*460/);
t('vent à l arrivée', 'vent', /050, 6 nœuds/);
t('qu est-ce qui reste dans la check-list', 'check', /il reste : arrivée préparée/);
t('on en est où ?', 'phase', /croisière/);
t('aide', 'aide', /temps restant/);
t('merci Max', 'merci');
t('blabla incompréhensible', 'inconnu', /pas compris/);
// sans données : pas de plantage, réponse claire
assert.ok(/plan SimBrief|données/.test(answer('carburant', {}).text + answer('temps restant', {}).text));
assert.ok(!/undefined|NaN/.test(['flaps', 'piste', 'météo', 'transition', 'masse', 'passagers'].map((q) => answer(q, {}).text).join(' ')));
console.log('QUESTIONS À MAX : TOUS LES TESTS PASSENT');

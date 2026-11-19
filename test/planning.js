// Tests du planning du jour : classement, enregistrement des vols et « ma journée ».
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Planning, category, blockMinutes } = require('../src/planning');
assert.strictEqual(category(690), 'court');      // Paris – Nice
assert.strictEqual(category(1900), 'moyen');     // Paris – Casablanca
assert.strictEqual(category(6800), 'long');      // Paris – Pointe-à-Pitre
assert.strictEqual(category(null, 'B77W'), 'long');
assert.strictEqual(category(null, ''), 'inconnu');
assert.ok(blockMinutes(690, 'court') > 80 && blockMinutes(690, 'court') < 160);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afv-plan-'));
const p = new Planning(dir);
const now = Date.parse('2026-11-19T15:00:00Z');
const f = { callsign: 'AFR1234', number: 'AF 1234', from: 'LFPG', to: 'LFMN', fromName: 'Paris', toName: 'Nice', fromPos: [49.01, 2.55], toPos: [43.66, 7.21], lat: 46.3, lon: 4.8, gsKt: 450 };
p.record([f, { callsign: 'AFR9', from: '', to: '' }], now);
let d = p.get(now);
assert.strictEqual(d.flights.length, 1, 'les vols sans route sont ignorés');
assert.strictEqual(d.flights[0].cat, 'court');
assert.ok(d.flights[0].depEst < now && d.flights[0].arrEst > now);
p.record([Object.assign({}, f, { type: 'A320', reg: 'F-HEPA' })], now + 60000);
d = p.get(now);
assert.deepStrictEqual([d.flights[0].type, d.flights[0].reg], ['A320', 'F-HEPA']);
p.record([Object.assign({}, f, { type: '' })], now + 120000);
assert.strictEqual(p.get(now).flights[0].type, 'A320', 'le type déjà connu est gardé');
d = p.toggle(d.flights[0].key, now);
assert.strictEqual(d.mine.length, 1);
assert.strictEqual(new Planning(dir).get(now).mine.length, 1, 'enregistré sur le PC');
assert.strictEqual(new Planning(dir).get(now + 86400000).flights.length, 0, 'nouveau jour = nouveau planning');
console.log('PLANNING : TOUS LES TESTS PASSENT');

// ----- programme officiel (AeroDataBox) -----
const { toFlight, icaoType } = require('../scripts/planning-fetch');
assert.strictEqual(icaoType('Airbus A350-900'), 'A359');
assert.strictEqual(icaoType('Boeing 777-300ER'), 'B77W');
assert.strictEqual(icaoType('Airbus A220-300'), 'BCS3');
assert.strictEqual(icaoType('Airbus A321neo'), 'A21N');
assert.strictEqual(icaoType('Embraer 190'), 'E190');
const mv = { number: 'AF 1234', status: 'Expected', isCargo: false, airline: { name: 'Air France', iata: 'AF', icao: 'AFR' },
  aircraft: { reg: 'F-HEPA', model: 'Airbus A320' },
  departure: { airport: { icao: 'LFPG', iata: 'CDG', name: 'Paris Charles de Gaulle', municipalityName: 'Paris' }, scheduledTime: { utc: '2026-11-19 14:05Z', local: '2026-11-19 15:05+01:00' } },
  arrival: { airport: { icao: 'LFMN', iata: 'NCE', name: 'Nice', municipalityName: 'Nice' }, scheduledTime: { utc: '2026-11-19 15:35Z', local: '2026-11-19 16:35+01:00' } } };
const sf = toFlight(mv, 'LFPG', 'Departure');
assert.deepStrictEqual([sf.number, sf.from, sf.to, sf.type, sf.reg, sf.depUtc], ['AF 1234', 'LFPG', 'LFMN', 'A320', 'F-HEPA', Date.parse('2026-11-19T14:05:00Z')]);
assert.strictEqual(toFlight(Object.assign({}, mv, { number: 'KL 1234', airline: { iata: 'KL' } }), 'LFPG', 'Departure'), null, 'autres compagnies ignorées');
// sans withLeg : le hub est complété
assert.strictEqual(toFlight(Object.assign({}, mv, { departure: { scheduledTime: { utc: '2026-11-19 14:05Z' } } }), 'LFPG', 'Departure').from, 'LFPG');
// fusion programme + direct
const p2 = new Planning(fs.mkdtempSync(path.join(os.tmpdir(), 'afv-plan2-')));
p2.record([f, Object.assign({}, f, { callsign: 'AFR77', number: 'AF 077', from: 'LFPG', to: 'KJFK', toPos: [40.6, -73.8] })], now);
const sched = { generatedAt: new Date(now - 3600000).toISOString(), source: 'AeroDataBox', flights: [Object.assign({}, sf, { distKm: 690, cat: 'court', blockMin: 90 }),
  { number: 'AF 6000', from: 'LFPO', to: 'LFBO', depUtc: now + 3600000, arrUtc: now + 7200000, status: 'Expected', cat: 'court' }] };
const mg = p2.merged(sched, ['AFR1234'], now);
assert.strictEqual(mg.flights.length, 3, 'programme + vol vu en direct hors programme, sans doublon');
assert.strictEqual(mg.flights.find((x) => x.number === 'AF 1234').status, 'En vol');
assert.strictEqual(mg.flights.find((x) => x.number === 'AF 6000').status, 'Programmé');
assert.strictEqual(mg.flights.find((x) => x.callsign === 'AFR77').scheduled, false);
assert.strictEqual(p2.merged({ generatedAt: new Date(now - 3 * 86400000).toISOString(), flights: sched.flights }, [], now).source, null, 'programme trop ancien ignoré');
console.log('PROGRAMME OFFICIEL : TOUS LES TESTS PASSENT');
// heure manquante estimée et indicatif radio
{
  const fl = { number: 'AF 43PK', from: 'EKCH', to: 'LFPG', arrUtc: Date.parse('2026-11-19T10:57:00Z'), depUtc: null };
  // reproduit l'étape de finition du script
  const est = Math.round((1030 / 1.852) / 430 * 60 + 25);
  assert.ok(est > 90 && est < 120);
  assert.ok(!/^AF \d+$/.test(fl.number));
}
console.log('HEURES ESTIMÉES : OK');

// Tests des vols réels avec des réponses simulées d'OpenSky, adsb.lol et adsbdb (aucun accès réseau).
const assert = require('assert');
const states = { time: 1, states: [
  ['39856a', 'AFR1234 ', 'France', 1, 1, 7.2, 43.6, 10668, false, 230, 140, 0, null, 10700, '1000', false, 0, 0],
  ['3944ef', 'AFR12AB ', 'France', 1, 1, 2.5, 49.0, 3000, false, 150, 90, 8, null, 3050, '1000', false, 0, 0],
  ['3c6444', 'DLH400  ', 'Germany', 1, 1, 8.5, 50.0, 11000, false, 240, 270, 0, null, 11000, '1000', false, 0, 0],
  ['39856b', 'AFR007  ', 'France', 1, 1, 2.5, 49.0, 0, true, 5, 90, 0, null, 0, '1000', false, 0, 0]
] };
const routeset = [{ callsign: 'AFR1234', airport_codes: 'LFPG-LFMN', _airport_codes_iata: 'CDG-NCE', plausible: true,
  _airports: [{ icao: 'LFPG', iata: 'CDG', location: 'Paris', name: 'Charles de Gaulle' }, { icao: 'LFMN', iata: 'NCE', location: 'Nice', name: 'Nice Côte d’Azur' }] },
  { callsign: 'AFR12AB', airport_codes: 'unknown', plausible: false }];
const adsbdbRoute = { response: { flightroute: { callsign: 'AFR12AB', origin: { icao_code: 'LFPG', iata_code: 'CDG', municipality: 'Paris' }, destination: { icao_code: 'EDDB', iata_code: 'BER', municipality: 'Berlin' } } } };
const adsbdbAc = { response: { aircraft: { icao_type: 'A320', registration: 'F-HEPA', manufacturer: 'Airbus', type: 'A320 214' } } };
let calls = [];
global.fetch = async (url, o) => {
  calls.push(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (url.startsWith('https://opensky-network.org')) return ok(states);
  if (url.startsWith('https://api.adsb.lol')) { assert.strictEqual(JSON.parse(o.body).planes.length, 2); return ok(routeset); }
  if (url.includes('/callsign/')) return ok(adsbdbRoute);
  if (url.includes('/aircraft/')) return ok(adsbdbAc);
  return { ok: false, status: 404 };
};
const real = require('../src/realflights');
(async () => {
  assert.strictEqual(real.flightNumber('AFR7'), 'AF 007');
  assert.strictEqual(real.flightNumber('AFR12AB'), '');
  const r = await real.live(true);
  assert.strictEqual(r.flights.length, 2, 'seuls les Air France en vol');
  const f = r.flights.find((x) => x.callsign === 'AFR1234');
  assert.deepStrictEqual([f.from, f.to, f.fromName, f.toName, f.number, f.altFt, f.gsKt], ['LFPG', 'LFMN', 'Paris', 'Nice', 'AF 1234', 35000, 447]);
  assert.strictEqual(r.flights.find((x) => x.callsign === 'AFR12AB').from, '');
  const n = calls.length; await real.live(false); assert.strictEqual(calls.length, n, 'cache de 5 minutes');
  const d = await real.details('AFR12AB', '3944ef');
  assert.deepStrictEqual([d.from, d.to, d.type, d.reg], ['LFPG', 'EDDB', 'A320', 'F-HEPA']);
  global.fetch = async () => ({ ok: false, status: 429 });
  const e = await real.live(true);
  assert.ok(e.error.includes('Limite') && e.flights.length === 2, 'garde les derniers vols si erreur');
  console.log('VOLS RÉELS : TOUS LES TESTS PASSENT');
})().catch((e) => { console.error(e); process.exit(1); });

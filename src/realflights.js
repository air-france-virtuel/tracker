'use strict';
// Vols réels Air France en cours, gratuits et sans clé :
// - positions : OpenSky Network (usage non commercial, 400 crédits par jour et par PC, 4 par requête mondiale)
// - routes : adsb.lol (données sous licence ODbL), avec adsbdb.com en secours pour un vol choisi
// - type d'avion : adsbdb.com, seulement pour le vol sélectionné

const OPENSKY = 'https://opensky-network.org/api/states/all';
const ROUTESET = 'https://api.adsb.lol/api/0/routeset';
const ADSBDB = 'https://api.adsbdb.com/v0/';
const CACHE_MS = 5 * 60 * 1000; // une actualisation toutes les 5 minutes au plus

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;

let cache = null; // { at, flights }
let pending = null;
const routeCache = new Map(); // callsign → route
const typeCache = new Map(); // icao24 → { type, reg, model }

const timeout = (ms) => AbortSignal.timeout(ms);

// AFR1234 → AF 1234 ; les indicatifs avec lettres (AFR12AB) n'ont pas de numéro public.
function flightNumber(cs) {
  const m = /^AFR(\d{1,4})$/.exec(cs);
  return m ? 'AF ' + m[1].padStart(3, '0') : '';
}

function parseStates(json) {
  const out = [];
  for (const s of (json && json.states) || []) {
    const cs = String(s[1] || '').trim().toUpperCase();
    if (!/^AFR[0-9]/.test(cs) || s[8] || s[6] == null || s[5] == null) continue; // Air France, en vol, position connue
    out.push({
      callsign: cs, number: flightNumber(cs), icao24: s[0],
      lat: s[6], lon: s[5],
      altFt: s[7] != null ? Math.round(s[7] * M_TO_FT) : (s[13] != null ? Math.round(s[13] * M_TO_FT) : null),
      gsKt: s[9] != null ? Math.round(s[9] * MS_TO_KT) : null,
      track: s[10] != null ? Math.round(s[10]) : null,
      vsFpm: s[11] != null ? Math.round(s[11] * M_TO_FT * 60) : null,
      lastContact: s[4]
    });
  }
  return out;
}

const pos = (a) => (a && Number.isFinite(+a.lat) && Number.isFinite(+a.lon) ? [+a.lat, +a.lon] : (a && Number.isFinite(+a.latitude) && Number.isFinite(+a.longitude) ? [+a.latitude, +a.longitude] : null));

function parseRouteset(list) {
  const out = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    const cs = String(r.callsign || '').toUpperCase();
    const codes = String(r.airport_codes || '').split('-').filter((x) => /^[A-Z0-9]{4}$/.test(x));
    if (!cs || codes.length < 2 || codes.includes('unknown')) continue;
    const ap = Array.isArray(r._airports) ? r._airports : [];
    const info = (icao) => ap.find((a) => a && a.icao === icao) || {};
    const from = codes[0]; const to = codes[codes.length - 1];
    out.set(cs, {
      from, to,
      fromName: info(from).location || info(from).name || '', toName: info(to).location || info(to).name || '',
      fromIata: info(from).iata || '', toIata: info(to).iata || '',
      fromPos: pos(info(from)), toPos: pos(info(to)),
      plausible: r.plausible !== false && r.plausible !== 0
    });
  }
  return out;
}

async function fetchRoutes(flights) {
  const todo = flights.filter((f) => !routeCache.has(f.callsign));
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    try {
      const r = await fetch(ROUTESET, {
        method: 'POST', signal: timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planes: chunk.map((f) => ({ callsign: f.callsign, lat: f.lat, lng: f.lon })) })
      });
      if (!r.ok) break;
      const found = parseRouteset(await r.json());
      for (const f of chunk) routeCache.set(f.callsign, found.get(f.callsign) || null);
    } catch (e) { break; }
  }
}

async function live(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (pending) return pending;
  pending = (async () => {
    try {
      const r = await fetch(OPENSKY, { signal: timeout(20000) });
      if (r.status === 429) throw new Error('Limite gratuite d’OpenSky atteinte pour aujourd’hui. Réessaie plus tard.');
      if (!r.ok) throw new Error('OpenSky ne répond pas (' + r.status + ').');
      const flights = parseStates(await r.json());
      await fetchRoutes(flights);
      for (const f of flights) Object.assign(f, routeCache.get(f.callsign) || { from: '', to: '' });
      flights.sort((a, b) => (a.from || 'ZZZZ').localeCompare(b.from || 'ZZZZ') || a.callsign.localeCompare(b.callsign));
      cache = { at: Date.now(), flights, error: '' };
    } catch (e) {
      const msg = e && e.name === 'TimeoutError' ? 'Le service des vols réels ne répond pas.' : String((e && e.message) || e);
      cache = Object.assign({}, cache || { flights: [] }, { at: (cache && cache.at) || 0, error: msg });
    } finally { pending = null; }
    return cache;
  })();
  return pending;
}

function parseAdsbdbRoute(j) {
  const fr = j && j.response && j.response.flightroute;
  if (!fr || !fr.origin || !fr.destination) return null;
  return {
    from: fr.origin.icao_code, to: fr.destination.icao_code,
    fromName: fr.origin.municipality || fr.origin.name || '', toName: fr.destination.municipality || fr.destination.name || '',
    fromIata: fr.origin.iata_code || '', toIata: fr.destination.iata_code || '',
    fromPos: pos(fr.origin), toPos: pos(fr.destination), plausible: true
  };
}

// Détails d'un vol choisi : route (si inconnue) et type d'avion.
async function details(callsign, icao24) {
  const res = {};
  if (!routeCache.get(callsign)) {
    try {
      const r = await fetch(ADSBDB + 'callsign/' + encodeURIComponent(callsign), { signal: timeout(10000) });
      if (r.ok) { const rt = parseAdsbdbRoute(await r.json()); if (rt) { routeCache.set(callsign, rt); Object.assign(res, rt); } }
    } catch (e) { /* route inconnue */ }
  }
  if (icao24) {
    if (!typeCache.has(icao24)) {
      try {
        const r = await fetch(ADSBDB + 'aircraft/' + encodeURIComponent(icao24), { signal: timeout(10000) });
        const a = r.ok ? ((await r.json()).response || {}).aircraft : null;
        typeCache.set(icao24, a ? { type: a.icao_type || '', reg: a.registration || '', model: [a.manufacturer, a.type].filter(Boolean).join(' ') } : null);
      } catch (e) { /* type inconnu */ }
    }
    Object.assign(res, typeCache.get(icao24) || {});
  }
  return res;
}

module.exports = { live, details, parseStates, parseRouteset, parseAdsbdbRoute, flightNumber };

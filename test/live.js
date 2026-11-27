'use strict';
// Pilotes en vol : partage des positions entre trackers (faux serveur temps réel en mémoire).
const assert = require('assert');
const { Live, cleanEntry } = require('../src/live');

// faux « temps réel » : tous les trackers branchés sur le même canal voient les présences des autres
function realtime() {
  const state = {}; const subs = [];
  const notify = () => subs.forEach((f) => f());
  const pilots = [{ id: 'u1', pseudo: 'Ted', grade: 'Commandant' }, { id: 'u2', pseudo: 'Durand', grade: '' }, { id: 'u3', pseudo: 'Banni', banned: true }];
  return (uid) => ({
    me: { id: uid }, pilotCache: null,
    session: async function () { return this.me; },
    sb: {
      getChannels: () => [], removeChannel: async () => {},
      channel: () => {
        let sync = null;
        const ch = {
          topic: 'realtime:vols-lat',
          on(t, f, fn) { sync = fn; subs.push(() => sync && sync()); return ch; },
          subscribe(cb) { setTimeout(() => cb('SUBSCRIBED'), 1); return ch; },
          track: async (p) => { state[uid] = [p]; notify(); },
          untrack: async () => { delete state[uid]; notify(); },
          presenceState: () => state
        };
        return ch;
      },
      from: () => ({ select() { return this; }, in(c, ids) { return Promise.resolve({ data: pilots.filter((p) => ids.includes(p.id)), error: null }); } })
    }
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. données d'un autre tracker : tout est vérifié
  assert.strictEqual(cleanEntry({ id: 'x', lat: 95, lon: 2 }), null);
  assert.strictEqual(cleanEntry({ id: 'x', lat: 'abc', lon: 2 }), null);
  const e = cleanEntry({ id: 'x', lat: 49, lon: 2.5, cs: 'LAT123<script>', from: 'lfpg', to: 'rjtt', alt: 99999999, gs: 480 });
  assert.strictEqual(e.cs, 'LAT123<scrip'); assert.strictEqual(e.from, 'LFPG'); assert.strictEqual(e.alt, null); assert.strictEqual(e.gs, 480);

  const rt = realtime();
  const a = new Live(rt('u1')), b = new Live(rt('u2')), c = new Live(rt('u3'));
  let seen = null; b.on('list', (l) => { seen = l; });
  await a.start(); await b.start(); await c.start(); await wait(10);
  // 2. Ted vole : Durand le voit avec le nom de pilote venu du serveur
  a.update({ cs: 'LAT010', from: 'LFPG', to: 'RJTT', ac: 'B77W', reg: 'F-HLAU', lat: 49.0, lon: 2.5, alt: 35000, gs: 480, hdg: 60, ph: 4, pseudo: 'Faux nom' });
  await wait(20);
  assert.ok(seen && seen.list.length === 1, 'un pilote en vol');
  assert.strictEqual(seen.list[0].pseudo, 'Ted'); assert.strictEqual(seen.list[0].cs, 'LAT010'); assert.strictEqual(seen.list[0].mine, false);
  assert.strictEqual(a.list[0].mine, true);
  // 3. pas plus d'une position toutes les 10 s
  a.update({ cs: 'LAT010', lat: 50, lon: 3 }); await wait(10);
  assert.strictEqual(seen.list[0].lat, 49.0);
  // 4. un pilote exclu par la direction n'apparaît pas
  c.update({ cs: 'LAT666', lat: 45, lon: 5 }); await wait(20);
  assert.strictEqual(seen.list.length, 1);
  // 5. fin du vol : il disparaît ; « ne pas me montrer » : rien n'est envoyé
  a.update(null); await wait(20);
  assert.strictEqual(seen.list.length, 0);
  a.setShare(false); a.lastTrack = 0; a.update({ cs: 'LAT010', lat: 49, lon: 2 }); await wait(20);
  assert.strictEqual(seen.list.length, 0);
  console.log('PILOTES EN VOL : TOUS LES TESTS PASSENT');
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// Réservation des avions de la compagnie : deux pilotes, un seul avion (faux serveur qui reproduit supabase/avions.sql).
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { Chat } = require('../src/chat');

function server() {
  const db = { pilots: [], bookings: [] }; let n = 0;
  const client = () => {
    let session = null;
    const me = () => session && session.user.id;
    return {
      auth: { getSession: async () => ({ data: { session } }), signInAnonymously: async () => { session = { user: { id: 'u' + (++n) } }; return { data: { session }, error: null }; } },
      from: (table) => {
        const st = { table, row: null, gt: null };
        const api = {
          upsert(row) { st.row = row; return api; }, select() { return api; }, single() { return api; },
          gt(c, v) { st.gt = [c, v]; return api; },
          then(res, rej) {
            let out;
            if (st.row) { let p = db.pilots.find((x) => x.id === st.row.id); if (!p) { p = { banned: false, is_admin: false }; db.pilots.push(p); } Object.assign(p, st.row); out = { data: p, error: null }; }
            else if (table === 'aircraft_bookings') { if (db.off) out = { data: null, error: { message: 'relation "public.aircraft_bookings" does not exist' } }; else out = { data: db.bookings.filter((b) => b.until > st.gt[1]), error: null }; }
            return Promise.resolve(out).then(res, rej);
          }
        };
        return api;
      },
      rpc: async (fn, a) => {
        const p = db.pilots.find((x) => x.id === me()); const now = new Date().toISOString();
        if (fn === 'take_aircraft') {
          const b = db.bookings.find((x) => x.reg === a.p_reg);
          if (b && b.user_id !== p.id && b.until > now) return { data: null, error: { message: 'AVION_PRIS' } };
          db.bookings = db.bookings.filter((x) => x.user_id !== p.id && x.reg !== a.p_reg);
          const r = { reg: a.p_reg, user_id: p.id, pseudo: p.pseudo, taken_at: now, until: a.p_until };
          db.bookings.push(r); return { data: r, error: null };
        }
        if (fn === 'release_aircraft') { db.bookings = db.bookings.filter((x) => !(x.reg === a.p_reg && (x.user_id === p.id || p.is_admin))); return { data: null, error: null }; }
        return { error: { message: '?' } };
      }
    };
  };
  return { db, client };
}

(async () => {
  const srv = server();
  const mk = (pseudo) => { const c = new Chat(fs.mkdtempSync(path.join(os.tmpdir(), 'afv-av-')), { createClient: srv.client }); c.configure({ url: 'https://abc.supabase.co', key: 'x'.repeat(30) }); c.setProfile({ pseudo }); return c; };
  const a = mk('Martin'), b = mk('Durand');
  const until = Date.now() + 5 * 3600000;
  // sans nom de pilote : refus clair
  const anon = mk('');
  assert.ok(/nom de pilote/.test((await anon.aircraftTake('F-HLAT', until)).error));
  // Martin prend F-HLAT ; Durand le voit pris et ne peut pas le prendre
  assert.ok((await a.aircraftTake('f-hlat', until)).ok);
  const lb = await b.aircraftList();
  assert.ok(lb.ok); assert.strictEqual(lb.list.length, 1);
  assert.deepStrictEqual([lb.list[0].reg, lb.list[0].pseudo, lb.list[0].mine], ['F-HLAT', 'Martin', false]);
  assert.strictEqual((await a.aircraftList()).list[0].mine, true);
  const r = await b.aircraftTake('F-HLAT', until);
  assert.strictEqual(r.ok, false); assert.ok(/autre pilote/.test(r.error));
  // Durand ne peut pas le rendre à la place de Martin
  await b.aircraftRelease('F-HLAT'); assert.strictEqual(srv.db.bookings.length, 1);
  // Martin le rend : Durand peut le prendre
  assert.ok((await a.aircraftRelease('F-HLAT')).ok);
  assert.ok((await b.aircraftTake('F-HLAT', until)).ok);
  // serveur pas encore préparé (avions.sql pas lancé) : message compréhensible
  srv.db.off = true;
  assert.ok(/pas encore activée/.test((await a.aircraftList()).error));
  console.log('AVIONS DE LA COMPAGNIE : TOUS LES TESTS PASSENT');
})().catch((e) => { console.error(e); process.exit(1); });

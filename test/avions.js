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
          if (b && b.kind === 'maintenance' && b.until > now) return { data: null, error: { message: 'AVION_MAINTENANCE' } };
          if (b && b.user_id !== p.id && b.until > now) return { data: null, error: { message: 'AVION_PRIS' } };
          db.bookings = db.bookings.filter((x) => !(x.user_id === p.id && x.kind !== 'maintenance') && x.reg !== a.p_reg);
          const r = { reg: a.p_reg, user_id: p.id, pseudo: p.pseudo, taken_at: now, until: a.p_until, kind: 'vol' };
          db.bookings.push(r); return { data: r, error: null };
        }
        if (fn === 'finish_flight') {
          if (!db.bookings.find((y) => y.reg === a.p_reg && y.user_id === p.id && y.kind === 'vol')) return { data: null, error: { message: 'AVION_PAS_A_TOI' } };
          return { data: { kept: a.p_keep, state: { reg: a.p_reg, location: a.p_arr }, maintenance: a.p_keep ? undefined : { minutes: 30 + 10 * Math.round(a.p_minutes / 60), reason: 'Visite après vol' } }, error: null };
        }
        if (fn === 'release_aircraft' && a.p_maint_minutes > 0) {
          const x = db.bookings.find((y) => y.reg === a.p_reg && y.user_id === p.id && y.kind === 'vol');
          if (x) { x.kind = 'maintenance'; x.until = new Date(Date.now() + a.p_maint_minutes * 60000).toISOString(); }
          return { data: x || null, error: null };
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
  // le nom affiché est celui du tracker, même changé après la prise de l'avion
  srv.db.bookings[0].pilots = { pseudo: 'Cdt Martin' };
  assert.strictEqual((await b.aircraftList()).list[0].pseudo, 'Cdt Martin');
  const r = await b.aircraftTake('F-HLAT', until);
  assert.strictEqual(r.ok, false); assert.ok(/autre pilote/.test(r.error));
  // Durand ne peut pas le rendre à la place de Martin
  await b.aircraftRelease('F-HLAT'); assert.strictEqual(srv.db.bookings.length, 1);
  // Martin le rend : Durand peut le prendre
  assert.ok((await a.aircraftRelease('F-HLAT')).ok);
  assert.ok((await b.aircraftTake('F-HLAT', until)).ok);
  // carnet de l'avion : seul le pilote qui l'a pris peut enregistrer le vol
  const f1 = await a.finishFlight({ reg: 'F-HLAT', callsign: 'LAT1', dep: 'LFPG', arr: 'LFMN', minutes: 82, rate: -300 });
  assert.strictEqual(f1.ok, false); assert.ok(/pas pris cet avion/.test(f1.error));
  const f2 = await b.finishFlight({ reg: 'f-hlat', callsign: 'LAT1', dep: 'LFPG', arr: 'LFMN', minutes: 82, rate: -300, keep: true });
  assert.ok(f2.ok && f2.kept && f2.state.location === 'LFMN');
  // fin du vol : Durand rend F-HLAT en maintenance 45 min ; personne ne peut le prendre, même lui
  assert.ok((await b.aircraftRelease('F-HLAT', 45)).ok);
  const lm = (await a.aircraftList()).list.find((x) => x.reg === 'F-HLAT');
  assert.strictEqual(lm.maint, true); assert.ok(lm.until > Date.now() + 44 * 60000);
  assert.ok(/maintenance/.test((await a.aircraftTake('F-HLAT', until)).error));
  assert.ok(/maintenance/.test((await b.aircraftTake('F-HLAT', until)).error));
  // serveur pas encore préparé (avions.sql pas lancé) : message compréhensible
  srv.db.off = true;
  assert.ok(/pas encore activée/.test((await a.aircraftList()).error));
  console.log('AVIONS DE LA COMPAGNIE : TOUS LES TESTS PASSENT');
})().catch((e) => { console.error(e); process.exit(1); });

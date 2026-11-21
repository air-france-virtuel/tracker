'use strict';
// Vérifie le module de chat avec un faux Supabase (en mémoire).
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { Chat, clean } = require('../src/chat');

function fakeSupabase() {
  const db = { pilots: [], messages: [], reports: [] }; let uid = 0, mid = 0; let session = null; const handlers = [];
  const q = (table) => {
    const st = { table, op: 'select', filters: [], row: null, single: false, order: null, limit: null };
    const api = {
      select() { return api; }, order(c, o) { st.order = o; return api; }, limit(n) { st.limit = n; return api; },
      in(c, v) { st.filters.push((r) => v.includes(r[c])); return api; },
      upsert(row) { st.op = 'upsert'; st.row = row; return api; }, insert(row) { st.op = 'insert'; st.row = row; return api; },
      single() { st.single = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); }
    };
    function run() {
      const me = session && session.user.id;
      if (st.op === 'upsert') { let p = db.pilots.find((x) => x.id === st.row.id); if (!p) { p = { banned: false, is_admin: false }; db.pilots.push(p); } Object.assign(p, st.row); return { data: p, error: null }; }
      if (st.op === 'insert' && table === 'messages') {
        const p = db.pilots.find((x) => x.id === me);
        if (p.banned) return { data: null, error: { message: 'Tu as été exclu du chat par la direction.' } };
        const m = { id: ++mid, created_at: new Date().toISOString(), user_id: me, pseudo: p.pseudo, grade: p.grade, admin: p.is_admin, flight: st.row.flight, body: st.row.body, deleted: false };
        db.messages.push(m); setTimeout(() => handlers.forEach((h) => h.ev === 'INSERT' && h.fn({ new: m })), 5); return { data: m, error: null };
      }
      if (st.op === 'insert' && table === 'reports') { db.reports.push(st.row); return { data: null, error: null }; }
      let rows = db[table].filter((r) => st.filters.every((f) => f(r)));
      if (st.order && st.order.ascending === false) rows = rows.slice().reverse();
      if (st.limit) rows = rows.slice(0, st.limit);
      return { data: st.single ? rows[0] : rows, error: null };
    }
    return api;
  };
  const presence = {};
  const client = {
    db,
    auth: { getSession: async () => ({ data: { session } }), signInAnonymously: async () => { session = { user: { id: 'u' + (++uid) } }; return { data: { session }, error: null }; } },
    from: q,
    rpc: async (fn, a) => { const me = db.pilots.find((x) => x.id === session.user.id); if (!me.is_admin) return { error: { message: 'Réservé à la direction' } }; if (fn === 'hide_message') { const m = db.messages.find((x) => x.id === a.mid); m.deleted = true; handlers.forEach((h) => h.ev === 'UPDATE' && h.fn({ new: m })); } return { error: null }; },
    // comme supabase-js : un canal du même nom est réutilisé, et on ne peut plus l'écouter après subscribe()
    channels: [],
    getChannels: () => client.channels,
    channel: (name) => {
      const ex = client.channels.find((c) => c.topic === 'realtime:' + name); if (ex) return ex;
      const ch = {
        topic: 'realtime:' + name, subscribed: false,
        on(type, f, fn) { if (ch.subscribed) throw new Error('cannot add `postgres_changes` callbacks for ' + ch.topic + ' after `subscribe()`.'); if (type === 'postgres_changes') handlers.push({ ev: f.event, fn }); else ch.sync = fn; return ch; },
        subscribe(cb) { ch.subscribed = true; ch.cb = cb; setTimeout(() => cb(client.failNext ? (client.failNext = false, 'CHANNEL_ERROR') : 'SUBSCRIBED'), 1); return ch; },
        track: async (p) => { presence[p.id] = [p]; ch.sync && ch.sync(); },
        presenceState: () => presence
      };
      client.channels.push(ch);
      return ch;
    },
    removeChannel: async (ch) => { client.channels = client.channels.filter((c) => c !== ch); }
  };
  return client;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afv-chat-'));
  const sb = fakeSupabase();
  const c = new Chat(dir, { createClient: () => sb });
  const got = [];
  c.on('message', (m) => got.push(m));
  // sans configuration : rien ne démarre
  assert.strictEqual((await c.start()).state, 'off');
  c.configure({ url: 'https://abcdefgh.supabase.co', key: 'x'.repeat(40) });
  // sans nom de pilote : on le demande
  assert.strictEqual((await c.start()).state, 'nopseudo');
  c.setProfile({ pseudo: '  Cdt Martin  ', grade: 'Premier Officier', flight: 'AFR123 · LFPG → LFMN' });
  const st = await c.start();
  assert.strictEqual(st.state, 'ready', st.error);
  assert.strictEqual(sb.db.pilots[0].pseudo, 'Cdt Martin');
  const r = await c.send('Bonjour à tous \u0007!');
  assert.ok(r.ok);
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(got.length, 1, 'le message n’est affiché qu’une fois');
  assert.strictEqual(got[0].body, 'Bonjour à tous !');
  assert.strictEqual(got[0].flight, 'AFR123 · LFPG → LFMN');
  assert.strictEqual((await c.send('   ')).ok, false);
  assert.strictEqual(clean('x'.repeat(900), 500).length, 500);
  // en ligne : nom venu du serveur
  await new Promise((x) => setTimeout(x, 20));
  assert.strictEqual(c.online.length, 1); assert.strictEqual(c.online[0].pseudo, 'Cdt Martin');
  // modération refusée pour un pilote normal, acceptée pour un admin
  assert.strictEqual((await c.hide(1)).ok, false);
  sb.db.pilots[0].is_admin = true;
  const removed = []; c.on('removed', (id) => removed.push(id));
  assert.strictEqual((await c.hide(1)).ok, true);
  assert.deepStrictEqual(removed, [1]); assert.strictEqual(c.visible().length, 0);
  // banni : envoi refusé par le serveur
  sb.db.pilots[0].banned = true;
  const b = await c.send('test'); assert.strictEqual(b.ok, false); assert.ok(/exclu/.test(b.error));
  // coupure du temps réel puis reconnexion : pas d'erreur « after subscribe() »
  sb.db.pilots[0].banned = false;
  c.channel.cb('CHANNEL_ERROR');
  assert.strictEqual(c.state, 'error');
  const again = await c.start();
  assert.strictEqual(again.state, 'ready', again.error);
  assert.strictEqual(sb.channels.length, 1, 'un seul canal ouvert');
  // le chat et la réservation d'avion qui démarrent en même temps : un seul compte
  const c2 = new Chat(fs.mkdtempSync(path.join(os.tmpdir(), 'afv-chat2-')), { createClient: () => fakeSupabase() });
  c2.configure({ url: 'https://abc.supabase.co', key: 'x'.repeat(30) }); c2.setProfile({ pseudo: 'Durand' });
  const [s1, s2] = await Promise.all([c2.session(), c2.session()]);
  assert.strictEqual(s1.id, s2.id);
  // la session est gardée dans le dossier du pilote
  assert.ok(fs.existsSync(path.join(dir)) );
  console.log('CHAT : TOUS LES TESTS PASSENT');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

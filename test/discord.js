'use strict';
// Vérifie le dialogue avec Discord grâce à un faux Discord local (même protocole IPC).
const net = require('net'); const fs = require('fs'); const os = require('os'); const path = require('path');
const assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afv-discord-'));
process.env.XDG_RUNTIME_DIR = dir;
const { DiscordPresence, buildActivity, encode, decoder, pipePath } = require('../src/discord');

if (process.platform === 'win32') { console.log('DISCORD : test sauté sous Windows'); process.exit(0); }
const got = [];
const server = net.createServer((c) => {
  c.on('data', decoder((op, d) => {
    got.push({ op, d });
    if (op === 0) c.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { username: 'pilote' } } }));
  }));
});
server.listen(pipePath(0), async () => {
  const p = new DiscordPresence();
  p.configure('123456789012345678', true);
  p.set(buildActivity({ flying: true, callsign: 'AFR123', route: 'LFPG → LFMN', phase: 'Croisière', alt: 'FL350', aircraft: 'A320', startedAt: 1700000000000 }, { largeImage: 'afv', buttons: [{ label: 'Télécharger le tracker', url: 'https://example.com/x' }, { label: 'mauvais', url: 'http://x' }] }));
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(got[0].op, 0); assert.strictEqual(got[0].d.client_id, '123456789012345678');
  const act = got.find((g) => g.op === 1 && g.d.cmd === 'SET_ACTIVITY').d.args.activity;
  assert.strictEqual(act.details, 'Vol AFR123 · LFPG → LFMN');
  assert.strictEqual(act.state, 'Croisière · FL350');
  assert.strictEqual(act.timestamps.start, 1700000000000);
  assert.strictEqual(act.buttons.length, 1);
  // au sol
  p.set(buildActivity({ flying: false, grade: 'Premier Officier' }, {}));
  await new Promise((r) => setTimeout(r, 200));
  const last = got.filter((g) => g.op === 1).pop().d.args.activity;
  assert.strictEqual(last.details, 'Prépare son prochain vol'); assert.strictEqual(last.state, 'Premier Officier');
  // identifiant absent : rien n'est envoyé
  const q = new DiscordPresence(); q.configure('', true); assert.strictEqual(q.enabled, false);
  p.stop();
  await new Promise((r) => setTimeout(r, 200));
  const clear = got.filter((g) => g.op === 1).pop().d.args;
  assert.strictEqual(clear.activity, undefined);
  server.close();
  console.log('DISCORD : TOUS LES TESTS PASSENT');
  process.exit(0);
});

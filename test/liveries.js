'use strict';
// Essais de la rubrique Livrées : dossier Community, lecture du .zip, installation et désinstallation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Liveries, findCommunity, parseUserCfg, extractZip, MARK } = require('../src/liveries');

// petit fabricant de .zip pour les essais (un fichier stocké, les autres compressés)
function makeZip(files) {
  const locals = []; const cds = []; let off = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text);
    const method = i === 0 ? 0 : 8;
    const data = method ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); cds.push(ch, n);
    off += 30 + n.length + data.length;
  });
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(cds.length / 2, 8); end.writeUInt16LE(cds.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livrees-'));

  // 1. UserCfg.opt → dossier Community (Steam puis Microsoft Store)
  assert.strictEqual(parseUserCfg('Version 1\nInstalledPackagesPath "D:\\MSFS 2024\\Packages"\n'), 'D:\\MSFS 2024\\Packages');
  assert.strictEqual(parseUserCfg('rien'), null);
  const pk = path.join(tmp, 'Packages'); fs.mkdirSync(path.join(pk, 'Community'), { recursive: true });
  const store = path.join(tmp, 'local', 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'UserCfg.opt'), 'InstalledPackagesPath "' + pk + '"\n');
  assert.strictEqual(findCommunity({ APPDATA: path.join(tmp, 'vide'), LOCALAPPDATA: path.join(tmp, 'local') }), path.join(pk, 'Community'));
  assert.strictEqual(findCommunity({ APPDATA: path.join(tmp, 'vide') }), null);

  // 2. zip avec dossier racine (retiré) et sans dossier racine
  const z1 = path.join(tmp, 'a.zip');
  fs.writeFileSync(z1, makeZip({ 'liv/manifest.json': '{"a":1}', 'liv/SimObjects/x/texture/t.ktx2': 'TEXTURE'.repeat(500), 'liv/layout.json': '{}' }));
  const d1 = path.join(tmp, 'd1');
  assert.strictEqual(extractZip(z1, d1, 'liv'), 3);
  assert.strictEqual(fs.readFileSync(path.join(d1, 'manifest.json'), 'utf8'), '{"a":1}');
  assert.strictEqual(fs.readFileSync(path.join(d1, 'SimObjects', 'x', 'texture', 't.ktx2'), 'utf8'), 'TEXTURE'.repeat(500));
  const z2 = path.join(tmp, 'b.zip');
  fs.writeFileSync(z2, makeZip({ 'manifest.json': '{}', '../evil.txt': 'non' }));
  const d2 = path.join(tmp, 'd2');
  extractZip(z2, d2, 'liv');
  assert.ok(fs.existsSync(path.join(d2, 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')), 'un chemin « .. » ne doit jamais sortir du dossier');

  // 3. installation complète avec un faux téléchargement
  const zipBuf = makeZip({ 'les-ailes/manifest.json': '{"title":"LAT"}', 'les-ailes/layout.json': '{}' });
  const fakeFetch = async (url) => {
    if (url.includes('catalogue.json')) return new Response(JSON.stringify({ livrees: [{ id: 'l1', version: '2.0' }] }), { status: 200 });
    return new Response(zipBuf, { status: 200, headers: { 'content-length': String(zipBuf.length) } });
  };
  const com = path.join(pk, 'Community');
  const lv = new Liveries({
    bundled: [{ id: 'l1', name: 'Essai', folder: 'les-ailes', version: '1.0', url: 'https://exemple/l.zip' }],
    tmpDir: path.join(tmp, 'dl'), getCommunity: () => com, fetch: fakeFetch
  });
  const states = [];
  lv.on('job', (j) => states.push(j.job.state));
  let L = await lv.list(true);
  assert.strictEqual(L.livrees[0].version, '2.0', 'le catalogue en ligne remplace la version');
  assert.strictEqual(L.livrees[0].installed, false);
  await lv.install('l1');
  assert.deepStrictEqual([...new Set(states)], ['download', 'extract', 'done']);
  assert.strictEqual(fs.readFileSync(path.join(com, 'les-ailes', 'manifest.json'), 'utf8'), '{"title":"LAT"}');
  assert.ok(fs.existsSync(path.join(com, 'les-ailes', MARK)));
  assert.ok(!fs.existsSync(path.join(com, '.les-ailes.installation')));
  L = await lv.list(false);
  assert.strictEqual(L.livrees[0].installed, true);
  assert.strictEqual(L.livrees[0].outdated, false);
  // nouvelle version au catalogue → mise à jour proposée
  lv.remote[0].version = '3.0';
  L = await lv.list(false);
  assert.strictEqual(L.livrees[0].outdated, true);
  // désinstallation
  assert.strictEqual(lv.remove('l1', await lv.catalogue(false)), true);
  assert.ok(!fs.existsSync(path.join(com, 'les-ailes')));
  // une livrée posée à la main n'est jamais supprimée par le tracker
  fs.mkdirSync(path.join(com, 'les-ailes'));
  assert.throws(() => lv.remove('l1', lv.bundled));
  assert.ok(fs.existsSync(path.join(com, 'les-ailes')));
  // téléchargement en échec → message clair, rien de cassé
  const bad = new Liveries({ bundled: [{ id: 'l2', folder: 'x', url: 'https://exemple/x.zip' }], tmpDir: path.join(tmp, 'dl'), getCommunity: () => com, fetch: async () => new Response('', { status: 404 }) });
  await bad.install('l2');
  assert.strictEqual(bad.jobs.l2.state, 'error');
  assert.ok(!fs.existsSync(path.join(com, 'x')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('livrées : OK');
})().catch((e) => { console.error(e); process.exit(1); });

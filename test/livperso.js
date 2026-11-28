'use strict';
// Livrées perso : lecture d'un .zip ou d'un dossier de livrée MSFS, installation dans Community, type d'avion, retrait
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { Liveries, MARK, readZipEntries, extractZip } = require('../src/liveries');
const { Perso, typeFrom } = require('../src/livperso');

// petit .zip (méthode « deflate ») écrit à la main
function makeZip(file, entries) {
  const locals = [], central = []; let off = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content), comp = zlib.deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp); central.push(ch, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livperso-'));
  const com = path.join(tmp, 'Community'); fs.mkdirSync(com);
  const data = path.join(tmp, 'data');
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  // 1. un .zip de livrée 777 avec un dossier racine
  const zip = path.join(tmp, 'ma-livree.zip');
  makeZip(zip, [
    ['vol-de-nuit-777/manifest.json', JSON.stringify({ title: 'Vol de nuit 777', creator: 'Kévin' })],
    ['vol-de-nuit-777/SimObjects/Airplanes/x/livery.cfg', '[GENERAL]\nname = "PMDG 777-300ER Vol de nuit"\n'],
    ['vol-de-nuit-777/SimObjects/Airplanes/x/texture.nuit/thumbnail.JPG', JPG],
    ['vol-de-nuit-777/layout.json', '{}']
  ]);
  const perso = new Perso(data, { readZipEntries, extractZip });
  const liv = new Liveries({ bundled: [{ id: 'lat-a320-iae-fhlat', name: 'Oiseau', folder: 'les-ailes-tricolores-a320-iae', reg: 'F-HLAT' }], tmpDir: path.join(tmp, 't'), getCommunity: () => com, fetch: async () => { throw new Error('hors ligne'); }, perso });
  const e = perso.add(zip);
  assert.strictEqual(e.id, 'perso-vol-de-nuit-777'); assert.strictEqual(e.name, 'Vol de nuit 777'); assert.strictEqual(e.type, 'B77W'); assert.strictEqual(e.folder, 'vol-de-nuit-777');
  assert.ok(e.imageFile && fs.readFileSync(path.join(data, e.imageFile)).equals(JPG), 'aperçu copié');
  await liv.installPerso(Object.assign({ perso: true }, e));
  assert.strictEqual(liv.jobs[e.id].state, 'done', JSON.stringify(liv.jobs[e.id]));
  assert.ok(fs.existsSync(path.join(com, 'vol-de-nuit-777', 'manifest.json')), 'installée sans double dossier');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(com, 'vol-de-nuit-777', MARK))).id, e.id);
  let l = await liv.list(false);
  const p = l.livrees.find((x) => x.id === e.id);
  assert.ok(p && p.perso && p.installed && /^file:/.test(p.image), 'dans la liste, installée, avec sa photo');
  assert.ok(l.livrees.find((x) => x.id === 'lat-a320-iae-fhlat'), 'catalogue de la compagnie toujours là');
  // 2. un dossier (on choisit le dossier parent qui contient le paquet)
  const parent = path.join(tmp, 'Telechargements', 'livree A320'); const pkg = path.join(parent, 'lat-a320-perso');
  fs.mkdirSync(path.join(pkg, 'SimObjects', 'a'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ title: 'A320 Été' }));
  fs.writeFileSync(path.join(pkg, 'SimObjects', 'a', 'aircraft.cfg'), 'title = "FenixA320 IAE Été"');
  const e2 = perso.add(parent);
  assert.strictEqual(e2.type, 'A320'); assert.strictEqual(e2.folder, 'lat-a320-perso'); assert.strictEqual(e2.imageFile, '');
  await liv.install(e2.id);
  assert.ok(fs.existsSync(path.join(com, 'lat-a320-perso', 'SimObjects', 'a', 'aircraft.cfg')));
  // 3. type modifiable, désinstaller, retirer
  assert.ok(perso.setType(e2.id, 'B77W')); assert.strictEqual(perso.load().find((x) => x.id === e2.id).type, 'B77W');
  assert.ok(!perso.setType(e2.id, 'XX'));
  assert.ok(liv.remove(e.id, perso.list())); assert.ok(!fs.existsSync(path.join(com, 'vol-de-nuit-777')));
  assert.ok(perso.forget(e.id)); assert.ok(!perso.load().find((x) => x.id === e.id)); assert.ok(!fs.existsSync(path.join(data, e.imageFile)));
  // 4. erreurs claires
  const bad = path.join(tmp, 'pas-une-livree.zip'); makeZip(bad, [['readme.txt', 'bonjour']]);
  assert.throws(() => perso.add(bad), /manifest\.json/);
  fs.mkdirSync(path.join(tmp, 'vide')); assert.throws(() => perso.add(path.join(tmp, 'vide')), /manifest\.json/);
  assert.strictEqual(typeFrom('Boeing 777-300ER'), 'B77W'); assert.strictEqual(typeFrom('A20N'), 'A320');
  // 5. partage : un dossier devient un .zip lisible, et une livrée partagée en 3 morceaux se réinstalle telle quelle
  const { zipFolder } = require('../src/livperso');
  const big = Buffer.alloc(300000); for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
  fs.writeFileSync(path.join(pkg, 'SimObjects', 'a', 'texture.bin'), big);
  const z = zipFolder(pkg, 'lat-a320-perso');
  const zf = path.join(tmp, 'refait.zip'); fs.writeFileSync(zf, z);
  const back = path.join(tmp, 'relu'); extractZip(zf, back, 'lat-a320-perso');
  assert.ok(fs.readFileSync(path.join(back, 'SimObjects', 'a', 'texture.bin')).equals(big), 'zip du dossier relu à l’identique');
  const parts = [z.subarray(0, 100000), z.subarray(100000, 200000), z.subarray(200000)];
  const urls = parts.map((_, i) => 'https://exemple/livrees/partage-x/part-00' + i);
  const fakeFetch = async (u) => { const b = parts[urls.indexOf(u)]; return { ok: true, status: 200, headers: { get: () => String(b.length) }, body: { getReader() { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(b) })) }; } } }; };
  const shared = [{ id: 'partage-lat-a320-perso', name: 'A320 Été', folder: 'lat-a320-perso', parts: urls, size: z.length, shared: true, version: '202611280900' }];
  const liv2 = new Liveries({ bundled: [], tmpDir: path.join(tmp, 't2'), getCommunity: () => com, fetch: fakeFetch, perso, shared: async () => ({ ok: true, list: shared }) });
  fs.rmSync(path.join(com, 'lat-a320-perso'), { recursive: true, force: true });
  await liv2.install('partage-lat-a320-perso');
  assert.strictEqual(liv2.jobs['partage-lat-a320-perso'].state, 'done', JSON.stringify(liv2.jobs['partage-lat-a320-perso']));
  assert.ok(fs.readFileSync(path.join(com, 'lat-a320-perso', 'SimObjects', 'a', 'texture.bin')).equals(big), 'morceaux recollés');
  const l2 = (await liv2.list(false)).livrees.find((x) => x.id === 'partage-lat-a320-perso');
  assert.ok(l2.installed && l2.shared, 'livrée partagée installée');
  // morceau manquant → erreur claire, rien d'installé à moitié
  shared[0].size = z.length + 5; fs.rmSync(path.join(com, 'lat-a320-perso'), { recursive: true, force: true });
  await liv2.install('partage-lat-a320-perso');
  assert.strictEqual(liv2.jobs['partage-lat-a320-perso'].state, 'error'); assert.ok(!fs.existsSync(path.join(com, 'lat-a320-perso')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('livrées perso : OK');
})().catch((e) => { console.error(e); process.exit(1); });

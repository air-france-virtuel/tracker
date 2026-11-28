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
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('livrées perso : OK');
})().catch((e) => { console.error(e); process.exit(1); });

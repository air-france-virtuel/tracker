'use strict';
// Essais du lien avec Universal Announcer : dossier, choix des sons, envoi des annonces, détection du logiciel.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ua = require('../src/ua');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-'));
  const ann = path.join(tmp, 'Mes sons', 'Announcements');
  fs.mkdirSync(path.join(ann, 'Default'), { recursive: true });
  fs.mkdirSync(path.join(ann, 'LAT'), { recursive: true });

  // 1. réglages d'Universal Announcer dans %APPDATA%\UniversalAnnouncer
  const appdata = path.join(tmp, 'appdata');
  fs.mkdirSync(path.join(appdata, 'UniversalAnnouncer'), { recursive: true });
  const shown = process.platform === 'win32' ? ann : ann; // chemin absolu
  fs.writeFileSync(path.join(appdata, 'UniversalAnnouncer', 'settings.json'), JSON.stringify({ AnnouncementsPath: 'C:\\\\Introuvable\\\\Announcements', Other: 1 }));
  assert.strictEqual(ua.findAnnouncements({ APPDATA: appdata }), null, 'un chemin qui n’existe pas est ignoré');
  assert.strictEqual(ua.findAnnouncements({}), null);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(appdata, 'UniversalAnnouncer', 'settings.json'), JSON.stringify({ AnnouncementsPath: shown }));
    assert.strictEqual(ua.findAnnouncements({ APPDATA: appdata }), shown);
  }

  // 2. choix du fichier : LAT d'abord, puis Default ; étiquette d'avion prioritaire
  fs.writeFileSync(path.join(ann, 'Default', 'BoardingWelcome.ogg'), 'x');
  fs.writeFileSync(path.join(ann, 'Default', 'SafetyBriefing.ogg'), 'x');
  fs.writeFileSync(path.join(ann, 'LAT', 'BoardingWelcome.ogg'), 'x');
  fs.writeFileSync(path.join(ann, 'LAT', 'BoardingWelcome[A320].ogg'), 'x');
  fs.writeFileSync(path.join(ann, 'LAT', 'notes.txt'), 'x');
  assert.strictEqual(ua.fileFor(ann, 'BoardingWelcome', 'A320'), path.join(ann, 'LAT', 'BoardingWelcome[A320].ogg'));
  assert.strictEqual(ua.fileFor(ann, 'BoardingWelcome', 'B738'), path.join(ann, 'LAT', 'BoardingWelcome.ogg'));
  assert.strictEqual(ua.fileFor(ann, 'SafetyBriefing'), path.join(ann, 'Default', 'SafetyBriefing.ogg'));
  assert.strictEqual(ua.fileFor(ann, 'AfterLanding'), null);
  assert.strictEqual(ua.fileFor(null, 'BoardingWelcome'), null);
  // chaque annonce du tracker a son équivalent
  assert.strictEqual(Object.keys(ua.MAP).length, 10);

  // 3. envoi des annonces du pilote vers LAT (remplace l'ancienne version, signale ce qui n'est pas en OGG)
  const mine = path.join(tmp, 'mine'); fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'a.mp3'), 'mp3'); fs.writeFileSync(path.join(mine, 'b.ogg'), 'ogg');
  const r = ua.exportPack(ann, { boarding_welcome: { file: path.join(mine, 'a.mp3') }, landing_welcome: { file: path.join(mine, 'b.ogg') }, inconnu: { file: path.join(mine, 'b.ogg') } });
  assert.deepStrictEqual(r.copied.sort(), ['AfterLanding', 'BoardingWelcome']);
  assert.deepStrictEqual(r.notOgg, ['BoardingWelcome']);
  assert.ok(!fs.existsSync(path.join(ann, 'LAT', 'BoardingWelcome.ogg')), 'ancienne version remplacée');
  assert.strictEqual(fs.readFileSync(path.join(ann, 'LAT', 'BoardingWelcome.mp3'), 'utf8'), 'mp3');
  assert.ok(fs.existsSync(path.join(ann, 'LAT', 'BoardingWelcome[A320].ogg')), 'les variantes du pilote ne sont pas touchées');
  assert.throws(() => ua.exportPack(null, {}));

  // 4. détection du logiciel lancé
  const fake = (out) => (cmd, args, opts, cb) => cb(null, out);
  assert.strictEqual(await ua.isRunning(fake('UniversalAnnouncer.exe   1234 Console   1   80 000 K')), true);
  assert.strictEqual(await ua.isRunning(fake('INFO: No tasks are running which match the specified criteria.')), false);
  assert.strictEqual(await ua.isRunning((c, a, o, cb) => cb(new Error('x'))), false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('universal announcer : OK');
})().catch((e) => { console.error(e); process.exit(1); });

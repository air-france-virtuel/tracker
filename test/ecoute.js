'use strict';
// Écoute de Max : phrase dictée → question, détection de fin de phrase, extraction du modèle.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AskMax = require('../renderer/askmax.js');
const Micro = require('../renderer/micro.js');
const { extract, MaxEcoute } = require('../src/ecoute.js');

(async () => {
  // alphabet aéronautique, mots mal entendus, phrases inventées sur un silence
  assert.strictEqual(AskMax.fromSpeech('Météo à Lima Fox Papa Golf.'), 'météo à LFPG');
  assert.strictEqual(AskMax.fromSpeech('Métio LFPG.'), 'météo LFPG');
  assert.strictEqual(AskMax.fromSpeech('météo à L F P G'), 'météo à LFPG');
  assert.strictEqual(AskMax.fromSpeech('Roulage Alpha Bravo Whiskey 2, piste 27 gauche.'), 'Roulage A B W2 piste 27 gauche');
  assert.strictEqual(AskMax.fromSpeech('Quel est le cost index ?'), 'Quel est le cost index ?');
  assert.strictEqual(AskMax.fromSpeech('Sous-titres réalisés par la communauté d’Amara.org'), '');
  assert.strictEqual(AskMax.fromSpeech('   '), '');
  assert.strictEqual(AskMax.fromSpeech('mettre la météo'), 'mettre la météo');
  // mots d'aviation mal entendus
  for (const said of ['Donne-moi le cosse standard', 'Donne-moi le code index.', 'Quel est le Coste index ?', 'Le costindex']) assert.ok(/cost index/.test(AskMax.fromSpeech(said)), said);
  assert.strictEqual(AskMax.fromSpeech('combien de temps avant le T O D'), 'combien de temps avant le TOD');
  assert.strictEqual(AskMax.fromSpeech('donne moi le Q N H'), 'donne moi le QNH');

  // la phrase dictée trouve la bonne réponse
  const plan = { origin: { icao: 'LFPG', name: 'Paris Charles de Gaulle', rwy: '27L' }, destination: { icao: 'LEBL', name: 'Barcelona', rwy: '24R' }, metarDep: 'LFPG 211200Z 25010KT 9999 09/04 Q1017', metarArr: 'LEBL 211200Z 32005KT CAVOK 16/08 Q1020', costIndex: 35 };
  const ask = (said) => AskMax.answer(AskMax.fromSpeech(said), { plan, t: { alt: 0, gs: 0 } });
  assert.ok(/LFPG/.test(ask('Métio LFPG.').text), 'météo du départ dictée');
  assert.ok(/LFPG/.test(ask('Météo à Lima Fox Papa Golf.').text), 'météo en alphabet aéronautique');
  assert.ok(/LEBL/.test(ask('donne-moi la météo à Barcelone.').text), 'météo de l’arrivée dictée');

  // fin de phrase : parole puis silence → terminé ; silence seul → rien entendu
  const feed = (vad, rms, ms) => { let r = 'continue'; for (let t = 0; t < ms && r === 'continue'; t += 128) r = vad(rms, 128); return r; };
  let v = Micro.makeVad();
  assert.strictEqual(feed(v, 0.003, 400), 'continue');
  assert.strictEqual(feed(v, 0.06, 1500), 'continue');
  assert.strictEqual(feed(v, 0.004, 1600), 'done');
  assert.ok(v.heard());
  v = Micro.makeVad();
  assert.strictEqual(feed(v, 0.003, 6000), 'nothing');
  assert.ok(!v.heard());
  v = Micro.makeVad();
  feed(v, 0.003, 400);
  assert.strictEqual(feed(v, 0.06, 20000), 'done', 'arrêt au bout de 12 s même si on parle encore');

  // extraction : seuls les fichiers attendus sont gardés, et vérifiés
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecoute-'));
  const files = {
    'a.onnx': { size: 800, sha256: '52d7319383ac48cb3c5472abdec7b9c6605455142716119d6e10a8d4c64e2f5d' },
    'b.txt': { size: 6, sha256: 'fac3a71eba0e92e9c87e94a3997847151d025e6179eb798fac93b894dcd8491d' }
  };
  const fx = path.join(__dirname, 'fixtures', 'ecoute.tar.bz2');
  let bytes = 0;
  await extract(fs.createReadStream(fx), dir, (n) => { bytes += n; }, files);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.onnx', 'b.txt']);
  assert.strictEqual(bytes, fs.statSync(fx).size);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ecoute-'));
  await assert.rejects(extract(fs.createReadStream(fx), dir2, null, { 'a.onnx': { size: 800, sha256: '0'.repeat(64) } }), /incomplet ou modifié/);
  await assert.rejects(extract(fs.createReadStream(fx), dir2, null, { 'absent.onnx': { size: 1, sha256: '0'.repeat(64) } }), /incomplète/);
  assert.ok(!fs.readdirSync(dir2).some((f) => !f.endsWith('.part')));

  // sans modèle : pas installé, et la reconnaissance le dit clairement
  const e = new MaxEcoute(dir2);
  assert.strictEqual(e.status().installed, false);
  await assert.rejects(e.recognize(new Float32Array(16000)), /pas installée/);

  console.log('écoute : OK');
})().catch((e) => { console.error(e); process.exit(1); });

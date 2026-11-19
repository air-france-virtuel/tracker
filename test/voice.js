// Vérifie la voix de Max dans Electron : statut, synthèse, lecture et réglages.
// Usage : node test/voice.js <chemin de l'appli (dossier ou app.asar)> <dossier contenant kokoro-v1.0.onnx>
const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
(async () => {
  const appPath = process.argv[2] || path.join(__dirname, '..');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'afv-ud-'));
  fs.mkdirSync(path.join(ud, 'voix'));
  if (process.argv[3]) fs.symlinkSync(path.join(process.argv[3], 'kokoro-v1.0.onnx'), path.join(ud, 'voix', 'kokoro-v1.0.onnx'));
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--user-data-dir=' + ud, appPath] });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', (e) => errs.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await win.waitForTimeout(1500);
  const st = await win.evaluate(() => afv.voiceStatus());
  console.log('statut', JSON.stringify(st));
  await win.click('[data-tab=reglages]');
  await win.screenshot({ path: (process.argv[4] || '/tmp') + '/voix-reglages.png' });
  if (st.installed) {
    const t0 = Date.now();
    const r = await win.evaluate(async () => { const r = await afv.voiceSpeak('Atterrissage dur : 720 ft/min. Roulage vers la piste 27L.', true); return r && { n: r.samples.length, sr: r.sampleRate, rate: r.playbackRate, f32: r.samples instanceof Float32Array }; });
    console.log('synthèse', JSON.stringify(r), Date.now() - t0, 'ms');
    if (!r || r.n < 24000 || !r.f32) throw new Error('synthèse vide');
    await win.click('#btnVoiceTest');
    await win.waitForTimeout(8000);
  }
  console.log('erreurs', JSON.stringify(errs));
  await app.close();
  if (errs.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

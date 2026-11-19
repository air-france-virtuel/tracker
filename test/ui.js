// Lance l'appli, joue le vol de démo et prend des captures.
const { _electron: electron } = require('playwright');
const path = require('path');
(async () => {
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '/home/claude/afv-tracker/dist/win-unpacked/resources/app.asar'], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', (e) => errs.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await win.setViewportSize({ width: 1360, height: 860 });
  await win.waitForTimeout(1200);
  const out = process.argv[2] || '/tmp/shots';
  require('fs').mkdirSync(out, { recursive: true });
  // flotte
  await win.click('[data-tab=hangar]');
  await win.fill('#newReg', 'F-TEST1'); await win.selectOption('#newType', 'A320'); await win.click('#btnAddPlane');
  await win.screenshot({ path: out + '/2-hangar.png' });
  await win.click('[data-tab=vol]');
  await win.selectOption('#selAircraft', 'F-TEST1');
  await win.screenshot({ path: out + '/1-prep.png' });
  await win.check('#demoHard');
  await win.click('#btnDemo');
  const shotsAt = { 3: '3-montee', 4: '4-croisiere', 6: '5-approche' };
  const t0 = Date.now();
  const taken = {};
  while (Date.now() - t0 < 600000) {
    const ph = await win.evaluate(() => { const c = document.querySelector('.ph.cur'); return c ? c.textContent : ''; });
    const idx = ['Boarding','Roulage','Décollage','Montée','Croisière','Descente','Approche','Atterrissage','Parking'].indexOf(ph);
    if (shotsAt[idx] && !taken[idx]) { taken[idx] = 1; await win.waitForTimeout(idx === 4 ? 25000 : 1500); await win.screenshot({ path: out + '/' + shotsAt[idx] + '.png' }); }
    if (!(await win.isHidden('#reportModal'))) break;
    await win.waitForTimeout(1000);
  }
  await win.screenshot({ path: out + '/6-rapport.png' });
  await win.click('#btnCloseReport');
  await win.click('[data-tab=hangar]');
  await win.screenshot({ path: out + '/7-hangar-apres.png' });
  await win.click('[data-tab=vols]'); await win.waitForTimeout(500);
  await win.screenshot({ path: out + '/8-mes-vols.png' });
  await win.click('[data-tab=sons]'); await win.screenshot({ path: out + '/9-sons.png' });
  await win.click('[data-tab=avis]'); await win.click('[data-star="4"]'); await win.click('[data-tag="Alerte TOD"]'); await win.fill('#fbText', 'Test'); await win.click('#btnSendFb');
  await win.screenshot({ path: out + '/10-avis.png' });
  console.log('Durée vol démo (s):', Math.round((Date.now() - t0) / 1000));
  console.log('Erreurs :', errs.length ? errs : 'aucune');
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });

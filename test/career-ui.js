// Vérifie les écrans carrière dans Electron et le lien mission ↔ rapport de vol.
// Usage : node test/career-ui.js <dossier des captures>
const { _electron: electron } = require('playwright');
const fs = require('fs'); const path = require('path'); const os = require('os');
(async () => {
  const out = process.argv[2] || '/tmp';
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'afv-car-'));
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--user-data-dir=' + ud, path.join(__dirname, '..')] });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', (e) => errs.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await win.setViewportSize({ width: 1360, height: 860 });
  await win.waitForTimeout(3000);
  await win.screenshot({ path: out + '/c-infos.png' });
  await win.click('[data-tab=carriere]'); await win.waitForTimeout(400);
  await win.screenshot({ path: out + '/c-carriere.png' });
  await win.click('[data-tab=missions]'); await win.waitForTimeout(400);
  await win.click('#misDaily .dm.first'); await win.waitForTimeout(300);
  await win.click('#misDetail [data-accept]'); await win.waitForTimeout(400);
  await win.screenshot({ path: out + '/c-missions.png' });
  await win.click('[data-filter=form]'); await win.waitForTimeout(300);
  await win.screenshot({ path: out + '/c-formation.png' });
  await win.click('#misDetail [data-fly]').catch(() => {});
  await win.click('[data-tab=missions]'); await win.click('[data-filter=all]');
  await win.click('#misDaily .dm.first'); await win.click('#misDetail [data-fly]'); await win.waitForTimeout(400);
  await win.screenshot({ path: out + '/c-tracker.png' });
  const sel = await win.$eval('#selMission', (s) => s.value);
  console.log('mission choisie dans le tracker :', sel);
  // vol de démo rattaché à une mission : doit être refusé proprement
  const rep = await win.evaluate(async () => {
    const plan = await afv.demoPlan();
    const p = new Promise((res) => afv.on('flight:report', res));
    await afv.startFlight({ mode: 'demo', plan, speed: 60, missionId: 'p-cdg-nce' });
    return p;
  });
  console.log('rapport mission :', JSON.stringify(rep.mission));
  await win.waitForTimeout(500);
  await win.screenshot({ path: out + '/c-rapport.png' });
  const car = await win.evaluate(() => afv.getCareer());
  console.log('heures après démo :', car.hours, '· grade', car.gradeName);
  console.log('erreurs', JSON.stringify(errs));
  await app.close();
  if (errs.length || !rep.mission || rep.mission.validated || car.hours !== 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

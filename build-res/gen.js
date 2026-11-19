const { chromium } = require('playwright');
const fs = require('fs');
const img = 'data:image/jpeg;base64,' + fs.readFileSync(__dirname + '/../renderer/assets/fond-cockpit.jpg').toString('base64');
const LOGO = fs.readFileSync(__dirname + '/logo.svg', 'utf8').trim();
const logo = (s) => LOGO.replace('<svg ', '<svg width="' + s + '" height="' + s + '" ');
const pages = {
  icon: [256, 256, logo(256)],
  sidebar: [164, 314, `<div style="width:164px;height:314px;position:relative;overflow:hidden;background:#0A1E4A;font-family:'Segoe UI',Arial,sans-serif;color:#fff">
    <div style="position:absolute;inset:0;background:url(${img}) 38% center/auto 100%;opacity:.35"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,30,74,.55),rgba(10,30,74,.95) 70%)"></div>
    <div style="position:absolute;left:0;right:0;bottom:0;height:5px;display:flex"><div style="flex:1;background:#1D3F8F"></div><div style="flex:1;background:#fff"></div><div style="flex:1;background:#C8102E"></div></div>
    <div style="position:absolute;left:16px;top:22px">${logo(38)}</div>
    <div style="position:absolute;left:16px;right:12px;bottom:34px"><div style="font-size:19px;font-weight:700;line-height:1.15">Air France<br>Virtuel</div><div style="margin-top:8px;font-size:11.5px;color:#C9D4EE">Tracker de vol</div><div style="margin-top:8px;display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.08em;background:#C8102E;border-radius:3px;padding:2px 6px">BÊTA</div></div></div>`],
  progress: [220, 314, `<div style="width:220px;height:314px;position:relative;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;color:#fff">
    <div style="position:absolute;inset:0;background:url(${img}) 34% center/auto 100%"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(10,30,74,.15),rgba(10,30,74,.92))"></div>
    <div style="position:absolute;left:14px;top:14px">${logo(30)}</div>
    <div style="position:absolute;left:12px;right:12px;bottom:14px;background:rgba(7,21,51,.86);border-radius:8px;padding:9px 10px;font-size:11px;line-height:1.4"><b style="color:#FFD45C">Le savais-tu ?</b><br>Max, ton copilote, te prévient 10 minutes avant le début de descente et à chaque palier SimBrief.</div></div>`],
  header: [150, 57, `<div style="width:150px;height:57px;background:#fff;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;box-sizing:border-box;gap:7px;font-family:'Segoe UI',Arial,sans-serif"><div style="text-align:right;line-height:1.1"><div style="font-size:12px;font-weight:700;color:#0A1E4A">Air France Virtuel</div><div style="font-size:10px;color:#5B667D">Tracker de vol</div></div>${logo(34)}</div>`]
};
(async () => {
  const b = await chromium.launch();
  for (const [name, [w, h, html]] of Object.entries(pages)) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
    await p.screenshot({ path: __dirname + '/' + name + '.png', omitBackground: name === 'icon' });
  }
  await b.close();
})();

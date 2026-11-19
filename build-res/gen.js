const { chromium } = require('playwright');
const fs = require('fs');
const img = 'data:image/jpeg;base64,' + fs.readFileSync('../renderer/assets/fond-cockpit.jpg').toString('base64');
const logo = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 34 34"><rect width="34" height="34" rx="7" fill="#fff"/><path d="M7 24 L17 8 L27 24" fill="none" stroke="#0A1E4A" stroke-width="3" stroke-linejoin="round"/><path d="M11 24 L23 24" stroke="#C8102E" stroke-width="3"/></svg>`;
const pages = {
  icon: [256, 256, `<div style="width:256px;height:256px;background:#0A1E4A;border-radius:52px;display:flex;align-items:center;justify-content:center"><svg width="190" height="190" viewBox="0 0 34 34"><path d="M7 24 L17 8 L27 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"/><path d="M11 24 L23 24" stroke="#E8334A" stroke-width="3.2"/></svg></div>`],
  sidebar: [164, 314, `<div style="width:164px;height:314px;position:relative;overflow:hidden;background:#0A1E4A;font-family:'Segoe UI',Arial,sans-serif;color:#fff">
    <div style="position:absolute;inset:0;background:url(${img}) 38% center/auto 100%;opacity:.35"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,30,74,.55),rgba(10,30,74,.95) 70%)"></div>
    <div style="position:absolute;left:0;right:0;bottom:0;height:5px;display:flex"><div style="flex:1;background:#1D3F8F"></div><div style="flex:1;background:#fff"></div><div style="flex:1;background:#C8102E"></div></div>
    <div style="position:absolute;left:16px;top:22px">${logo(38)}</div>
    <div style="position:absolute;left:16px;right:12px;bottom:34px"><div style="font-size:19px;font-weight:700;line-height:1.15">Air France<br>Virtuel</div><div style="margin-top:8px;font-size:11.5px;color:#C9D4EE">Tracker de vol</div><div style="margin-top:8px;display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.08em;background:#C8102E;border-radius:3px;padding:2px 6px">BÊTA</div></div></div>`],
  header: [150, 57, `<div style="width:150px;height:57px;background:#fff;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;box-sizing:border-box;gap:7px;font-family:'Segoe UI',Arial,sans-serif"><div style="text-align:right;line-height:1.1"><div style="font-size:12px;font-weight:700;color:#0A1E4A">Air France Virtuel</div><div style="font-size:10px;color:#5B667D">Tracker de vol</div></div><svg width="30" height="30" viewBox="0 0 34 34"><rect width="34" height="34" rx="7" fill="#0A1E4A"/><path d="M7 24 L17 8 L27 24" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><path d="M11 24 L23 24" stroke="#E8334A" stroke-width="3"/></svg></div>`]
};
(async () => {
  const b = await chromium.launch();
  for (const [name, [w, h, html]] of Object.entries(pages)) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
    await p.screenshot({ path: name + '.png', omitBackground: name === 'icon' });
  }
  await b.close();
})();

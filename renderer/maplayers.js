'use strict';
/* global afv */
// Fonds de carte communs : plan (terres Natural Earth), satellite (NASA GIBS) et radar météo (RainViewer).
// Toutes les cartes utilisent la projection Web Mercator, en « degrés Mercator » :
// X = lon + 180 (0 à 360), Y = 180 − merc(lat) (0 en haut à 85° N, 360 en bas à 85° S).
// Une tuile de niveau z couvre 360 / 2^z unités dans les deux sens.
(function () {
  const merc = (lat) => { const l = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180; return Math.log(Math.tan(Math.PI / 4 + l / 2)) * 180 / Math.PI; };
  const LX = (lon) => lon + 180;
  const LY = (lat) => 180 - merc(lat);

  const pad = (n) => String(n).padStart(2, '0');
  const yesterday = () => { const d = new Date(Date.now() - 86400000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
  const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';
  // Plusieurs adresses possibles : si une tuile ne charge pas, on essaie la suivante.
  const SAT = [
    (z, x, y) => GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/' + z + '/' + y + '/' + x + '.jpeg',
    (z, x, y) => GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default//GoogleMapsCompatible_Level8/' + z + '/' + y + '/' + x + '.jpeg',
    (z, x, y) => GIBS + 'VIIRS_SNPP_CorrectedReflectance_TrueColor/default/' + yesterday() + '/GoogleMapsCompatible_Level9/' + z + '/' + y + '/' + x + '.jpg'
  ];
  const state = { radar: null, radarAt: 0, pending: null };

  async function radarInfo() {
    if (state.radar && Date.now() - state.radarAt < 5 * 60 * 1000) return state.radar;
    if (!state.pending) {
      state.pending = afv.getRadar().then((r) => { state.radar = r; state.radarAt = Date.now(); state.pending = null; return r; })
        .catch(() => { state.pending = null; return null; });
    }
    return state.pending;
  }

  // Tuiles visibles dans la zone [x0, y0, x1, y1] (coordonnées Mercator) pour un écran de pxPerUnit pixels par unité.
  function tileSet(view, pxPerUnit, maxZ) {
    const z = Math.max(1, Math.min(maxZ, Math.round(Math.log2((360 * pxPerUnit) / 256))));
    const n = 2 ** z, s = 360 / n;
    const out = [];
    const xa = Math.floor(view[0] / s), xb = Math.floor(view[2] / s);
    const ya = Math.max(0, Math.floor(view[1] / s)), yb = Math.min(n - 1, Math.floor(view[3] / s));
    for (let ty = ya; ty <= yb; ty++) for (let tx = xa; tx <= xb; tx++) {
      if (out.length > 80) break;
      out.push({ z, x: ((tx % n) + n) % n, y: ty, X: tx * s, Y: ty * s, s });
    }
    return out;
  }

  // Remplit un groupe SVG <g> (déjà placé avec la bonne transformation) avec les tuiles demandées.
  // Ne recrée les images que si l'ensemble de tuiles change.
  function fill(g, opts) {
    const { view, pxPerUnit, sat, radar } = opts;
    const parts = [];
    let key = '';
    if (sat) { const t = tileSet(view, pxPerUnit, 8); key += 's' + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'sat' }))); }
    const r = radar && state.radar;
    if (r) { const t = tileSet(view, pxPerUnit, 7); key += 'r' + r.path + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'radar' }))); }
    if (radar && !state.radar) radarInfo().then((x) => { if (x && opts.onReady) opts.onReady(); });
    if (g.dataset.key === key) return;
    g.dataset.key = key;
    const NS = 'http://www.w3.org/2000/svg';
    g.textContent = '';
    for (const { q, kind } of parts) {
      const img = document.createElementNS(NS, 'image');
      img.setAttribute('x', q.X); img.setAttribute('y', q.Y);
      img.setAttribute('width', q.s + 0.02); img.setAttribute('height', q.s + 0.02);
      img.setAttribute('preserveAspectRatio', 'none');
      if (kind === 'sat') {
        let i = 0;
        img.setAttribute('href', SAT[0](q.z, q.x, q.y));
        img.addEventListener('error', () => { i++; if (i < SAT.length) img.setAttribute('href', SAT[i](Math.min(q.z, 9), q.x, q.y)); });
      } else {
        img.setAttribute('href', r.host + r.path + '/256/' + q.z + '/' + q.x + '/' + q.y + '/2/1_1.png');
        img.setAttribute('opacity', '0.75');
      }
      g.appendChild(img);
    }
  }

  // Petit sélecteur commun : Plan / Satellite + Radar météo.
  function controls(prefix) {
    return '<div class="row layer-ctl"><button class="tag on" data-layer="' + prefix + ':plan" aria-pressed="true">Plan</button><button class="tag" data-layer="' + prefix + ':sat" aria-pressed="false">Satellite</button>' +
      '<button class="tag" data-layer="' + prefix + ':radar" aria-pressed="false">Radar météo</button></div>';
  }

  window.MapLayers = { merc, LX, LY, fill, radarInfo, controls, state };
})();

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
  // Satellite net jusqu'au niveau 15 : Sentinel-2 cloudless (EOX), puis les tuiles de la NASA en secours.
  const EOX = (z, x, y) => 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/' + z + '/' + y + '/' + x + '.jpg';
  // Plan détaillé quand on zoome : CARTO (données © OpenStreetMap), net jusqu'au niveau des rues.
  const PLAN = (z, x, y) => 'https://' + 'abcd'[(x + y) % 4] + '.basemaps.cartocdn.com/light_all/' + z + '/' + x + '/' + y + '.png';
  const PLAN_FROM = 6; // en dessous : le fond vectoriel (plus léger, mêmes couleurs)
  const SAT = [
    EOX,
    (z, x, y) => GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/' + z + '/' + y + '/' + x + '.jpeg',
    (z, x, y) => GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default//GoogleMapsCompatible_Level8/' + z + '/' + y + '/' + x + '.jpeg',
    (z, x, y) => GIBS + 'VIIRS_SNPP_CorrectedReflectance_TrueColor/default/' + yesterday() + '/GoogleMapsCompatible_Level9/' + z + '/' + y + '/' + x + '.jpg'
  ];
  const state = { radar: null, radarAt: 0, pending: null, planFail: false };

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
    // tuiles choisies pour l'écran réel (écrans haute définition compris) : jamais étirées, donc jamais floues
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const z = Math.max(1, Math.min(maxZ, Math.ceil(Math.log2((360 * pxPerUnit * dpr) / 256) - 0.15)));
    const n = 2 ** z, s = 360 / n;
    const out = [];
    const xa = Math.floor(view[0] / s), xb = Math.floor(view[2] / s);
    const ya = Math.max(0, Math.floor(view[1] / s)), yb = Math.min(n - 1, Math.floor(view[3] / s));
    for (let ty = ya; ty <= yb; ty++) for (let tx = xa; tx <= xb; tx++) {
      if (out.length > 160) break;
      out.push({ z, x: ((tx % n) + n) % n, y: ty, X: tx * s, Y: ty * s, s });
    }
    return out;
  }

  // Remplit un groupe SVG <g> (déjà placé avec la bonne transformation) avec les tuiles demandées.
  // Ne recrée les images que si l'ensemble de tuiles change.
  function fill(g, opts) {
    const { view, pxPerUnit, sat, radar, plan } = opts;
    const parts = [];
    let key = '', z = 0, planOn = false;
    if (sat) { const t = tileSet(view, pxPerUnit, 15); z = t.length ? t[0].z : 0; key += 's' + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'sat' }))); }
    else if (plan) {
      const t = tileSet(view, pxPerUnit, 18); z = t.length ? t[0].z : 0;
      if (z >= PLAN_FROM && !state.planFail) { planOn = true; key += 'p' + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'plan' }))); }
    }
    const r = radar && state.radar;
    if (r) { const t = tileSet(view, pxPerUnit, 7); key += 'r' + r.path + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'radar' }))); }
    if (radar && !state.radar) radarInfo().then((x) => { if (x && opts.onReady) opts.onReady(); });
    const res = { z, plan: planOn, sat: !!sat };
    if (g.dataset.key === key) return res;
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
        img.addEventListener('error', () => { i++; if (i < SAT.length) img.setAttribute('href', SAT[i](Math.min(q.z, i === 1 || i === 2 ? 8 : 9), q.x, q.y)); });
      } else if (kind === 'plan') {
        img.setAttribute('href', PLAN(q.z, q.x, q.y));
        // pas d'internet ou serveur indisponible : retour au fond simple plutôt qu'une carte vide
        img.addEventListener('error', () => { if (!state.planFail) { state.planFail = true; g.dataset.key = ''; if (opts.onReady) opts.onReady(); setTimeout(() => { state.planFail = false; }, 5 * 60 * 1000); } });
      } else {
        img.setAttribute('href', r.host + r.path + '/256/' + q.z + '/' + q.x + '/' + q.y + '/2/1_1.png');
        img.setAttribute('opacity', '0.75');
      }
      g.appendChild(img);
    }
    return res;
  }
  // crédits des fonds de carte affichés
  function credit(L, res) {
    const c = ['Fond : Natural Earth'];
    if (L.sat) c.push('Satellite : Sentinel-2 cloudless 2021 (EOX, données Copernicus)');
    else if (res && res.plan) c.push('Plan : © OpenStreetMap, © CARTO');
    if (L.radar) c.push('Radar : RainViewer' + (state.radar ? ' (' + new Date(state.radar.time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ')' : ''));
    return c.join(' · ');
  }

  // Petit sélecteur commun : Plan / Satellite + Radar météo.
  function controls(prefix) {
    return '<div class="row layer-ctl"><button class="tag on" data-layer="' + prefix + ':plan" aria-pressed="true">Plan</button><button class="tag" data-layer="' + prefix + ':sat" aria-pressed="false">Satellite</button>' +
      '<button class="tag" data-layer="' + prefix + ':radar" aria-pressed="false">Radar météo</button></div>';
  }

  window.MapLayers = { merc, LX, LY, fill, radarInfo, controls, state, credit };
})();

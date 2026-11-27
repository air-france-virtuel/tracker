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
  // Plusieurs sources possibles : si une tuile ne charge pas, on essaie la suivante (au niveau de zoom qu'elle sait servir).
  // Satellite net jusqu'aux pistes et aux taxiways (niveau 18) : imagerie Esri ; puis Sentinel-2 cloudless (EOX, niveau 15) et la NASA en secours.
  const ESRI = (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
  const EOX = (z, x, y) => 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/' + z + '/' + y + '/' + x + '.jpg';
  // Plan détaillé quand on zoome : OpenStreetMap servi par EOX (sans clé, même serveur que le satellite), net jusqu'au niveau 16.
  // (CARTO demande maintenant une clé : ses tuiles affichaient « API KEY REQUIRED ».)
  const PLAN = (z, x, y) => 'https://tiles.maps.eox.at/wmts/1.0.0/osm_3857/default/g/' + z + '/' + y + '/' + x + '.jpg';
  const PLAN_FROM = 1; // carte OpenStreetMap à tous les niveaux de zoom (le fond vectoriel ne sert que hors ligne)
  const SAT_MAX = 18, PLAN_MAX = 16, LABELS_MAX = 18;
  const REF = (name) => (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/' + name + '/MapServer/tile/' + z + '/' + y + '/' + x;
  const PLACES = REF('World_Boundaries_and_Places'), ROADS = REF('World_Transportation');
  const SAT = [
    [ESRI, 18],
    [EOX, 15],
    [(z, x, y) => GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/' + z + '/' + y + '/' + x + '.jpeg', 8],
    [(z, x, y) => GIBS + 'VIIRS_SNPP_CorrectedReflectance_TrueColor/default/' + yesterday() + '/GoogleMapsCompatible_Level9/' + z + '/' + y + '/' + x + '.jpg', 9]
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
    if (sat) { const t = tileSet(view, pxPerUnit, SAT_MAX); z = t.length ? t[0].z : 0; key += 's' + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'sat' }))); }
    else if (plan) {
      const t = tileSet(view, pxPerUnit, PLAN_MAX); z = t.length ? t[0].z : 0;
      if (z >= PLAN_FROM && !state.planFail) { planOn = true; key += 'p' + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'plan' }))); }
    }
    // couche de noms par-dessus le satellite : frontières, pays, villes (Esri), et routes quand on zoome
    if (opts.labels) {
      const t = tileSet(view, pxPerUnit, LABELS_MAX);
      key += 'l' + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(',');
      for (const q of t) { if (q.z >= 7) parts.push({ q, kind: 'roads' }); parts.push({ q, kind: 'places' }); }
    }
    const r = radar && state.radar;
    if (r) { const t = tileSet(view, pxPerUnit, 7); key += 'r' + r.path + t.map((q) => q.z + '/' + q.x + '/' + q.y).join(','); parts.push(...t.map((q) => ({ q, kind: 'radar' }))); }
    if (radar && !state.radar) radarInfo().then((x) => { if (x && opts.onReady) opts.onReady(); });
    const res = { z, plan: planOn, sat: !!sat };
    if (g.dataset.key === key) return res;
    g.dataset.key = key;
    const NS = 'http://www.w3.org/2000/svg';
    g.textContent = '';
    // Chaque tuile est posée exactement à sa place (un recouvrement fixe devenait énorme au zoom maximum et
    // les tuiles se chevauchaient). Une source qui ne sert pas ce niveau affiche la portion de sa tuile « parente »,
    // découpée par un petit cadre <svg> : la carte reste continue au lieu d'afficher des morceaux décalés.
    const tile = (q, url, srcZ, opacity) => {
      const k = 2 ** Math.max(0, q.z - srcZ), ps = q.s * k;
      const px = Math.floor(q.x / k), py = Math.floor(q.y / k);
      const box = document.createElementNS(NS, 'svg');
      const ov = q.s * 0.004; // un soupçon de recouvrement, proportionnel à la tuile : pas de fine ligne entre deux tuiles
      box.setAttribute('x', q.X); box.setAttribute('y', q.Y); box.setAttribute('width', q.s + ov); box.setAttribute('height', q.s + ov);
      box.setAttribute('viewBox', q.X + ' ' + q.Y + ' ' + (q.s + ov) + ' ' + (q.s + ov));
      box.setAttribute('preserveAspectRatio', 'none');
      const img = document.createElementNS(NS, 'image');
      img.setAttribute('x', q.X - (q.x - px * k) * q.s); img.setAttribute('y', q.Y - (q.y - py * k) * q.s);
      img.setAttribute('width', ps + ov); img.setAttribute('height', ps + ov);
      img.setAttribute('preserveAspectRatio', 'none');
      if (opacity) img.setAttribute('opacity', opacity);
      img.setAttribute('href', url(Math.min(q.z, srcZ), px, py));
      box.appendChild(img);
      return { box, img };
    };
    for (const { q, kind } of parts) {
      if (kind === 'sat') {
        let i = 0;
        const t = tile(q, SAT[0][0], SAT[0][1]);
        t.img.addEventListener('error', function retry() {
          i++; if (i >= SAT.length) return;
          const n = tile(q, SAT[i][0], SAT[i][1]);
          n.img.addEventListener('error', retry);
          t.box.replaceWith(n.box); t.box = n.box;
        });
        g.appendChild(t.box);
      } else if (kind === 'plan') {
        const t = tile(q, PLAN, PLAN_MAX);
        // pas d'internet ou serveur indisponible : retour au fond simple plutôt qu'une carte vide
        t.img.addEventListener('error', () => { if (!state.planFail) { state.planFail = true; g.dataset.key = ''; if (opts.onReady) opts.onReady(); setTimeout(() => { state.planFail = false; }, 5 * 60 * 1000); } });
        g.appendChild(t.box);
      } else if (kind === 'places' || kind === 'roads') {
        const t = tile(q, kind === 'places' ? PLACES : ROADS, LABELS_MAX, kind === 'roads' ? '0.8' : '');
        t.img.addEventListener('error', () => t.box.remove()); // pas de noms plutôt qu'une case vide
        g.appendChild(t.box);
      } else {
        g.appendChild(tile(q, (z, x, y) => r.host + r.path + '/256/' + z + '/' + x + '/' + y + '/2/1_1.png', 7, '0.75').box);
      }
    }
    return res;
  }
  // crédits des fonds de carte affichés
  function credit(L, res) {
    const c = ['Fond : Natural Earth'];
    if (L.sat) c.push('Satellite et noms : Esri, Maxar, Earthstar Geographics' + (res && res.z > 12 ? '' : ' · Sentinel-2 (EOX)'));
    else if (res && res.plan) c.push('Plan : © contributeurs OpenStreetMap, rendu EOX');
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

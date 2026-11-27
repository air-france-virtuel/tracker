'use strict';
// Carte de roulage de Max : chemin des taxiways entre l'avion et le point d'arrêt de la piste de départ.
// Données : OpenStreetMap (taxiways avec leur nom, pistes, points d'arrêt), via l'API Overpass, gardées 30 jours sur le PC.
// Le calcul (graphe + plus court chemin) est fait ici, hors ligne, une fois les données reçues.
const fs = require('fs');
const path = require('path');

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const MAX_AGE = 30 * 86400000;
const UA = 'LAT-Tracker (+https://github.com/air-france-virtuel/tracker)';

const rad = (d) => (d * Math.PI) / 180;
function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Requête : taxiways, voies d'aire de trafic, pistes et points d'arrêt dans un carré d'environ 7 km autour de l'aéroport.
function query(lat, lon) {
  const dLat = 0.035, dLon = 0.035 / Math.max(0.3, Math.cos(rad(lat)));
  const bb = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((x) => x.toFixed(5)).join(',');
  return '[out:json][timeout:40];(way["aeroway"~"^(taxiway|taxilane|runway)$"](' + bb + ');node["aeroway"="holding_position"](' + bb + '););out body geom;';
}

// Réponse Overpass → données compactes (ce qui sert à la carte et au calcul)
function compact(osm) {
  const ways = [], holds = [];
  for (const e of (osm && osm.elements) || []) {
    const t = e.tags || {};
    if (e.type === 'way' && Array.isArray(e.geometry) && Array.isArray(e.nodes) && e.nodes.length === e.geometry.length) {
      ways.push({ k: t.aeroway === 'runway' ? 'rwy' : t.aeroway === 'taxilane' ? 'lane' : 'twy', ref: String(t.ref || t.name || '').trim().slice(0, 12), n: e.nodes, g: e.geometry.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) });
    } else if (e.type === 'node' && t.aeroway === 'holding_position') {
      holds.push({ id: e.id, lat: e.lat, lon: e.lon, ref: String(t.ref || '').slice(0, 16) });
    }
  }
  return { ways, holds };
}

// Graphe : un sommet par nœud OSM, une arête par tronçon (longueur en mètres)
function graph(data) {
  const pos = new Map(), adj = new Map();
  const add = (a, b, w, ref, k) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, w, ref, k }); };
  for (const way of data.ways) {
    for (let i = 0; i < way.n.length; i++) pos.set(way.n[i], { lat: way.g[i][0], lon: way.g[i][1] });
    for (let i = 1; i < way.n.length; i++) {
      const a = way.n[i - 1], b = way.n[i];
      const d = distM(pos.get(a), pos.get(b));
      // rouler sur une piste : seulement pour la traverser ou la remonter si rien d'autre n'est possible
      const w = way.k === 'rwy' ? d * 8 : way.k === 'lane' ? d * 1.15 : d;
      add(a, b, w, way.ref, way.k); add(b, a, w, way.ref, way.k);
    }
  }
  const taxiNodes = new Set();
  for (const way of data.ways) if (way.k !== 'rwy') for (const id of way.n) taxiNodes.add(id);
  return { pos, adj, taxiNodes };
}

function nearest(G, p, filter, maxM) {
  let best = null, bd = maxM || Infinity;
  for (const [id, q] of G.pos) { if (filter && !filter(id)) continue; const d = distM(p, q); if (d < bd) { bd = d; best = id; } }
  return best == null ? null : { id: best, d: bd };
}

// Plus court chemin (Dijkstra, petit tas binaire)
function dijkstra(G, from, to) {
  const dist = new Map([[from, 0]]), prev = new Map(), heap = [[0, from]];
  const push = (x) => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop();
    if (u === to) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const e of G.adj.get(u) || []) {
      const nd = d + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { u, e }); push([nd, e.to]); }
    }
  }
  if (!dist.has(to)) return null;
  const steps = [];
  for (let v = to; v !== from; v = prev.get(v).u) steps.push({ node: v, e: prev.get(v).e });
  return steps.reverse();
}

// Route de roulage : start = position de l'avion, thr = seuil de la piste de départ ({lat, lon, ident})
function route(data, start, thr) {
  const G = graph(data);
  if (!G.pos.size) return { ok: false, error: 'Pas de taxiways connus pour cet aéroport dans OpenStreetMap.' };
  const s = nearest(G, start, (id) => G.taxiNodes.has(id), 800);
  if (!s) return { ok: false, error: 'L’avion est trop loin des taxiways connus (plus de 800 m).' };
  // arrivée : le point d'arrêt le plus proche du seuil s'il existe sur un taxiway, sinon le taxiway le plus proche du seuil
  const holdIds = new Set(data.holds.map((h) => h.id));
  const hold = nearest(G, thr, (id) => holdIds.has(id) && G.taxiNodes.has(id), 400);
  const end = hold || nearest(G, thr, (id) => G.taxiNodes.has(id), 500);
  if (!end) return { ok: false, error: 'Je ne trouve pas d’accès à la piste ' + (thr.ident || '') + ' dans les données.' };
  const steps = s.id === end.id ? [] : dijkstra(G, s.id, end.id);
  if (!steps) return { ok: false, error: 'Je ne trouve pas de chemin jusqu’à la piste ' + (thr.ident || '') + '.' };
  // suite des taxiways empruntés (noms regroupés), traversées de piste signalées
  const legs = [];
  let lenM = 0, prevPos = G.pos.get(s.id);
  for (const st of steps) {
    const p = G.pos.get(st.node), d = distM(prevPos, p); prevPos = p; lenM += d;
    const name = st.e.k === 'rwy' ? 'piste ' + (st.e.ref || '') : st.e.ref || '';
    const last = legs[legs.length - 1];
    if (last && last.name === name) last.m += d; else legs.push({ name, m: d, rwy: st.e.k === 'rwy', lane: st.e.k === 'lane' });
  }
  // les petits bouts sans nom (moins de 120 m) ne sont pas annoncés
  let said = legs.filter((l) => l.name && (l.m >= 60 || l.rwy)).map((l) => l.name).filter((n, i, a) => n !== a[i - 1]);
  // suites de lignes numérotées de la même famille (P50, P55, P60…) : « P50 à P101 »
  const fam = (n) => (/^([A-Z]+)\d+$/.exec(n) || [])[1] || null;
  const grouped = [];
  for (let i = 0; i < said.length;) {
    let j = i; while (j + 1 < said.length && fam(said[i]) && fam(said[j + 1]) === fam(said[i])) j++;
    grouped.push(j - i >= 2 ? said[i] + ' à ' + said[j] : said.slice(i, j + 1).join(', ')); i = j + 1;
  }
  said = grouped;
  const path = [G.pos.get(s.id)].concat(steps.map((st) => G.pos.get(st.node)));
  return {
    ok: true, path, lengthM: Math.round(lenM), legs: said, crossings: legs.filter((l) => l.rwy).map((l) => l.name),
    start: G.pos.get(s.id), startGap: Math.round(s.d), end: G.pos.get(end.id), holding: hold ? (data.holds.find((h) => h.id === end.id) || {}).ref || 'point d’arrêt' : '', thr
  };
}

// Phrase de Max
function sentence(r, rwy) {
  if (!r.ok) return r.error;
  const via = r.legs.length ? 'Roule via ' + r.legs.join(', ') : 'Roule tout droit';
  return via + ' jusqu’au ' + (r.holding ? 'point d’arrêt' + (r.holding !== 'point d’arrêt' ? ' ' + r.holding : '') : 'seuil') + ' de la piste ' + rwy + ', environ ' + (r.lengthM >= 1000 ? (r.lengthM / 1000).toFixed(1).replace('.', ',') + ' km' : r.lengthM + ' m') + '.' +
    (r.crossings.length ? ' Attention : tu traverses ' + r.crossings.join(', ') + ', attends l’autorisation.' : '');
}

class Roulage {
  constructor(dir, http) { this.dir = dir; this.http = http || ((u, o) => fetch(u, o)); this.mem = new Map(); }
  file(icao) { return path.join(this.dir, icao.toUpperCase() + '.json'); }
  async airport(icao, lat, lon) {
    icao = String(icao || '').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(icao) || !isFinite(lat) || !isFinite(lon)) throw new Error('Aéroport inconnu.');
    if (this.mem.has(icao)) return this.mem.get(icao);
    try {
      const st = fs.statSync(this.file(icao));
      if (Date.now() - st.mtimeMs < MAX_AGE) { const d = JSON.parse(fs.readFileSync(this.file(icao), 'utf8')); this.mem.set(icao, d); return d; }
    } catch (e) { /* pas encore en cache */ }
    let lastErr = null;
    for (const url of OVERPASS) {
      try {
        const r = await this.http(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent(query(lat, lon)), signal: AbortSignal.timeout(45000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = compact(await r.json());
        if (!d.ways.length) throw new Error('vide');
        d.at = Date.now(); d.icao = icao;
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.file(icao), JSON.stringify(d));
        this.mem.set(icao, d);
        return d;
      } catch (e) { lastErr = e; }
    }
    throw new Error(lastErr && /vide/.test(lastErr.message) ? 'OpenStreetMap ne connaît pas encore les taxiways de ' + icao + '.' : 'Plan de l’aéroport indisponible pour le moment (OpenStreetMap).');
  }
}

module.exports = { Roulage, query, compact, graph, route, sentence, distM };

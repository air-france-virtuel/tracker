'use strict';
// Livrées de la compagnie : catalogue, recherche du dossier Community de MSFS 2024,
// téléchargement et installation (décompression du .zip) sans rien installer d'autre.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const CATALOGUE_URL = 'https://raw.githubusercontent.com/air-france-virtuel/tracker/donnees/livrees/catalogue.json';
const MARK = '.livree-lat.json'; // petit fichier posé dans chaque livrée installée par le tracker

// ---------- dossier Community ----------
// MSFS 2024 note l'emplacement de ses paquets dans UserCfg.opt (ligne InstalledPackagesPath "…").
function userCfgCandidates(env) {
  const e = env || process.env;
  const out = [];
  if (e.APPDATA) out.push(path.join(e.APPDATA, 'Microsoft Flight Simulator 2024', 'UserCfg.opt')); // Steam
  if (e.LOCALAPPDATA) out.push(path.join(e.LOCALAPPDATA, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt')); // Microsoft Store / Game Pass
  return out;
}
function parseUserCfg(text) {
  const m = /^\s*InstalledPackagesPath\s+"([^"]+)"/m.exec(String(text || ''));
  return m ? m[1] : null;
}
function findCommunity(env) {
  for (const f of userCfgCandidates(env)) {
    try {
      const base = parseUserCfg(fs.readFileSync(f, 'utf8'));
      if (!base) continue;
      const c = path.join(base, 'Community');
      if (fs.existsSync(c)) return c;
    } catch (err) { /* fichier absent : on essaie le suivant */ }
  }
  return null;
}

// ---------- lecture d'un .zip (format standard, sans bibliothèque) ----------
function readZipEntries(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Fichier .zip illisible.');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('Fichier .zip trop gros (format zip64 non pris en charge).');
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOff);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Fichier .zip abîmé.');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    const raw = cd.slice(p + 46, p + 46 + nlen);
    const name = (flags & 0x800) ? raw.toString('utf8') : raw.toString('latin1');
    entries.push({ name: name.replace(/\\/g, '/'), method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}
function safeRel(name) {
  const parts = name.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..') || /^[a-zA-Z]:/.test(parts[0])) return null;
  return parts.join('/');
}
// Décompresse dans dest. Si tout le zip est dans un dossier « folder/ », ce dossier est retiré du chemin.
function extractZip(zipFile, dest, folder, onEntry) {
  const fd = fs.openSync(zipFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const entries = readZipEntries(fd, size);
    const files = entries.filter((e) => !e.name.endsWith('/'));
    const prefix = folder && files.length && files.every((e) => e.name.startsWith(folder + '/')) ? folder + '/' : '';
    let i = 0;
    for (const e of files) {
      const rel = safeRel(e.name.slice(prefix.length));
      if (!rel) continue;
      const hdr = Buffer.alloc(30);
      fs.readSync(fd, hdr, 0, 30, e.local);
      if (hdr.readUInt32LE(0) !== 0x04034b50) throw new Error('Fichier .zip abîmé.');
      const start = e.local + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
      const data = Buffer.alloc(e.csize);
      fs.readSync(fd, data, 0, e.csize, start);
      let out;
      if (e.method === 0) out = data;
      else if (e.method === 8) out = zlib.inflateRawSync(data);
      else throw new Error('Compression du .zip non prise en charge.');
      const target = path.join(dest, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
      if (onEntry) onEntry(++i, files.length);
    }
    return files.length;
  } finally { fs.closeSync(fd); }
}

// ---------- gestionnaire ----------
class Liveries extends EventEmitter {
  constructor(opts) {
    super();
    this.bundled = opts.bundled || [];      // catalogue livré avec le tracker
    this.tmpDir = opts.tmpDir;              // dossier des téléchargements temporaires
    this.getCommunity = opts.getCommunity;  // dossier choisi par le pilote (ou null)
    this.fetch = opts.fetch || ((u, o) => fetch(u, o));
    this.remote = null; this.remoteAt = 0;
    this.jobs = {};                         // id -> { state, percent, error }
    this.perso = opts.perso || null;        // livrées perso ajoutées depuis le PC du pilote
    this.sharedFn = opts.shared || null;    // livrées partagées par la direction (serveur de la compagnie)
    this.shared = []; this.sharedAt = 0;
  }
  community() { return this.getCommunity() || findCommunity(); }
  async catalogue(force) {
    if (force || !this.remote || Date.now() - this.remoteAt > 60 * 60 * 1000) {
      try {
        const r = await this.fetch(CATALOGUE_URL + '?t=' + Date.now(), { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (Array.isArray(j.livrees)) { this.remote = j.livrees; this.remoteAt = Date.now(); }
      } catch (e) { this.remoteAt = Date.now() - 50 * 60 * 1000; } // nouvel essai dans 10 min
    }
    // le catalogue en ligne complète / remplace celui livré avec le tracker
    const byId = new Map(this.bundled.map((l) => [l.id, l]));
    for (const l of this.remote || []) byId.set(l.id, Object.assign({}, byId.get(l.id) || {}, l));
    if (this.sharedFn && (force || Date.now() - this.sharedAt > 10 * 60 * 1000)) {
      this.sharedAt = Date.now();
      try { const r = await this.sharedFn(); if (r && r.ok) this.shared = r.list || []; } catch (e) { /* hors ligne : on garde la dernière liste */ }
    }
    return [...byId.values()].concat(this.shared, this.perso ? this.perso.list() : []);
  }
  installed(l, com) {
    if (!com || !l.folder) return null;
    const dir = path.join(com, l.folder);
    if (!fs.existsSync(dir)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(dir, MARK), 'utf8')); } catch (e) { return { version: null, manual: true }; }
  }
  async list(force) {
    const com = this.community();
    const cat = await this.catalogue(force);
    return {
      community: com,
      communityAuto: !this.getCommunity() && !!com,
      livrees: cat.map((l) => {
        // deux livrées peuvent partager le même dossier (ex. A320 « Oiseau » et « Ruban ») : la marque dit laquelle est installée
        let inst = this.installed(l, com);
        if (inst && inst.id && inst.id !== l.id) inst = null;
        return Object.assign({}, l, {
          installed: !!inst,
          installedVersion: inst ? inst.version : null,
          manual: !!(inst && inst.manual),
          outdated: !!(inst && inst.version && l.version && inst.version !== l.version),
          job: this.jobs[l.id] || null
        });
      })
    };
  }
  setJob(id, j) { this.jobs[id] = j; this.emit('job', { id, job: j }); }
  async install(id) {
    const cat = await this.catalogue(false);
    const l = cat.find((x) => x.id === id);
    if (!l) throw new Error('Livrée introuvable.');
    if (l.perso) return this.installPerso(l);
    if (!l.url && !(l.parts && l.parts.length)) throw new Error('Cette livrée n’est pas encore disponible au téléchargement.');
    const com = this.community();
    if (!com) throw new Error('Dossier Community introuvable : choisis-le avec le bouton « Changer ».');
    if (this.jobs[id] && ['download', 'extract'].includes(this.jobs[id].state)) return;
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const zip = path.join(this.tmpDir, l.id + '.zip');
    const staging = path.join(com, '.' + l.folder + '.installation');
    let out = null;
    try {
      // 1. téléchargement
      // (une livrée partagée par la direction arrive en plusieurs morceaux, recollés dans l'ordre)
      this.setJob(id, { state: 'download', percent: 0 });
      const urls = l.parts && l.parts.length ? l.parts : [l.url];
      let got = 0, last = 0, total = l.size || 0;
      for (const u of urls) {
        const r = await this.fetch(u);
        if (!r.ok || !r.body) throw new Error('Téléchargement impossible (' + r.status + ').');
        if (!out) { out = fs.createWriteStream(zip); out.on('error', () => {}); }
        if (urls.length === 1) total = +r.headers.get('content-length') || total;
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
          const pc = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
          if (pc !== last) { last = pc; this.setJob(id, { state: 'download', percent: pc, got, total }); }
        }
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      if (l.size && got !== l.size) throw new Error('Téléchargement incomplet, réessaie.');
      // 2. décompression à côté, puis remplacement de l'ancienne version d'un coup
      this.setJob(id, { state: 'extract', percent: 0 });
      fs.rmSync(staging, { recursive: true, force: true });
      await new Promise((res) => setImmediate(res));
      extractZip(zip, staging, l.folder, (n, t) => { if (n === t || n % 5 === 0) this.setJob(id, { state: 'extract', percent: Math.floor((n / t) * 100) }); });
      fs.writeFileSync(path.join(staging, MARK), JSON.stringify({ id: l.id, version: l.version || null, at: new Date().toISOString() }, null, 2));
      const dir = path.join(com, l.folder);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
      this.setJob(id, { state: 'done', percent: 100 });
    } catch (e) {
      if (out && !out.closed) { await new Promise((res) => { out.once('close', res); out.destroy(); }); }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (err) { /* rien */ }
      this.setJob(id, { state: 'error', error: String((e && e.message) || e).slice(0, 300) });
    } finally {
      try { fs.unlinkSync(zip); } catch (err) { /* rien */ }
    }
  }
  // livrée perso : copiée depuis le PC du pilote (pas de téléchargement)
  async installPerso(l) {
    const com = this.community();
    if (!com) throw new Error('Dossier Community introuvable : choisis-le avec le bouton « Changer ».');
    this.setJob(l.id, { state: 'extract', percent: 0 });
    await new Promise((res) => setImmediate(res));
    try {
      this.perso.install(this.perso.load().find((x) => x.id === l.id) || l, com, MARK, (n, t) => { if (n === t || n % 5 === 0) this.setJob(l.id, { state: 'extract', percent: Math.floor((n / t) * 100) }); });
      this.setJob(l.id, { state: 'done', percent: 100 });
    } catch (e) { this.setJob(l.id, { state: 'error', error: String((e && e.message) || e).slice(0, 300) }); }
  }
  remove(id, cat) {
    const l = (cat || this.bundled).find((x) => x.id === id);
    const com = this.community();
    if (!l || !com) return false;
    const dir = path.join(com, l.folder);
    // on ne supprime que ce que le tracker a installé lui-même
    if (!fs.existsSync(path.join(dir, MARK))) throw new Error('Cette livrée n’a pas été installée par le tracker : supprime-la toi-même dans le dossier Community.');
    fs.rmSync(dir, { recursive: true, force: true });
    delete this.jobs[id];
    return true;
  }
}

module.exports = { Liveries, findCommunity, parseUserCfg, userCfgCandidates, extractZip, readZipEntries, CATALOGUE_URL, MARK };

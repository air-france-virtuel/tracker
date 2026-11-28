'use strict';
// Livrées perso : une livrée qui se trouve sur le PC du pilote (fichier .zip ou dossier de paquet MSFS),
// ajoutée à SA rubrique Livrées. Le tracker l'installe dans Community, garde son nom et sa photo d'aperçu,
// et elle peut être mise sur un avion de la flotte depuis le Hangar (pour la direction). Rien n'est envoyé en ligne.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'livree';
const typeFrom = (txt) => (/777|B77W|B773/i.test(txt) ? 'B77W' : /A20N|A320|A319|A321|A32\d/i.test(txt) ? 'A320' : '');

function readZipFile(zipFile, entry, readEntries) {
  const fd = fs.openSync(zipFile, 'r');
  try {
    const e = entry;
    const hdr = Buffer.alloc(30);
    fs.readSync(fd, hdr, 0, 30, e.local);
    const start = e.local + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
    const data = Buffer.alloc(e.csize);
    fs.readSync(fd, data, 0, e.csize, start);
    return e.method === 0 ? data : e.method === 8 ? zlib.inflateRawSync(data) : null;
  } finally { fs.closeSync(fd); }
}

// Ce qu'on sait d'un paquet : nom du dossier à créer dans Community, titre, type d'avion, aperçu
function inspectZip(zipFile, readZipEntries) {
  const fd = fs.openSync(zipFile, 'r');
  let entries;
  try { entries = readZipEntries(fd, fs.fstatSync(fd).size); } finally { fs.closeSync(fd); }
  const files = entries.filter((e) => !e.name.endsWith('/'));
  if (!files.length) throw new Error('Le fichier .zip est vide.');
  const tops = new Set(files.map((e) => e.name.split('/')[0]));
  const top = tops.size === 1 && files.every((e) => e.name.includes('/')) ? [...tops][0] : null;
  const find = (re) => files.find((e) => re.test(e.name));
  const man = find(/(^|\/)manifest\.json$/i);
  if (!man) throw new Error('Ce .zip ne contient pas de livrée MSFS (pas de manifest.json).');
  let title = '', creator = '';
  try { const j = JSON.parse(readZipFile(zipFile, man).toString('utf8').replace(/^﻿/, '')); title = j.title || ''; creator = j.creator || ''; } catch (e) { /* manifest illisible */ }
  let cfgTxt = '';
  for (const c of files.filter((e) => /(aircraft|livery)\.cfg$/i.test(e.name)).slice(0, 3)) { try { cfgTxt += readZipFile(zipFile, c).toString('latin1'); } catch (e) { /* rien */ } }
  const thumb = find(/(^|\/)thumbnail\.(jpe?g|png)$/i) || find(/(^|\/)thumbnail_small\.(jpe?g|png)$/i);
  return {
    folder: top || path.basename(zipFile, path.extname(zipFile)),
    prefix: top, title, creator, type: typeFrom(cfgTxt + ' ' + title + ' ' + (top || '')),
    thumb: thumb ? { ext: path.extname(thumb.name).toLowerCase(), data: () => readZipFile(zipFile, thumb) } : null
  };
}
function walk(dir, depth, out) {
  if (depth < 0) return out;
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) walk(p, depth - 1, out); else out.push(p);
  }
  return out;
}
function inspectFolder(dir) {
  // le dossier choisi est le paquet, ou il contient le paquet (un seul sous-dossier avec manifest.json)
  let pkg = dir;
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'manifest.json')));
    if (subs.length !== 1) throw new Error('Ce dossier ne contient pas de livrée MSFS (pas de manifest.json).');
    pkg = path.join(dir, subs[0].name);
  }
  let title = '', creator = '';
  try { const j = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'), 'utf8').replace(/^﻿/, '')); title = j.title || ''; creator = j.creator || ''; } catch (e) { /* rien */ }
  const files = walk(pkg, 6, []);
  let cfgTxt = '';
  for (const c of files.filter((f) => /(aircraft|livery)\.cfg$/i.test(f)).slice(0, 3)) { try { cfgTxt += fs.readFileSync(c, 'latin1'); } catch (e) { /* rien */ } }
  const thumb = files.find((f) => /[\\/]thumbnail\.(jpe?g|png)$/i.test(f)) || files.find((f) => /[\\/]thumbnail_small\.(jpe?g|png)$/i.test(f));
  return { folder: path.basename(pkg), pkg, title, creator, type: typeFrom(cfgTxt + ' ' + title + ' ' + path.basename(pkg)), thumb: thumb ? { ext: path.extname(thumb).toLowerCase(), data: () => fs.readFileSync(thumb) } : null };
}

class Perso {
  constructor(dir, zip) { this.dir = dir; this.zip = zip; this.file = path.join(dir, 'livrees-perso.json'); }
  load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).livrees || []; } catch (e) { return []; } }
  save(list) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ livrees: list }, null, 2)); }
  // entrées au format du catalogue
  list() {
    return this.load().map((l) => Object.assign({}, l, {
      perso: true, url: null,
      image: l.imageFile && fs.existsSync(path.join(this.dir, l.imageFile)) ? pathToFileURL(path.join(this.dir, l.imageFile)).href : '',
      aircraft: l.aircraft || (l.type === 'B77W' ? 'Boeing 777-300ER' : l.type === 'A320' ? 'Airbus A320' : 'Avion'),
      description: 'Livrée perso ajoutée depuis ton PC' + (l.creator ? ' · auteur : ' + l.creator : '') + '.'
    }));
  }
  // ajoute la livrée (zip ou dossier) et renvoie son entrée
  add(src) {
    const st = fs.statSync(src);
    const kind = st.isDirectory() ? 'folder' : /\.zip$/i.test(src) ? 'zip' : null;
    if (!kind) throw new Error('Choisis un fichier .zip ou un dossier de livrée.');
    const info = kind === 'zip' ? inspectZip(src, this.zip.readZipEntries) : inspectFolder(src);
    const list = this.load();
    const id = 'perso-' + slug(info.folder).slice(0, 40);
    const old = list.find((l) => l.id === id);
    let imageFile = old ? old.imageFile : '';
    if (info.thumb) {
      fs.mkdirSync(this.dir, { recursive: true });
      imageFile = 'livree-' + id + info.thumb.ext;
      try { fs.writeFileSync(path.join(this.dir, imageFile), info.thumb.data()); } catch (e) { imageFile = ''; }
    }
    const entry = {
      id, name: info.title || info.folder, type: info.type || (old && old.type) || 'A320', creator: info.creator || '',
      folder: info.folder, source: kind === 'folder' ? info.pkg : src, sourceKind: kind, zipPrefix: info.prefix || null, imageFile,
      version: 'perso', addedAt: new Date().toISOString()
    };
    this.save(list.filter((l) => l.id !== id).concat([entry]));
    return entry;
  }
  setType(id, type) {
    const list = this.load(); const l = list.find((x) => x.id === id);
    if (!l || !['A320', 'B77W', 'AUTRE'].includes(type)) return false;
    l.type = type; this.save(list); return true;
  }
  forget(id) {
    const list = this.load(); const l = list.find((x) => x.id === id);
    if (!l) return false;
    if (l.imageFile) { try { fs.unlinkSync(path.join(this.dir, l.imageFile)); } catch (e) { /* rien */ } }
    this.save(list.filter((x) => x.id !== id)); return true;
  }
  // copie dans Community (dossier « staging » puis remplacement d'un coup, avec la marque du tracker)
  install(l, com, mark, onProgress) {
    if (!fs.existsSync(l.source)) throw new Error('La livrée n’est plus à cet endroit sur ton PC : ' + l.source);
    const staging = path.join(com, '.' + l.folder + '.installation');
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      if (l.sourceKind === 'zip') this.zip.extractZip(l.source, staging, l.zipPrefix, onProgress);
      else fs.cpSync(l.source, staging, { recursive: true });
      fs.writeFileSync(path.join(staging, mark), JSON.stringify({ id: l.id, version: 'perso', at: new Date().toISOString() }, null, 2));
      const dir = path.join(com, l.folder);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
    } catch (e) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (err) { /* rien */ } throw e; }
  }
}

module.exports = { Perso, inspectZip, inspectFolder, typeFrom, slug };

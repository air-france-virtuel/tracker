'use strict';
// Écoute de Max : reconnaissance vocale française hors ligne (modèle Whisper « small », licence MIT,
// exporté par le projet sherpa-onnx). Le modèle est téléchargé une seule fois dans le dossier de l'utilisateur.
// La reconnaissance tourne dans un processus à part : elle ne bloque pas le tracker et ses bibliothèques
// ne se mélangent pas avec celles de la voix de Max.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const ARCHIVE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2';
const ARCHIVE_SIZE = 639387718;
// Seuls ces fichiers sont gardés (version allégée « int8 ») : environ 375 Mo sur le disque.
const FILES = {
  'small-encoder.int8.onnx': { size: 112442483, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
  'small-decoder.int8.onnx': { size: 262226114, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
  'small-tokens.txt': { size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' }
};

// Extrait les fichiers voulus d'une archive .tar.bz2 lue en flux (rien d'autre n'est écrit sur le disque).
async function extract(input, dir, onBytes, files) {
  files = files || FILES;
  const bz2 = require('unbzip2-stream');
  const tar = require('tar-stream');
  const ex = tar.extract();
  const found = {};
  const done = new Promise((resolve, reject) => {
    ex.on('entry', (h, stream, next) => {
      const name = path.basename(h.name);
      const want = files[name];
      if (!want || h.type !== 'file') { stream.on('end', next); stream.resume(); return; }
      const hash = crypto.createHash('sha256');
      const part = path.join(dir, name + '.part');
      const out = fs.createWriteStream(part);
      let n = 0;
      stream.on('data', (c) => { hash.update(c); n += c.length; });
      stream.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        if (n !== want.size || hash.digest('hex') !== want.sha256) { reject(new Error('Fichier d’écoute incomplet ou modifié. Réessaie.')); return; }
        found[name] = part;
        next();
      });
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
  });
  const src = input.on ? input : Readable.from(input);
  if (onBytes) src.on('data', (c) => onBytes(c.length));
  const unz = bz2();
  unz.on('error', (e) => ex.destroy(e));
  src.on('error', (e) => ex.destroy(e));
  src.pipe(unz).pipe(ex);
  await done;
  for (const name of Object.keys(files)) if (!found[name]) throw new Error('Archive d’écoute incomplète. Réessaie.');
  for (const name of Object.keys(found)) fs.renameSync(found[name], path.join(dir, name));
}

class MaxEcoute extends EventEmitter {
  constructor(dir, workerPath) {
    super();
    this.dir = dir;
    this.workerPath = workerPath || path.join(__dirname, 'ecoute-worker.js');
    this.downloading = null;
    this.worker = null;
    this.jobs = new Map();
    this.nextId = 1;
    this.state = { installed: this.isInstalled(), downloading: false, percent: 0, error: '' };
  }
  isInstalled() { return Object.keys(FILES).every((f) => fs.existsSync(path.join(this.dir, f))); }
  status() { this.state.installed = this.isInstalled(); return Object.assign({ sizeMb: Math.round(ARCHIVE_SIZE / 1e6) }, this.state); }

  async download(url) {
    if (this.status().installed) return this.status();
    if (this.downloading) return this.downloading;
    this.downloading = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      Object.assign(this.state, { downloading: true, percent: 0, error: '' });
      this.emit('status', this.status());
      try {
        const r = await fetch(url || ARCHIVE_URL);
        if (!r.ok || !r.body) throw new Error('Téléchargement refusé (' + r.status + ').');
        const total = +r.headers.get('content-length') || ARCHIVE_SIZE;
        let got = 0; let last = -1;
        await extract(Readable.fromWeb(r.body), this.dir, (n) => {
          got += n;
          const pct = Math.min(99, Math.floor((got / total) * 100));
          if (pct !== last) { last = pct; this.state.percent = pct; this.emit('status', this.status()); }
        });
        Object.assign(this.state, { downloading: false, percent: 100 });
      } catch (e) {
        for (const f of Object.keys(FILES)) { try { fs.unlinkSync(path.join(this.dir, f + '.part')); } catch (x) { /* rien */ } }
        Object.assign(this.state, { downloading: false, percent: 0, error: String((e && e.message) || e) });
      } finally {
        this.downloading = null;
        this.emit('status', this.status());
      }
      return this.status();
    })();
    return this.downloading;
  }

  remove() {
    this.stop();
    for (const f of Object.keys(FILES)) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* déjà supprimé */ } }
    this.state.percent = 0;
    return this.status();
  }

  // Processus de reconnaissance : démarré au premier besoin, gardé ouvert ensuite (le modèle reste chargé).
  start() {
    if (this.worker) return this.worker;
    let w;
    try {
      const { utilityProcess } = require('electron');
      w = utilityProcess.fork(this.workerPath, [this.dir], { serviceName: 'Écoute de Max' });
      w.send = w.postMessage.bind(w);
    } catch (e) {
      w = require('child_process').fork(this.workerPath, [this.dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    }
    w.on('message', (m) => {
      const j = m && this.jobs.get(m.id);
      if (!j) return;
      this.jobs.delete(m.id);
      if (m.error) j.reject(new Error(m.error)); else j.resolve(m.text || '');
    });
    w.on('exit', () => {
      if (this.worker === w) this.worker = null;
      for (const j of this.jobs.values()) j.reject(new Error('L’écoute de Max s’est arrêtée. Réessaie.'));
      this.jobs.clear();
    });
    this.worker = w;
    return w;
  }
  // Charge le modèle pendant que le pilote parle, pour répondre plus vite.
  warm() { if (this.isInstalled()) this.start().send({ warm: true }); }
  stop() { if (this.worker) { try { this.worker.kill(); } catch (e) { /* rien */ } this.worker = null; } }

  // samples : Float32Array (ou tableau) de son mono à 16 kHz. Renvoie le texte entendu.
  recognize(samples, sampleRate) {
    if (!this.isInstalled()) return Promise.reject(new Error('L’écoute de Max n’est pas installée.'));
    const a = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    if (a.length < 1600) return Promise.resolve('');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.start().send({ id, samples: Array.from(a), sampleRate: sampleRate || 16000 });
    });
  }
}

module.exports = { MaxEcoute, extract, FILES, ARCHIVE_URL };

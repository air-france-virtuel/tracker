'use strict';
// Voix de Max : synthèse vocale française hors ligne (modèle Kokoro, licence Apache 2.0).
// - phonèmes : espeak-ng (WebAssembly, français)
// - audio : modèle ONNX exécuté avec onnxruntime-node
// Le modèle (environ 325 Mo) est téléchargé une seule fois dans le dossier de l'utilisateur.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx';
const MODEL_SIZE = 325532387;
const MODEL_SHA256 = '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5';
const SAMPLE_RATE = 24000;
const IDLE_MS = 3 * 60000;

// Réglage « Max dynamique 1 » choisi par le pilote : voix française Siwis, plus grave et plus vive.
// L'audio est joué à 0,82× (hauteur plus grave) ; on le génère donc plus vite pour garder du rythme.
const VOICE = { speed: 1.3, playbackRate: 0.82 };

const DATA = path.join(__dirname, 'voix-max');
const VOCAB = JSON.parse(fs.readFileSync(path.join(DATA, 'vocab.json'), 'utf8'));

// ---------- texte → phrase prononçable ----------
const DIGITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const spellDigits = (s) => s.split('').map((d) => DIGITS[+d]).join(' ');
function speakable(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\bFL\s?(\d{2,3})\b/g, (_m, n) => 'niveau ' + spellDigits(n))
    .replace(/\b(?:piste|RWY)\s+(\d{2})([LRC]?)\b/gi, (_m, n, s) => 'piste ' + spellDigits(n) + (s ? { L: ' gauche', R: ' droite', C: ' centre' }[s.toUpperCase()] : ''))
    .replace(/(\d)\s?ft\/min\b/g, '$1 pieds par minute')
    .replace(/(\d)\s?ft\b/g, '$1 pieds')
    .replace(/(\d)\s?kt\b/g, '$1 nœuds')
    .replace(/(\d)\s?NM\b/g, '$1 nautiques')
    .replace(/(\d)\s?°/g, '$1 degrés')
    .replace(/(\d)\s?%/g, '$1 pour cent')
    .replace(/(\d)\s(?=\d{3}\b)/g, '$1') // 10 000 → 10000
    .replace(/\bFMS\b/g, 'F M S')
    .replace(/\bTOD\b/g, 'tode') // « tod » en un seul mot, pas T-O-D
    .replace(/[→·•]/g, ',')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- phonèmes (espeak-ng, comme kokoro-onnx) ----------
let espeakFactory = null;
async function phonemize(text) {
  if (!espeakFactory) espeakFactory = (await import('espeak-ng')).default;
  const parts = text.split(/(\s*[.,;:!?…«»"“”()]+\s*)/);
  const chunks = [];
  for (let i = 0; i < parts.length; i += 2) chunks.push(parts[i].trim());
  const todo = chunks.filter(Boolean);
  if (!todo.length) return '';
  const e = await espeakFactory({
    arguments: ['--phonout', 'out.txt', '-q', '-b', '1', '--ipa=3', '-v', 'fr', '-f', 'in.txt'],
    preRun: [(m) => m.FS.writeFile('in.txt', todo.join('.\n') + '.\n')],
    print: () => {}, printErr: () => {}
  });
  const lines = e.FS.readFile('out.txt', { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
  let li = 0;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { out += parts[i].replace(/\s+/g, ' '); continue; }
    if (parts[i].trim()) out += lines[li++] || '';
  }
  out = out.replace(/\([‍]?[a-z‍-]+\)/gi, '');
  return [...out].filter((c) => c in VOCAB).join('').replace(/\s+/g, ' ').trim();
}

// ---------- moteur ----------
class MaxVoice extends EventEmitter {
  constructor(dir, opts) {
    super();
    this.dir = dir;
    this.voice = Object.assign({}, VOICE, opts || {});
    this.modelPath = path.join(dir, 'kokoro-v1.0.onnx');
    this.session = null;
    this.ort = null;
    this.style = null;
    this.downloading = null;
    this.state = { installed: fs.existsSync(this.modelPath), downloading: false, percent: 0, error: '' };
  }

  status() { return Object.assign({}, this.state, { installed: fs.existsSync(this.modelPath), sizeMb: Math.round(MODEL_SIZE / 1e6) }); }

  async download() {
    if (this.status().installed) return this.status();
    if (this.downloading) return this.downloading;
    this.downloading = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      const part = this.modelPath + '.part';
      Object.assign(this.state, { downloading: true, percent: 0, error: '' });
      this.emit('status', this.status());
      try {
        const r = await fetch(MODEL_URL);
        if (!r.ok || !r.body) throw new Error('Téléchargement refusé (' + r.status + ').');
        const total = +r.headers.get('content-length') || MODEL_SIZE;
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(part);
        let got = 0; let lastPct = -1;
        for await (const chunk of r.body) {
          hash.update(chunk);
          got += chunk.length;
          if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct) { lastPct = pct; this.state.percent = pct; this.emit('status', this.status()); }
        }
        await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
        if (hash.digest('hex') !== MODEL_SHA256) throw new Error('Fichier de voix incomplet ou modifié. Réessaie.');
        fs.renameSync(part, this.modelPath);
        Object.assign(this.state, { downloading: false, percent: 100 });
      } catch (e) {
        try { fs.unlinkSync(part); } catch (x) { /* rien */ }
        Object.assign(this.state, { downloading: false, percent: 0, error: String((e && e.message) || e) });
      } finally {
        this.downloading = null;
        this.emit('status', this.status());
      }
      return this.status();
    })();
    return this.downloading;
  }

  // Quand Max ne parle plus depuis quelques minutes (croisière), le modèle est retiré de la mémoire.
  // Il revient tout seul à la phrase suivante (une à deux secondes de plus).
  keepAlive() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.unload(), IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }
  unload() {
    clearTimeout(this.idleTimer);
    const s = this.session; this.session = null;
    if (s && s.release) s.release().catch(() => {});
  }

  remove() {
    this.unload();
    try { fs.unlinkSync(this.modelPath); } catch (e) { /* déjà supprimé */ }
    this.state.percent = 0;
    return this.status();
  }

  async load() {
    if (this.session) return;
    if (!fs.existsSync(this.modelPath)) throw new Error('La voix de Max n’est pas installée.');
    this.ort = require('onnxruntime-node');
    // Sans réserve mémoire d'onnxruntime : environ 160 Mo de moins, même voix.
    this.session = await this.ort.InferenceSession.create(this.modelPath, { graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false });
    const buf = fs.readFileSync(path.join(DATA, 'max-style.bin'));
    this.style = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); // 510 × 256
    this.keepAlive();
  }

  // Renvoie l'audio (Float32, 24 kHz) et la vitesse de lecture à appliquer.
  async speak(text) {
    await this.load();
    this.keepAlive();
    const session = this.session;
    const phon = await phonemize(speakable(text));
    if (!phon) return null;
    const ids = [...phon].map((c) => VOCAB[c]).filter((x) => x != null).slice(0, 510);
    const n = ids.length;
    const tokens = BigInt64Array.from([0, ...ids, 0].map(BigInt));
    const row = Math.min(n, 510) - 1;
    const style = this.style.slice(row * 256, row * 256 + 256);
    const ort = this.ort;
    const res = await session.run({
      tokens: new ort.Tensor('int64', tokens, [1, tokens.length]),
      style: new ort.Tensor('float32', style, [1, 256]),
      speed: new ort.Tensor('float32', Float32Array.from([this.voice.speed]), [1])
    });
    const audio = res[session.outputNames[0]].data;
    return { sampleRate: SAMPLE_RATE, playbackRate: this.voice.playbackRate, samples: trim(audio) };
  }
}

// Retire le silence au début et à la fin.
function trim(a) {
  const th = 0.01;
  let s = 0; let e = a.length - 1;
  while (s < e && Math.abs(a[s]) < th) s++;
  while (e > s && Math.abs(a[e]) < th) e--;
  s = Math.max(0, s - 480); e = Math.min(a.length, e + 2400);
  return Float32Array.from(a.subarray(s, e));
}

module.exports = { MaxVoice, speakable, phonemize };

'use strict';
// Processus d'écoute de Max : charge le modèle Whisper une fois puis transcrit chaque phrase reçue.
const path = require('path');
const dir = process.argv[2];
let rec = null;
let sherpa = null;
function load() {
  if (rec) return rec;
  sherpa = require('sherpa-onnx-node');
  const f = (n) => path.join(dir, n);
  rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: f('small-encoder.int8.onnx'), decoder: f('small-decoder.int8.onnx'), language: 'fr', task: 'transcribe', tailPaddings: -1 },
      tokens: f('small-tokens.txt'),
      numThreads: 4,
      provider: 'cpu'
    }
  });
  return rec;
}
function handle(m, reply) {
  if (m && m.warm) { try { load(); } catch (e) { /* signalé à la première phrase */ } return; }
  if (!m || !m.id) return;
  try {
    const r = load();
    const st = r.createStream();
    st.acceptWaveform({ samples: Float32Array.from(m.samples || []), sampleRate: m.sampleRate || 16000 });
    r.decode(st);
    reply({ id: m.id, text: String(r.getResult(st).text || '').trim() });
  } catch (e) {
    reply({ id: m.id, error: String((e && e.message) || e) });
  }
}
if (process.parentPort) process.parentPort.on('message', (e) => handle(e.data, (x) => process.parentPort.postMessage(x)));
else process.on('message', (m) => handle(m, (x) => process.send(x)));

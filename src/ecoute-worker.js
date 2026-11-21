'use strict';
// Processus d'écoute de Max : charge le modèle Whisper une fois puis transcrit chaque phrase reçue.
const path = require('path');
const { serve } = require('./proc');
const dir = process.argv[2];
let rec = null;
function load() {
  if (rec) return rec;
  const sherpa = require('sherpa-onnx-node');
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
serve((m) => {
  if (m.warm) { load(); return true; }
  const r = load();
  const st = r.createStream();
  st.acceptWaveform({ samples: Float32Array.from(m.samples || []), sampleRate: m.sampleRate || 16000 });
  r.decode(st);
  return String(r.getResult(st).text || '').trim();
});

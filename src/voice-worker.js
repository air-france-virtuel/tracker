'use strict';
// Processus de la voix de Max : modèle Kokoro et phonèmes chargés ici, hors du tracker.
const { serve } = require('./proc');
const { MaxVoice } = require('./voice');
const voice = new MaxVoice(process.argv[2]);
voice.keepAlive = () => {}; // c'est le tracker qui ferme ce processus quand Max se tait
serve(async (m) => {
  if (m.warm) { await voice.load(); return true; }
  const r = await voice.speak(m.text);
  return r ? { sampleRate: r.sampleRate, playbackRate: r.playbackRate, samples: Array.from(r.samples) } : null;
});

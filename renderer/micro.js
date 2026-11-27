'use strict';
// Micro de Max : enregistre une phrase (son mono 16 kHz) et s'arrête tout seul quand le pilote se tait.
// La transcription se fait ensuite sur le PC (afv.ecouteText), sans rien envoyer sur Internet.
(function (root) {
  const RATE = 16000;
  // Décide quand arrêter l'écoute, d'après le volume de chaque morceau de son.
  // Renvoie 'continue', 'done' (phrase finie) ou 'nothing' (rien entendu).
  function makeVad(opts) {
    const o = Object.assign({ minLevel: 0.012, silenceMs: 1200, maxMs: 12000, waitMs: 5000 }, opts || {});
    let t = 0; let floor = null; let speech = false; let quietFor = 0;
    const step = function (rms, ms) {
      t += ms;
      if (t <= 300) { floor = floor == null ? rms : Math.min(floor, rms); return 'continue'; }
      const th = Math.max(o.minLevel, (floor || 0) * 3);
      if (rms > th) { speech = true; quietFor = 0; } else if (speech) quietFor += ms;
      if (speech && quietFor >= o.silenceMs) return 'done';
      if (t >= o.maxMs) return speech ? 'done' : 'nothing';
      if (!speech && t >= o.waitMs) return 'nothing';
      return 'continue';
    };
    step.heard = () => speech;
    return step;
  }

  // Lance une écoute. onEnd(samples|null) est appelé une seule fois. Renvoie { stop() } (stop garde ce qui a été dit).
  async function listen(onEnd) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext({ sampleRate: RATE });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const chunks = []; let ended = false;
    const vad = makeVad();
    const finish = (keep, force) => {
      if (ended) return; ended = true;
      try { proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (e) { /* déjà fait */ }
      stream.getTracks().forEach((tr) => tr.stop());
      const rate = ctx.sampleRate;
      ctx.close().catch(() => {});
      if (!keep || (!force && !vad.heard())) { onEnd(null, rate); return; }
      const n = chunks.reduce((a, c) => a + c.length, 0);
      const all = new Float32Array(n); let i = 0;
      for (const c of chunks) { all.set(c, i); i += c.length; }
      onEnd(all, rate);
    };
    proc.onaudioprocess = (e) => {
      if (ended) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      chunks.push(d);
      let s = 0; for (let k = 0; k < d.length; k++) s += d[k] * d[k];
      const r = vad(Math.sqrt(s / d.length), (d.length / ctx.sampleRate) * 1000);
      if (r === 'done') finish(true); else if (r === 'nothing') finish(false);
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    return { stop: () => finish(true, true), cancel: () => finish(false) };
  }

  const api = { RATE, makeVad, listen };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Micro = api;
})(typeof window !== 'undefined' ? window : this);

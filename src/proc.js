'use strict';
// Petit processus de travail (voix, écoute) : démarré au premier besoin, fermé après un temps sans servir.
// Fermer le processus rend toute sa mémoire à Windows, ce qu'un simple « déchargement » ne garantit pas.
class Proc {
  constructor(script, args, idleMs, name) {
    this.script = script; this.args = args || []; this.idleMs = idleMs; this.name = name || 'Tracker';
    this.w = null; this.jobs = new Map(); this.nextId = 1; this.timer = null;
  }
  start() {
    if (this.w) return this.w;
    let w;
    try {
      const { utilityProcess } = require('electron');
      w = utilityProcess.fork(this.script, this.args, { serviceName: this.name });
      w.send = w.postMessage.bind(w);
    } catch (e) {
      w = require('child_process').fork(this.script, this.args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    }
    w.on('message', (m) => {
      const j = m && this.jobs.get(m.id);
      if (!j) return;
      this.jobs.delete(m.id);
      if (m.error) j.reject(new Error(m.error)); else j.resolve(m.result);
    });
    w.on('exit', () => {
      if (this.w === w) this.w = null;
      for (const j of this.jobs.values()) j.reject(new Error(this.name + ' s’est arrêté. Réessaie.'));
      this.jobs.clear();
    });
    this.w = w;
    return w;
  }
  keepAlive() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.jobs.size) this.stop(); else this.keepAlive(); }, this.idleMs);
    if (this.timer.unref) this.timer.unref();
  }
  // Envoie un message sans attendre de réponse (ex. préchargement).
  post(msg) { this.start().send(msg); this.keepAlive(); }
  call(msg) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.start().send(Object.assign({ id }, msg));
      this.keepAlive();
    });
  }
  running() { return !!this.w; }
  stop() { clearTimeout(this.timer); if (this.w) { try { this.w.kill(); } catch (e) { /* déjà fermé */ } this.w = null; } }
}
// Côté processus de travail : branche un gestionnaire handle(msg) → résultat (ou promesse).
function serve(handle) {
  const run = async (m, reply) => {
    if (!m) return;
    try { const result = await handle(m); if (m.id) reply({ id: m.id, result }); } catch (e) { if (m.id) reply({ id: m.id, error: String((e && e.message) || e) }); }
  };
  if (process.parentPort) process.parentPort.on('message', (e) => run(e.data, (x) => process.parentPort.postMessage(x)));
  else process.on('message', (m) => run(m, (x) => process.send(x)));
}
module.exports = { Proc, serve };

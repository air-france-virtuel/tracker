'use strict';
// Pilotes en vol : chaque tracker annonce la position de son vol en cours aux autres pilotes de la compagnie
// (présence Supabase « temps réel », rien n'est enregistré sur le serveur : quand le vol s'arrête, il disparaît).
// Le nom affiché vient de la table des pilotes (nom de pilote du tracker), jamais de ce qu'envoie le tracker.
const { EventEmitter } = require('events');

const CHANNEL = 'vols-lat';
const EVERY = 10000;          // une position toutes les 10 s au plus
const STALE = 3 * 60 * 1000;  // sans nouvelle depuis 3 min : on ne l'affiche plus

const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, n);
const num = (v, min, max) => { const x = +v; return Number.isFinite(x) && x >= min && x <= max ? x : null; };

// Ce qu'on accepte d'un autre tracker (tout est vérifié : un tracker modifié ne peut pas casser l'affichage)
function cleanEntry(x) {
  if (!x || typeof x.id !== 'string') return null;
  const lat = num(x.lat, -90, 90), lon = num(x.lon, -180, 180);
  if (lat == null || lon == null) return null;
  return {
    id: s(x.id, 64), cs: s(x.cs, 12), from: s(x.from, 4).toUpperCase(), to: s(x.to, 4).toUpperCase(),
    ac: s(x.ac, 8), reg: s(x.reg, 10), lat, lon,
    alt: num(x.alt, -2000, 60000), gs: num(x.gs, 0, 2000), hdg: num(x.hdg, 0, 360), ph: num(x.ph, 0, 8),
    at: num(x.at, 0, 1e14) || Date.now()
  };
}

class Live extends EventEmitter {
  constructor(chat) {
    super();
    this.chat = chat;           // module du chat : compte du pilote et accès au serveur
    this.ch = null; this.ready = false; this.starting = null;
    this.mine = null; this.lastTrack = 0;
    this.list = []; this.error = '';
    this.share = true;
  }

  async start() {
    if (this.ready || this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const me = await this.chat.session();
        const sb = this.chat.sb;
        const old = typeof sb.getChannels === 'function' ? sb.getChannels().filter((c) => (c.topic || '').endsWith(CHANNEL)) : [];
        for (const c of old) { try { await sb.removeChannel(c); } catch (e) { /* déjà fermé */ } }
        const ch = sb.channel(CHANNEL, { config: { presence: { key: me.id } } });
        ch.on('presence', { event: 'sync' }, () => this.sync());
        ch.subscribe((st) => {
          if (st === 'SUBSCRIBED') { this.ready = true; this.error = ''; this.lastTrack = 0; this.push(true); this.sync(); }
          else if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && this.ch === ch) {
            this.ready = false; this.error = 'Connexion perdue, nouvelle tentative…'; this.emitList();
            clearTimeout(this.retry); this.retry = setTimeout(() => { this.ch = null; this.start(); }, 15000);
          }
        });
        this.ch = ch;
      } catch (e) {
        this.error = String((e && e.message) || e).slice(0, 200); this.emitList();
        clearTimeout(this.retry); this.retry = setTimeout(() => this.start(), 60000);
      } finally { this.starting = null; }
    })();
    return this.starting;
  }

  // Position de mon vol (ou null quand je ne vole pas / que je ne veux pas être vu)
  update(entry) {
    this.mine = this.share && entry ? entry : null;
    this.push(false);
  }
  setShare(on) { this.share = on !== false; if (!this.share) { this.mine = null; this.push(true); } }

  push(force) {
    if (!this.ch || !this.ready) return;
    const now = Date.now();
    if (!this.mine) {
      if (this.tracked) { this.tracked = false; this.ch.untrack().catch(() => {}); }
      return;
    }
    if (!force && now - this.lastTrack < EVERY) return;
    this.lastTrack = now; this.tracked = true;
    this.ch.track(Object.assign({}, this.mine, { id: this.chat.me.id, at: now })).catch(() => {});
  }

  async sync() {
    if (!this.ch) return;
    const st = this.ch.presenceState();
    const raw = Object.values(st).map((arr) => cleanEntry(arr[arr.length - 1])).filter(Boolean)
      .filter((x) => Date.now() - x.at < STALE);
    // noms : table des pilotes du serveur (cache partagé avec le chat)
    const cache = this.chat.pilotCache = this.chat.pilotCache || new Map();
    const missing = [...new Set(raw.map((x) => x.id))].filter((id) => !cache.has(id) || Date.now() - cache.get(id).at > 5 * 60 * 1000);
    if (missing.length) {
      try {
        const r = await this.chat.sb.from('pilots').select('id,pseudo,grade,is_admin,banned').in('id', missing.slice(0, 200));
        if (!r.error) for (const p of r.data) cache.set(p.id, { at: Date.now(), p });
      } catch (e) { /* réessai au prochain passage */ }
    }
    const me = this.chat.me && this.chat.me.id;
    this.list = raw.map((x) => { const c = cache.get(x.id); return c && !c.p.banned ? Object.assign(x, { pseudo: c.p.pseudo, grade: c.p.grade || '', mine: x.id === me }) : null; })
      .filter(Boolean).sort((a, b) => (b.mine - a.mine) || a.pseudo.localeCompare(b.pseudo));
    this.emitList();
  }

  emitList() { this.emit('list', { list: this.list, error: this.error, ready: this.ready, share: this.share }); }
  status() { return { list: this.list, error: this.error, ready: this.ready, share: this.share }; }
}

module.exports = { Live, cleanEntry, CHANNEL, EVERY };

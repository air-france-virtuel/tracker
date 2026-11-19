'use strict';
// Discord Rich Presence : « Joue à Air France Virtuel » avec le vol en cours, sur le profil du pilote.
// Discord (appli de bureau) écoute sur un tuyau local ; on lui parle avec son protocole IPC, sans module externe.
// Trame : opcode (uint32 LE) + longueur (uint32 LE) + JSON. 0 = poignée de main, 1 = commande, 2 = fin.
const net = require('net');
const path = require('path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function pipePath(i) {
  if (process.platform === 'win32') return '\\\\?\\pipe\\discord-ipc-' + i;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return path.join(base, 'discord-ipc-' + i);
}

function encode(op, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(8);
  h.writeUInt32LE(op, 0); h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}

// Découpe le flux reçu en trames complètes.
function decoder(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) break;
      const op = buf.readUInt32LE(0);
      let data = null;
      try { data = JSON.parse(buf.slice(8, 8 + len).toString('utf8')); } catch (e) { /* trame illisible */ }
      buf = buf.slice(8 + len);
      onFrame(op, data);
    }
  };
}

const cut = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

class DiscordPresence {
  constructor(opts) {
    this.clientId = '';
    this.sock = null;
    this.ready = false;
    this.enabled = false;
    this.activity = null;
    this.retry = null;
    this.nonce = 0;
    this.log = (opts && opts.log) || (() => {});
  }

  // clientId : identifiant de l'application créée sur discord.com/developers
  configure(clientId, enabled) {
    const id = /^\d{15,22}$/.test(String(clientId || '')) ? String(clientId) : '';
    const changed = id !== this.clientId;
    this.clientId = id;
    this.enabled = !!enabled && !!id;
    if (!this.enabled) { this.stop(); return; }
    if (changed) this.stop(true);
    if (!this.sock) this.connect(0);
  }

  connect(i) {
    clearTimeout(this.retry); this.retry = null;
    if (!this.enabled || this.sock) return;
    if (i > 9) { this.retry = setTimeout(() => this.connect(0), 30000); return; } // Discord fermé : nouvel essai dans 30 s
    const s = net.createConnection(pipePath(i));
    let opened = false;
    s.once('connect', () => {
      opened = true; this.sock = s;
      s.on('data', decoder((op, d) => this.onFrame(op, d)));
      s.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
    s.on('error', () => { if (!opened) this.connect(i + 1); });
    s.on('close', () => {
      if (!opened) return;
      this.sock = null; this.ready = false;
      if (this.enabled) this.retry = setTimeout(() => this.connect(0), 15000);
    });
  }

  onFrame(op, d) {
    if (op === OP.PING) { if (this.sock) this.sock.write(encode(OP.PONG, d || {})); return; }
    if (op === OP.CLOSE) { this.log('Discord a refusé la connexion : ' + ((d && d.message) || '')); if (this.sock) this.sock.destroy(); return; }
    if (d && d.evt === 'READY') { this.ready = true; this.push(); }
    else if (d && d.evt === 'ERROR') this.log('Discord : ' + ((d.data && d.data.message) || 'erreur'));
  }

  push() {
    if (!this.ready || !this.sock) return;
    this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.activity || undefined }, nonce: String(++this.nonce) }));
  }

  set(activity) { this.activity = activity; this.push(); }

  stop(keepEnabled) {
    clearTimeout(this.retry); this.retry = null;
    if (this.sock) {
      try { if (this.ready) this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: String(++this.nonce) })); } catch (e) { /* rien */ }
      try { this.sock.end(); } catch (e) { /* rien */ }
    }
    this.sock = null; this.ready = false;
    if (!keepEnabled) this.enabled = false;
  }
}

// Construit le statut affiché sur Discord à partir de l'état du tracker.
// st : { flying, callsign, route, phase, alt, aircraft, startedAt, grade }
function buildActivity(st, cfg) {
  cfg = cfg || {};
  const a = { assets: { large_image: cfg.largeImage || 'afv', large_text: 'Air France Virtuel · Tracker' }, instance: false };
  if (st && st.flying) {
    // « Vol AFR123 · LFPG → LFMN » puis « Croisière · FL350 · reste 1 h 12 » ; Discord ajoute le temps de vol (chrono)
    a.details = cut('Vol ' + ([st.callsign, st.route].filter(Boolean).join(' · ') || 'libre'), 128);
    a.state = cut([st.phase, st.alt, st.remaining].filter(Boolean).join(' · ') || 'En vol', 128);
    a.assets.large_text = 'Vol pour Air France Virtuel';
    if (st.startedAt) a.timestamps = { start: Math.floor(st.startedAt) };
    if (cfg.smallImage) { a.assets.small_image = cfg.smallImage; a.assets.small_text = cut(st.phase || 'En vol', 128); }
  } else {
    a.details = 'Prépare son prochain vol';
    a.state = cut(st && st.grade ? st.grade : 'Au sol', 128);
  }
  const btn = (cfg.buttons || []).filter((b) => b && b.label && /^https:\/\//.test(b.url)).slice(0, 2).map((b) => ({ label: cut(b.label, 32), url: b.url }));
  if (btn.length) a.buttons = btn;
  return a;
}

module.exports = { DiscordPresence, buildActivity, encode, decoder, pipePath };

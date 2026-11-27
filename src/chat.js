'use strict';
// Chat des pilotes : Supabase (base de données + temps réel), compte anonyme par installation du tracker.
// Toute la sécurité (bannis, anti-spam, nom affiché, droits admin) est vérifiée par le serveur (supabase/chat.sql).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_LEN = 500;
const HISTORY = 100;

// Garde la session du pilote dans son dossier de données (comme un « se souvenir de moi »).
function fileStorage(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* première fois */ }
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* rien */ } };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; save(); },
    removeItem: (k) => { delete data[k]; save(); }
  };
}

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, n);
const friendly = (e) => {
  const m = String((e && (e.message || e.error_description || e.msg)) || e || '');
  if (/anonymous sign-ins are disabled/i.test(m)) return 'La connexion au chat n’est pas encore activée par la direction.';
  if (/fetch failed|network|ENOTFOUND|ECONN|timeout/i.test(m)) return 'Pas de connexion au chat. Vérifie ta connexion internet.';
  if (/rate limit/i.test(m)) return 'Trop de connexions au chat en peu de temps. Réessaie dans quelques minutes.';
  return m.slice(0, 200) || 'Erreur inconnue.';
};

const friendlyFleet = (e) => {
  const m = String((e && (e.message || e.error_description || e.msg)) || e || '');
  if (/AVION_PRIS/.test(m)) return 'Trop tard : un autre pilote vient de prendre cet avion.';
  if (/AVION_CLOUE/.test(m)) return 'Cet avion est cloué au sol (état sous 60 %) : il attend sa remise en état.';
  if (/AVION_RETIRE/.test(m)) return 'Cet avion a été retiré de la flotte par la direction.';
  if (/AVION_PAS_A_TOI/.test(m)) return 'Tu n’avais pas pris cet avion : le vol n’est pas compté dans son carnet.';
  if (/DIRECTION_SEULEMENT/.test(m)) return 'Réservé à la direction.';
  if (/aircraft_state|aircraft_log|finish_flight|hangar_admin/.test(m)) return 'Le hangar n’est pas encore activé sur le serveur.';
  if (/AVION_MAINTENANCE/.test(m)) return 'Cet avion est en maintenance au hangar : réessaie quand elle sera terminée.';
  if (/PILOTE_INCONNU/.test(m)) return 'Ton compte pilote n’est pas reconnu par le serveur.';
  if (/aircraft_bookings|take_aircraft|release_aircraft|does not exist|schema cache/i.test(m)) return 'La réservation des avions n’est pas encore activée par la direction.';
  return friendly(e);
};

class Chat extends EventEmitter {
  constructor(dir, opts) {
    super();
    this.dir = dir;
    this.createClient = (opts && opts.createClient) || require('@supabase/supabase-js').createClient;
    this.cfg = null; this.sb = null; this.channel = null;
    this.state = 'off'; this.error = '';
    this.me = null; // { id, pseudo, grade, admin, banned }
    this.profile = { pseudo: '', grade: '', flight: '' };
    this.messages = []; this.online = [];
    this.starting = null;
  }

  status() { return { state: this.state, error: this.error, me: this.me, online: this.online, configured: !!(this.cfg && this.cfg.url && this.cfg.key) }; }
  emitStatus() { this.emit('status', this.status()); }
  setState(s, err) { this.state = s; this.error = err || ''; this.emitStatus(); }

  configure(cfg) {
    const ok = cfg && /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(cfg.url || '') && typeof cfg.key === 'string' && cfg.key.length > 20;
    const same = this.cfg && ok && this.cfg.url === cfg.url && this.cfg.key === cfg.key;
    if (same) return;
    this.stop();
    this.cfg = ok ? { url: cfg.url.replace(/\/$/, ''), key: cfg.key } : null;
    this.setState(this.cfg ? 'idle' : 'off');
  }

  // Nom de pilote, grade et vol en cours (affichés dans le chat).
  setProfile(p) {
    const n = { pseudo: clean(p.pseudo, 32), grade: clean(p.grade, 40), flight: clean(p.flight, 60) };
    const changedId = n.pseudo !== this.profile.pseudo || n.grade !== this.profile.grade;
    const changedFlight = n.flight !== this.profile.flight;
    this.profile = n;
    if (this.me && changedId && n.pseudo.length >= 2) this.saveProfile().then(() => this.refreshOnline()).catch(() => {});
    if (this.channel && (changedId || changedFlight)) this.track();
  }

  async start() {
    if (!this.cfg) { this.setState('off'); return this.status(); }
    if (this.profile.pseudo.length < 2) { this.setState('nopseudo'); return this.status(); }
    if (this.state === 'ready') return this.status();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        this.setState('connecting');
        await this.session();
        await this.loadHistory();
        await this.subscribe();
        this.setState('ready');
      } catch (e) {
        this.setState('error', friendly(e));
        clearTimeout(this.retry); this.retry = setTimeout(() => { if (this.state === 'error') this.start(); }, 60000); // nouvel essai dans 1 min
      } finally { this.starting = null; }
      return this.status();
    })();
    return this.starting;
  }

  // Compte anonyme du pilote (créé une fois), sans forcément ouvrir le chat : sert aussi aux avions de la compagnie.
  session() {
    if (this.me && this.sb) return Promise.resolve(this.me);
    if (!this.sessionP) this.sessionP = this.openSession().finally(() => { this.sessionP = null; });
    return this.sessionP;
  }
  async openSession() {
    if (!this.cfg) throw new Error('Serveur de la compagnie non configuré.');
    if (this.profile.pseudo.length < 2) throw new Error('Indique ton nom de pilote dans les Réglages.');
    if (this.me && this.sb) return this.me;
    if (!this.sb) {
      this.sb = this.createClient(this.cfg.url, this.cfg.key, {
        auth: { storage: fileStorage(path.join(this.dir, 'chat-session.json')), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
    }
    let { data: { session } } = await this.sb.auth.getSession();
    if (!session) {
      const r = await this.sb.auth.signInAnonymously();
      if (r.error) throw r.error;
      session = r.data.session;
    }
    this.me = { id: session.user.id, pseudo: this.profile.pseudo, grade: this.profile.grade, admin: false, banned: false };
    await this.saveProfile();
    return this.me;
  }

  // ---------- avions de la compagnie : un avion pris n'est plus disponible pour les autres pilotes ----------
  async aircraftList() {
    try {
      await this.session();
      // nom affiché = nom de pilote actuel dans le tracker (table des pilotes), même s'il l'a changé depuis
      const r = await this.sb.from('aircraft_bookings').select('reg,user_id,pseudo,taken_at,until,kind,pilots(pseudo)').gt('until', new Date().toISOString());
      if (r.error) throw r.error;
      return { ok: true, list: r.data.map((b) => ({ reg: b.reg, pseudo: (b.pilots && b.pilots.pseudo) || b.pseudo, until: Date.parse(b.until), mine: b.user_id === this.me.id, maint: b.kind === 'maintenance' })) };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }
  async aircraftTake(reg, until) {
    try {
      await this.session();
      const r = await this.sb.rpc('take_aircraft', { p_reg: clean(reg, 10).toUpperCase(), p_until: new Date(+until || Date.now() + 12 * 3600000).toISOString() });
      if (r.error) throw r.error;
      return { ok: true, until: Date.parse(r.data.until) };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }
  // maint (minutes) > 0 : après un vol, l'avion rentre au hangar en maintenance au lieu d'être libre tout de suite
  async aircraftRelease(reg, maint) {
    try {
      await this.session();
      const r = await this.sb.rpc('release_aircraft', { p_reg: clean(reg, 10).toUpperCase(), p_maint_minutes: Math.max(0, Math.min(360, Math.round(+maint || 0))) });
      if (r.error) throw r.error;
      return { ok: true };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }

  // ---------- hangar : état de la flotte, historique, fin de vol, actions de la direction ----------
  async hangarGet() {
    try {
      await this.session();
      const [st, lg, bk] = await Promise.all([
        this.sb.from('aircraft_state').select('*').order('reg'),
        this.sb.from('aircraft_log').select('id,reg,kind,at,pilot,callsign,dep,arr,minutes,rate,cond_before,cond_after,note').order('at', { ascending: false }).limit(120),
        this.aircraftList()
      ]);
      if (st.error) throw st.error;
      if (lg.error) throw lg.error;
      return { ok: true, fleet: st.data, log: lg.data, bookings: bk.ok ? bk.list : [], admin: !!(this.me && this.me.admin) };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }
  async finishFlight(o) {
    try {
      await this.session();
      const r = await this.sb.rpc('finish_flight', { p_reg: clean(o.reg, 10).toUpperCase(), p_callsign: clean(o.callsign, 12), p_dep: clean(o.dep, 4), p_arr: clean(o.arr, 4),
        p_minutes: Math.max(0, Math.round(+o.minutes || 0)), p_rate: Math.round(+o.rate || 0), p_keep: !!o.keep });
      if (r.error) throw r.error;
      return Object.assign({ ok: true }, r.data);
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }
  async hangarAdmin(action, reg, value, type) {
    try {
      await this.session();
      const r = await this.sb.rpc('hangar_admin', { p_action: String(action), p_reg: clean(reg, 10).toUpperCase(), p_value: value == null ? null : clean(value, 40), p_type: type == null ? null : clean(type, 8) });
      if (r.error) throw r.error;
      return { ok: true, state: r.data };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }

  // ---------- programme des vols de la compagnie (lu par tous, modifié par la direction) ----------
  async flightsProgram() {
    try {
      await this.session();
      const r = await this.sb.from('company_flights').select('number,dep_airport,arr_airport,dep_utc,block_min,aircraft_type,days,active,note');
      if (r.error) throw r.error;
      return { ok: true, admin: !!(this.me && this.me.admin), list: r.data };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }
  async flightSave(f) {
    try {
      await this.session();
      const row = {
        number: clean(f.number, 8).toUpperCase(), dep_airport: clean(f.from, 4).toUpperCase(), arr_airport: clean(f.to, 4).toUpperCase(),
        dep_utc: clean(f.dep, 5), block_min: Math.round(+f.block || 0), aircraft_type: f.type === 'B77W' ? 'B77W' : 'A320',
        days: Array.isArray(f.days) && f.days.length ? f.days.map(Number).filter((d) => d >= 1 && d <= 7) : [1, 2, 3, 4, 5, 6, 7],
        active: f.active !== false, note: clean(f.note, 200) || null
      };
      const r = await this.sb.from('company_flights').upsert(row, { onConflict: 'number' });
      if (r.error) throw r.error;
      return { ok: true };
    } catch (e) { return { ok: false, error: /row-level|permission/i.test(String((e && e.message) || e)) ? 'Réservé à la direction.' : friendlyFleet(e) }; }
  }
  async flightRemove(number) {
    try {
      await this.session();
      const r = await this.sb.from('company_flights').update({ active: false }).eq('number', clean(number, 8).toUpperCase());
      if (r.error) throw r.error;
      return { ok: true };
    } catch (e) { return { ok: false, error: /row-level|permission/i.test(String((e && e.message) || e)) ? 'Réservé à la direction.' : friendlyFleet(e) }; }
  }

  // journal des vols de la compagnie (statistiques) : un vol terminé, hors démo
  async logFlight(rep) {
    try {
      await this.session();
      const icao = (s) => clean(s, 4).toUpperCase();
      if (!/^[A-Z0-9]{3,4}$/.test(icao(rep.from)) || !/^[A-Z0-9]{3,4}$/.test(icao(rep.to))) return { ok: false, error: 'aéroports inconnus' };
      const int = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null);
      const p = rep.ponctualite || null;
      const row = {
        flight_number: clean(rep.flightNumber || rep.callsign, 10).toUpperCase(), dep: icao(rep.from), arr: icao(rep.to),
        aircraft_type: clean(rep.planAircraft || rep.aircraft, 12).toUpperCase(),
        block_min: int(rep.blockMinutes, 0, 1440), flight_min: int(rep.flightMinutes, 0, 1440), landing_rate: int(rep.landingRate, -3000, 3000),
        on_time: p ? !!p.onTime : null, delay_min: p ? int(p.arrDelay, -720, 1440) : null, flown_at: rep.date || new Date().toISOString()
      };
      const r = await this.sb.from('company_flight_log').insert(row);
      if (r.error) throw r.error;
      return { ok: true };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }
  async companyStats() {
    try {
      await this.session();
      const r = await this.sb.rpc('company_stats');
      if (r.error) throw r.error;
      return { ok: true, stats: r.data };
    } catch (e) { return { ok: false, error: friendlyFleet(e) }; }
  }

  async saveProfile() {
    const row = { id: this.me.id, pseudo: this.profile.pseudo, grade: this.profile.grade || null };
    const r = await this.sb.from('pilots').upsert(row, { onConflict: 'id' }).select('id,pseudo,grade,banned,is_admin').single();
    if (r.error) throw r.error;
    if (this.pilotCache) this.pilotCache.delete(this.me.id);
    Object.assign(this.me, { pseudo: r.data.pseudo, grade: r.data.grade, admin: !!r.data.is_admin, banned: !!r.data.banned });
    this.emitStatus();
  }

  async loadHistory() {
    const r = await this.sb.from('messages').select('id,created_at,user_id,pseudo,grade,admin,flight,body,deleted').order('created_at', { ascending: false }).limit(HISTORY);
    if (r.error) throw r.error;
    this.messages = r.data.reverse();
    this.emit('history', this.messages.filter((m) => !m.deleted));
  }

  async subscribe() {
    // Supabase réutilise un canal du même nom : après une coupure, on enlève l'ancien avant d'en ouvrir un neuf
    // (sinon : « cannot add postgres_changes callbacks … after subscribe() »).
    const old = [this.channel].concat(typeof this.sb.getChannels === 'function' ? this.sb.getChannels().filter((c) => /chat-pilotes$/.test(c.topic || '')) : []);
    this.channel = null;
    for (const c of new Set(old.filter(Boolean))) { try { await this.sb.removeChannel(c); } catch (e) { /* déjà fermé */ } }
    const ch = this.sb.channel('chat-pilotes', { config: { presence: { key: this.me.id } } });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
      const m = p.new; if (!m || this.messages.some((x) => x.id === m.id)) return;
      this.messages.push(m); if (this.messages.length > HISTORY * 2) this.messages.splice(0, this.messages.length - HISTORY);
      if (!m.deleted) this.emit('message', m);
    });
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => {
      const m = p.new; if (!m) return;
      const i = this.messages.findIndex((x) => x.id === m.id); if (i >= 0) this.messages[i] = m;
      if (m.deleted) this.emit('removed', m.id);
    });
    // « En ligne » : on ne fait confiance qu'à l'identifiant ; nom, grade et badge viennent du serveur.
    ch.on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState();
      const seen = Object.values(st).map((arr) => arr[0]).filter((x) => x && typeof x.id === 'string');
      this.presence = seen.map((x) => ({ id: x.id, flight: clean(x.flight, 60) }));
      this.refreshOnline().catch(() => {});
    });
    ch.subscribe((s) => {
      if (s === 'SUBSCRIBED') this.track();
      else if ((s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') && this.channel === ch) {
        this.setState('error', 'Connexion au chat perdue, nouvelle tentative…');
        clearTimeout(this.retry); this.retry = setTimeout(() => { if (this.state === 'error') this.start(); }, 15000);
      }
    });
    this.channel = ch;
  }

  track() {
    if (!this.channel || !this.me) return;
    this.channel.track({ id: this.me.id, flight: this.profile.flight }).catch(() => {});
  }

  async refreshOnline() {
    this.pilotCache = this.pilotCache || new Map();
    const ids = [...new Set((this.presence || []).map((p) => p.id))];
    const missing = ids.filter((id) => !this.pilotCache.has(id) || Date.now() - this.pilotCache.get(id).at > 5 * 60 * 1000);
    if (missing.length) {
      const r = await this.sb.from('pilots').select('id,pseudo,grade,is_admin,banned').in('id', missing.slice(0, 200));
      if (!r.error) for (const p of r.data) this.pilotCache.set(p.id, { at: Date.now(), p });
    }
    this.online = (this.presence || []).map((x) => { const c = this.pilotCache.get(x.id); return c && !c.p.banned ? { id: x.id, pseudo: c.p.pseudo, grade: c.p.grade || '', admin: !!c.p.is_admin, flight: x.flight } : null; })
      .filter(Boolean).sort((a, b) => (b.flight ? 1 : 0) - (a.flight ? 1 : 0) || a.pseudo.localeCompare(b.pseudo));
    this.emitStatus();
  }

  async send(text) {
    const body = clean(text, MAX_LEN);
    if (!body) return { ok: false, error: 'Message vide.' };
    if (this.state !== 'ready') return { ok: false, error: 'Le chat n’est pas connecté.' };
    const r = await this.sb.from('messages').insert({ body, flight: this.profile.flight || null }).select('id,created_at,user_id,pseudo,grade,admin,flight,body,deleted').single();
    if (r.error) return { ok: false, error: friendly(r.error) };
    if (!this.messages.some((x) => x.id === r.data.id)) { this.messages.push(r.data); this.emit('message', r.data); }
    return { ok: true };
  }

  async report(id, reason) {
    const r = await this.sb.from('reports').insert({ message_id: id, reason: clean(reason, 200) || null });
    if (r.error && !/duplicate/i.test(r.error.message || '')) return { ok: false, error: friendly(r.error) };
    return { ok: true };
  }

  async hide(id) { const r = await this.sb.rpc('hide_message', { mid: id }); return r.error ? { ok: false, error: friendly(r.error) } : { ok: true }; }
  async ban(userId) { const r = await this.sb.rpc('ban_pilot', { target: userId, ban: true }); return r.error ? { ok: false, error: friendly(r.error) } : { ok: true }; }

  async reports() {
    if (!this.me || !this.me.admin) return [];
    const r = await this.sb.from('reports').select('id,created_at,reason,message_id,messages(id,pseudo,body,user_id,deleted)').order('created_at', { ascending: false }).limit(50);
    return r.error ? [] : r.data;
  }

  visible() { return this.messages.filter((m) => !m.deleted).slice(-HISTORY); }

  stop() {
    clearTimeout(this.retry);
    if (this.channel) { try { this.sb.removeChannel(this.channel); } catch (e) { /* rien */ } }
    this.channel = null; this.online = [];
    if (this.state !== 'off') this.state = 'idle';
  }
}

module.exports = { Chat, MAX_LEN, fileStorage, clean };

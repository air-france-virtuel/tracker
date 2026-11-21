'use strict';
// Moteur du vol : détecte les 9 phases, le taux d'atterrissage, le TOD
// et les alertes de Max à partir des données du simulateur.
// Fichier sans dépendance à Electron pour pouvoir être testé seul.

const { distanceNm } = require('./geo');

const PHASES = ['Boarding', 'Roulage', 'Décollage', 'Montée', 'Croisière', 'Descente', 'Approche', 'Atterrissage', 'Parking'];
const P = { BOARDING: 0, TAXI: 1, TAKEOFF: 2, CLIMB: 3, CRUISE: 4, DESCENT: 5, APPROACH: 6, LANDING: 7, PARKING: 8 };

class FlightEngine {
  constructor(opts = {}) {
    this.plan = opts.plan || null; // plan SimBrief simplifié (voir simbrief.js)
    this.hard1 = opts.hardLanding || 600; // ft/min
    this.hard2 = opts.veryHardLanding || 900;
    this.phase = P.BOARDING;
    this.since = {}; // minuteries de confirmation
    this.warnAt = {}; // anti-répétition des alertes
    this.flags = {};
    this.last = null;
    this.lastAirborne = null;
    this.stats = {
      startTime: null, blockOff: null, takeoff: null, landing: null, blockOn: null,
      fuelStart: null, fuelEnd: null, distanceNm: 0, maxAlt: 0, landingRate: null, landingG: null,
      bounces: 0, maxTaxiSpeed: 0, overspeed250: 0
    };
    this.todInfo = null;
  }

  // Vrai si la condition reste vraie pendant `sec` secondes.
  hold(key, cond, now, sec) {
    if (!cond) { delete this.since[key]; return false; }
    if (this.since[key] == null) this.since[key] = now;
    return now - this.since[key] >= sec;
  }

  warnOnce(events, key, now, text, every = 60) {
    if (this.warnAt[key] != null && now - this.warnAt[key] < every) return;
    this.warnAt[key] = now;
    events.push({ type: 'warning', key, text });
  }

  setPhase(events, p, now) {
    if (p === this.phase) return;
    const prev = this.phase;
    this.phase = p;
    this.since = {};
    events.push({ type: 'phase', phase: p, name: PHASES[p], prev, time: now });
  }

  // t : { lat, lon, alt, agl, ias, gs, vs, hdg, onGround, fuelKg, engOn, parkBrake, gearDown, tdVel }
  // now : temps en secondes (horloge du simulateur ou réelle)
  update(t, now) {
    const ev = [];
    const s = this.stats;
    if (s.startTime == null) { s.startTime = now; s.fuelStart = t.fuelKg; }
    if (this.last) {
      const d = distanceNm(this.last.lat, this.last.lon, t.lat, t.lon);
      if (d < 5) s.distanceNm += d; // ignore les sauts (téléportation, changement d'aéroport)
    }
    s.maxAlt = Math.max(s.maxAlt, t.alt || 0);
    s.fuelEnd = t.fuelKg;

    const air = !t.onGround;
    const ph = this.phase;

    // --- transitions de phase (toujours vers l'avant, sauf décollage interrompu et remise de gaz)
    if (ph === P.BOARDING) {
      if (this.hold('taxi', t.onGround && t.gs > 3, now, 3)) { s.blockOff = now; this.setPhase(ev, P.TAXI, now); }
      // Suivi démarré (ou tracker relancé) avion déjà en vol : on rejoint directement la bonne phase.
      else if (this.hold('enroute', air && t.agl > 300 && t.gs > 80, now, 5)) {
        const cruise = this.plan && this.plan.cruiseAlt ? this.plan.cruiseAlt - 600 : 18000;
        const p = t.agl < 3000 && t.vs < 300 ? P.APPROACH : t.vs < -500 ? P.DESCENT : t.vs > 500 && t.alt < cruise ? P.CLIMB : t.alt >= cruise || Math.abs(t.vs) <= 500 ? P.CRUISE : P.CLIMB;
        this.flags.joinedInFlight = true;
        ev.push({ type: 'joined', phase: p });
        this.setPhase(ev, p, now);
      }
    } else if (ph === P.TAXI) {
      if (this.hold('roll', t.onGround && t.gs > 40, now, 2)) this.setPhase(ev, P.TAKEOFF, now);
      if (air && t.agl > 50) { this.setPhase(ev, P.TAKEOFF, now); }
    } else if (ph === P.TAKEOFF) {
      if (air && s.takeoff == null) s.takeoff = now;
      if (air && t.agl > 400) this.setPhase(ev, P.CLIMB, now);
      else if (this.hold('rto', t.onGround && t.gs < 25, now, 5)) {
        ev.push({ type: 'warning', key: 'rto', text: 'Décollage interrompu. On repart au roulage.' });
        this.setPhase(ev, P.TAXI, now);
      }
    } else if (ph === P.CLIMB) {
      const target = this.plan && this.plan.cruiseAlt ? this.plan.cruiseAlt - 600 : 10000;
      if (this.hold('lvl', air && Math.abs(t.vs) < 300 && t.alt >= target, now, 30)) this.setPhase(ev, P.CRUISE, now);
      else if (this.hold('dsc', air && t.vs < -800 && t.alt > 3000, now, 30) && s.maxAlt > 6000) this.setPhase(ev, P.DESCENT, now);
    } else if (ph === P.CRUISE) {
      if (this.hold('dsc', air && t.vs < -700, now, 20)) this.setPhase(ev, P.DESCENT, now);
    } else if (ph === P.DESCENT) {
      if (air && t.agl < 3000) this.setPhase(ev, P.APPROACH, now);
    } else if (ph === P.APPROACH) {
      if (this.hold('ga', air && t.vs > 1000 && t.agl > 4000, now, 10)) {
        ev.push({ type: 'warning', key: 'ga', text: 'Remise de gaz. Je repasse en montée.' });
        this.setPhase(ev, P.CLIMB, now);
      }
    } else if (ph === P.LANDING) {
      if (this.hold('park', t.onGround && t.gs < 1 && (t.parkBrake || !t.engOn), now, 5)) {
        s.blockOn = now;
        this.setPhase(ev, P.PARKING, now);
      }
    }

    // --- toucher des roues (premier contact seulement, en descente ou approche)
    if (this.last && !this.last.onGround && t.onGround && (this.phase === P.APPROACH || this.phase === P.DESCENT || this.phase === P.CLIMB)) {
      const ref = this.lastAirborne || this.last;
      let rate = -Math.abs(ref.vs || 0);
      if (t.tdVel && Math.abs(t.tdVel) > 0.1) rate = -Math.abs(t.tdVel * 60); // ft/s -> ft/min
      rate = Math.round(rate);
      s.landing = now;
      s.landingRate = rate;
      const level = Math.abs(rate) > this.hard2 ? 'tres-dur' : (Math.abs(rate) > this.hard1 ? 'dur' : 'normal');
      ev.push({ type: 'landing', rate, level });
      this.setPhase(ev, P.LANDING, now);
      this.flags.touchdown = now;
    } else if (this.phase === P.LANDING && this.last && !this.last.onGround && t.onGround && this.flags.touchdown && now - this.flags.touchdown < 15) {
      s.bounces += 1;
    }

    // --- alertes de Max
    const cur = this.phase;
    if (cur === P.LANDING && t.onGround && t.gs < 25) this.flags.vacated = true;
    if (t.onGround && (cur === P.TAXI || (cur === P.LANDING && this.flags.vacated))) {
      if (t.gs < 40) s.maxTaxiSpeed = Math.max(s.maxTaxiSpeed, t.gs);
      if (this.hold('taxifast', t.gs > 30 && t.gs < 40, now, 8)) this.warnOnce(ev, 'taxi', now, 'Ralentis : tu roules à ' + Math.round(t.gs) + ' kt. Reste sous 25 kt au roulage.', 45);
    }
    if (air && t.alt < 10000 && t.agl > 1500 && t.ias > 255) {
      if (this.hold('spd250', true, now, 5)) {
        s.overspeed250 += 1;
        this.warnOnce(ev, '250', now, 'Vitesse : ' + Math.round(t.ias) + ' kt sous 10 000 ft. La limite est 250 kt.', 60);
      }
    } else delete this.since.spd250;
    if (cur === P.APPROACH && air && t.agl < 1000 && t.agl > 100 && !t.gearDown) this.warnOnce(ev, 'gear', now, 'Attention : train d’atterrissage non sorti !', 20);
    if (cur === P.APPROACH && air && t.agl < 1000 && t.agl > 200 && t.vs < -1200) this.warnOnce(ev, 'unstab', now, 'Approche non stabilisée : taux de descente de ' + Math.round(-t.vs) + ' ft/min. Remets les gaz si besoin.', 30);

    // --- TOD et paliers (nécessite un plan SimBrief)
    const plan = this.plan;
    if (plan && plan.tod && air && (cur === P.CLIMB || cur === P.CRUISE)) {
      const dist = distanceNm(t.lat, t.lon, plan.tod.lat, plan.tod.lon);
      const toDest = distanceNm(t.lat, t.lon, plan.destination.lat, plan.destination.lon);
      const todToDest = distanceNm(plan.tod.lat, plan.tod.lon, plan.destination.lat, plan.destination.lon);
      const before = toDest > todToDest - 2; // pas encore dépassé
      const mins = t.gs > 50 ? (dist / t.gs) * 60 : null;
      this.todInfo = before ? { distNm: dist, minutes: mins } : { distNm: 0, minutes: 0 };
      if (before && mins != null && mins <= 10 && !this.flags.tod10) {
        this.flags.tod10 = true;
        ev.push({ type: 'tod10', distNm: dist, minutes: mins });
      }
      if ((dist <= 3 || !before) && !this.flags.todNow) {
        this.flags.todNow = true;
        this.flags.tod10 = true;
        ev.push({ type: 'todNow', distNm: dist });
      }
    }
    if (plan && plan.steps && plan.steps.length && air && cur === P.CRUISE) {
      for (const st of plan.steps) {
        const k = 'step-' + st.ident;
        if (this.flags[k]) continue;
        const d = distanceNm(t.lat, t.lon, st.lat, st.lon);
        if (d <= 10) {
          this.flags[k] = true;
          ev.push({ type: 'step', ident: st.ident, alt: st.alt, distNm: d });
        }
      }
    }

    if (air) this.lastAirborne = t;
    this.last = t;
    return ev;
  }

  report() {
    const s = this.stats;
    const mins = (a, b) => (a != null && b != null ? Math.round((b - a) / 60) : null);
    return {
      blockMinutes: mins(s.blockOff, s.blockOn),
      flightMinutes: mins(s.takeoff, s.landing),
      distanceNm: Math.round(s.distanceNm),
      fuelUsedKg: s.fuelStart != null && s.fuelEnd != null ? Math.max(0, Math.round(s.fuelStart - s.fuelEnd)) : null,
      maxAlt: Math.round(s.maxAlt),
      landingRate: s.landingRate,
      bounces: s.bounces,
      maxTaxiSpeed: Math.round(s.maxTaxiSpeed),
      overspeed250: s.overspeed250 > 0
    };
  }
}

module.exports = { FlightEngine, PHASES, P };

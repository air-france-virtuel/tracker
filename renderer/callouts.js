'use strict';
// Annonces de Max comme un vrai copilote (pilot monitoring) : il surveille les paramètres et annonce
// au bon moment, une seule fois, ce qu'un copilote dirait dans le cockpit. Rien ne se répète.
// Entrée : télémétrie t (alt, agl, ias, vs, onGround, gearDown, spoilers, flapsIdx), phase du vol et plan SimBrief.
(function (root) {
  const P = { BOARD: 0, TAXI: 1, TO: 2, CLIMB: 3, CRUISE: 4, DESC: 5, APP: 6, LAND: 7, PARK: 8 };

  function create() { return { said: {}, prev: null, airborne: false, landed: false, maxAglApp: 0 }; }

  // Renvoie les annonces à faire maintenant (le plus souvent une seule, parfois aucune).
  function update(st, t, phase, plan) {
    const out = [];
    if (!t) return out;
    const prev = st.prev; st.prev = t;
    if (!prev) return out;
    const once = (key, text) => { if (!st.said[key]) { st.said[key] = true; out.push(text); } };
    const crossUp = (v, a, b) => a < v && b >= v;
    const crossDn = (v, a, b) => a > v && b <= v;

    // ----- décollage -----
    if (phase <= P.TO && t.onGround && !st.airborne) {
      if (crossUp(100, prev.ias, t.ias)) once('100kt', 'Cent nœuds.');
    }
    if (!t.onGround && prev.onGround && !st.landed) st.airborne = true;
    if (st.airborne && !st.landed && t.vs > 300 && t.agl > 20 && t.agl < 1500) once('posrate', 'Vario positif.');
    if (st.said.posrate && prev.gearDown === true && t.gearDown === false) once('gearup', 'Train rentré.');

    // ----- montée -----
    const ta = plan && plan.transAlt;
    if (ta && phase <= P.CRUISE && t.vs > 0 && crossUp(ta, prev.alt, t.alt)) once('ta', 'Altitude de transition, calage standard.');
    if (phase <= P.CLIMB && crossUp(10000, prev.alt, t.alt) && t.vs > 0) once('fl100up', 'Niveau cent.');
    const crz = plan && plan.cruiseAlt;
    if (crz && t.vs > 300 && crossUp(crz - 1000, prev.alt, t.alt)) once('1000togo', 'Mille pieds avant le niveau.');

    // ----- descente -----
    if (phase >= P.CRUISE && t.vs < 0 && crossDn(10000, prev.alt, t.alt)) once('fl100dn', 'Niveau cent, phares allumés.');
    const tl = plan && plan.transLevel;
    if (tl && phase >= P.CRUISE && t.vs < 0 && crossDn(tl, prev.alt, t.alt)) once('tl', 'Niveau de transition, calage QNH.');

    // ----- approche (hauteur radio-sonde) -----
    if (phase >= P.DESC && !t.onGround && t.vs < 0) {
      if (crossDn(2500, prev.agl, t.agl)) once('2500', 'Deux mille cinq cents.');
      if (crossDn(1000, prev.agl, t.agl)) {
        const stable = t.gearDown && t.vs > -1200 && (t.flapsIdx == null || t.flapsIdx >= 2);
        once('1000', stable ? 'Mille, stabilisé.' : 'Mille, non stabilisé. Remise des gaz ?');
      }
      if (crossDn(500, prev.agl, t.agl)) once('500', 'Cinq cents.');
      if (crossDn(300, prev.agl, t.agl)) once('100above', 'Cent au-dessus.');
      if (crossDn(200, prev.agl, t.agl)) once('mins', 'Minimums.');
    }
    // remise des gaz : on remonte franchement après être descendu sous 1 000 ft
    if (phase >= P.APP && !t.onGround) {
      st.minAgl = Math.min(st.minAgl == null ? Infinity : st.minAgl, t.agl);
      if (st.minAgl < 1000 && t.vs > 500 && t.agl > st.minAgl + 200 && !st.said.ga) {
        once('ga', 'Remise des gaz, vario positif.');
        for (const k of ['2500', '1000', '500', '100above', 'mins', 'spoil', '70kt']) delete st.said[k]; // nouvelle approche
        st.minAgl = null;
      }
    }

    // ----- atterrissage -----
    if (st.airborne && t.onGround && !prev.onGround) st.landed = true;
    if (st.landed && t.onGround) {
      if (t.spoilers != null && t.spoilers > 50 && (prev.spoilers == null || prev.spoilers <= 50)) once('spoil', 'Spoilers sortis.');
      if (crossDn(70, prev.ias, t.ias)) once('70kt', 'Soixante-dix nœuds.');
    }
    return out;
  }

  const api = { create, update, P };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Callouts = api;
})(typeof window !== 'undefined' ? window : this);

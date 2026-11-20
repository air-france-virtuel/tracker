'use strict';
// Check-lists de Max, une par phase du vol. Chaque point peut se cocher tout seul quand le simulateur
// le confirme (fonction ok), sinon le pilote le coche à la main sur le panneau de Max.
// Phases : 0 Boarding, 1 Roulage, 2 Décollage, 3 Montée, 4 Croisière, 5 Descente, 6 Approche, 7 Atterrissage, 8 Parking.
(function (root) {
  const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
  // c = { t (télémétrie), plan, fuelPlanKg }
  const LISTS = [
    { phase: 0, title: 'Avant le départ', say: 'avant le départ', items: [
      { id: 'plan', text: 'Plan SimBrief chargé', ok: (c) => !!c.plan },
      { id: 'fuel', text: 'Carburant embarqué', ok: (c) => c.fuelPlanKg ? c.t.fuelKg >= c.fuelPlanKg * 0.97 : null },
      { id: 'beacon', text: 'Feu anticollision allumé', ok: (c) => c.t.beacon },
      { id: 'clr', text: 'ATIS et clairance obtenus' },
      { id: 'pax', text: 'Annonce d’embarquement' }
    ] },
    { phase: 1, title: 'Roulage', say: 'roulage', items: [
      { id: 'brake', text: 'Frein de parking desserré', ok: (c) => c.t.parkBrake === false },
      { id: 'flaps', text: 'Volets réglés pour le décollage', ok: (c) => c.t.flapsIdx != null ? c.t.flapsIdx >= 1 : null },
      { id: 'ctl', text: 'Commandes de vol vérifiées' },
      { id: 'xpdr', text: 'Transpondeur sur TA/RA' },
      { id: 'brief', text: 'Briefing décollage' }
    ] },
    { phase: 2, title: 'Alignement et décollage', say: 'décollage', items: [
      { id: 'land', text: 'Phares d’atterrissage allumés', ok: (c) => c.t.landLt },
      { id: 'strobe', text: 'Feux à éclats (strobes) allumés', ok: (c) => c.t.strobe },
      { id: 'rwy', text: 'Piste et finale dégagées' },
      { id: 'thr', text: 'Poussée de décollage affichée' }
    ] },
    { phase: 3, title: 'Après décollage et montée', say: 'après décollage', items: [
      { id: 'gear', text: 'Train rentré', ok: (c) => c.t.gearDown === false },
      { id: 'flaps0', text: 'Volets rentrés', ok: (c) => c.t.flapsIdx != null ? c.t.flapsIdx === 0 : null },
      { id: 'ap', text: 'Pilote automatique engagé', ok: (c) => c.t.ap },
      { id: 'std', text: 'Altimètres sur 1013 (STD) au niveau de transition', ok: (c) => c.t.alt > 6000 && near(c.t.baroMb, 1013.25, 0.6) },
      { id: 'spd', text: '250 kt maximum sous 10 000 ft' }
    ] },
    { phase: 4, title: 'Croisière', say: 'croisière', items: [
      { id: 'fl', text: 'Niveau de croisière atteint', ok: (c) => c.plan && c.plan.cruiseAlt ? near(c.t.alt, c.plan.cruiseAlt, 400) : null },
      { id: 'fuelchk', text: 'Carburant conforme au plan' },
      { id: 'arr', text: 'Arrivée préparée (ATIS, STAR, piste)' }
    ] },
    { phase: 5, title: 'Descente', say: 'descente', items: [
      { id: 'brief', text: 'Briefing approche fait' },
      { id: 'qnh', text: 'QNH de destination noté' },
      { id: 'pax', text: 'Annonce de descente aux passagers' }
    ] },
    { phase: 6, title: 'Approche', say: 'approche', items: [
      { id: 'qnh', text: 'Altimètres sur QNH', ok: (c) => c.t.baroMb != null ? !near(c.t.baroMb, 1013.25, 0.3) : null },
      { id: 'land', text: 'Phares d’atterrissage allumés', ok: (c) => c.t.landLt },
      { id: 'gear', text: 'Train sorti', ok: (c) => c.t.gearDown },
      { id: 'flaps', text: 'Volets en configuration atterrissage', ok: (c) => c.t.flapsIdx != null ? c.t.flapsIdx >= 3 : null },
      { id: 'stab', text: 'Approche stabilisée (vitesse et pente)' }
    ] },
    { phase: 7, title: 'Après atterrissage', say: 'après atterrissage', items: [
      { id: 'spoil', text: 'Spoilers rentrés', ok: (c) => c.t.spoilers != null ? c.t.spoilers < 5 : null },
      { id: 'flaps0', text: 'Volets rentrés', ok: (c) => c.t.flapsIdx != null ? c.t.flapsIdx === 0 : null },
      { id: 'strobe', text: 'Feux à éclats éteints', ok: (c) => c.t.strobe === false },
      { id: 'land', text: 'Phares d’atterrissage éteints', ok: (c) => c.t.landLt === false }
    ] },
    { phase: 8, title: 'Parking', say: 'parking', items: [
      { id: 'brake', text: 'Frein de parking serré', ok: (c) => c.t.parkBrake },
      { id: 'eng', text: 'Moteurs coupés', ok: (c) => c.t.engOn === false },
      { id: 'beacon', text: 'Feu anticollision éteint', ok: (c) => c.t.beacon === false }
    ] }
  ];

  // État d'une check-list : { phase, title, items:[{id,text,done,auto}], complete }
  function create(phase) {
    const L = LISTS.find((l) => l.phase === phase) || LISTS[0];
    return { phase: L.phase, title: L.title, say: L.say, items: L.items.map((i) => ({ id: i.id, text: i.text, done: false, auto: !!i.ok })), complete: false };
  }
  // Coche ce que le simulateur confirme. Renvoie les points cochés à l'instant.
  function update(state, ctx) {
    const L = LISTS.find((l) => l.phase === state.phase);
    const newly = [];
    if (!L || !ctx || !ctx.t) return newly;
    for (const it of state.items) {
      if (it.done) continue;
      const def = L.items.find((x) => x.id === it.id);
      let r = null;
      try { r = def && def.ok ? def.ok(ctx) : null; } catch (e) { r = null; }
      if (r === true) { it.done = true; it.by = 'sim'; newly.push(it); }
    }
    state.complete = state.items.every((i) => i.done);
    return newly;
  }
  function toggle(state, id) {
    const it = state.items.find((i) => i.id === id);
    if (it) { it.done = !it.done; it.by = it.done ? 'pilote' : null; }
    state.complete = state.items.every((i) => i.done);
    return state;
  }
  // Phrase de Max au début d'une check-list (seulement les points encore à faire)
  function announce(state) {
    const todo = state.items.filter((i) => !i.done).map((i) => i.text.charAt(0).toLowerCase() + i.text.slice(1));
    if (!todo.length) return 'Check-list ' + state.say + ' : tout est déjà bon.';
    return 'Check-list ' + state.say + ' : ' + todo.join(', ') + '.';
  }
  const api = { LISTS, create, update, toggle, announce };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Checklists = api;
})(typeof window !== 'undefined' ? window : this);

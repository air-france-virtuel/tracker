'use strict';
// Questions à Max pendant le vol : il répond avec les données du vol en cours et du plan SimBrief.
// c = { t (télémétrie), plan, ops ({ remaining, eta, next, fuelPlan }), tod ({ distNm, minutes }), phase, phaseName, ck (check-list), now }
(function (root) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ');
  const fmt = (n, d = 0) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
  const dur = (min) => { min = Math.max(0, Math.round(min)); return min >= 60 ? Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') : min + ' minutes'; };
  const hhmm = (t) => new Date(t).toISOString().slice(11, 16).replace(':', 'h') + ' UTC';
  const alt = (a) => a >= 18000 ? 'niveau ' + Math.round(a / 100) : fmt(Math.round(a / 10) * 10) + ' pieds';
  const fl = (a) => 'FL' + Math.round(a / 1000) * 10;
  const rwy = (ap) => ap && ap.rwy ? 'piste ' + ap.rwy : 'piste non précisée dans le plan';
  function wind(metar) {
    const m = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(metar || '');
    if (!m) return '';
    return m[1] === 'VRB' ? 'vent variable, ' + +m[2] + ' nœuds' : 'vent du ' + m[1] + ', ' + +m[2] + ' nœuds' + (m[3] ? ', rafales ' + +m[3] : '');
  }
  function qnh(metar) { const m = /\bQ(\d{4})\b/.exec(metar || '') || /\bA(\d{4})\b/.exec(metar || ''); return m ? (m[0][0] === 'Q' ? 'QNH ' + +m[1] : 'altimètre ' + m[1].slice(0, 2) + '.' + m[1].slice(2)) : ''; }
  function temp(metar) { const m = /\b(M?\d{2})\/(M?\d{2})\b/.exec(metar || ''); return m ? 'température ' + m[1].replace('M', '-') + ' degrés' : ''; }
  function meteo(metar, icao) {
    if (!metar) return 'Je n’ai pas la météo de ' + (icao || 'cet aéroport') + ' dans le plan.';
    const parts = [wind(metar), /CAVOK/.test(metar) ? 'CAVOK' : '', temp(metar), qnh(metar)].filter(Boolean);
    return 'Météo à ' + icao + ' : ' + (parts.length ? parts.join(', ') : metar) + '.';
  }

  // Chaque sujet : mots-clés reconnus et réponse (les sujets précis d'abord : « météo à l'arrivée » est une question météo)
  const TOPICS = [
    { id: 'aide', k: /\b(aide|help|que (peux|sais)|quoi demander|questions?)\b/, a: () => 'Tu peux me demander : temps restant, distance, heure d’arrivée, altitude, vitesse, carburant, TOD, pistes, météo au départ ou à l’arrivée, QNH, vent, SID, STAR, dégagement, prochain point, paliers, transition, phase du vol ou check-list.' },
    { id: 'carburant', k: /\b(carburant|fuel|kerosene|essence|petrole|reservoir)/, a: (c) => {
      if (!c.t) return 'Je n’ai pas encore les données de l’avion.';
      let s = 'Il reste ' + fmt(c.t.fuelKg / 1000, 1) + ' tonnes à bord.';
      if (c.ops && c.ops.fuelPlan != null) { const d = c.t.fuelKg - c.ops.fuelPlan; s += ' Le plan prévoyait ' + fmt(c.ops.fuelPlan / 1000, 1) + ' tonnes ici : ' + (Math.abs(d) < 150 ? 'c’est conforme.' : (d > 0 ? fmt(d) + ' kilos de plus' : fmt(-d) + ' kilos de moins') + ' que prévu.'); }
      return s; } },
    { id: 'altitude', k: /\b(altitude|niveau|hauteur|fl\d*\b|a quelle hauteur)/, a: (c) => c.t ? 'On est à ' + alt(c.t.alt) + (c.t.vs > 300 ? ', en montée' : c.t.vs < -300 ? ', en descente' : '') + '.' + (c.plan && c.plan.cruiseAlt ? ' Niveau de croisière prévu : ' + fl(c.plan.cruiseAlt) + '.' : '') : 'Je n’ai pas encore les données de l’avion.' },
    { id: 'vitesse', k: /\b(vitesse|speed|noeuds|kt|mach|vite)/, a: (c) => c.t ? 'Vitesse indiquée ' + Math.round(c.t.ias) + ' nœuds, vitesse sol ' + Math.round(c.t.gs) + ' nœuds.' : 'Je n’ai pas encore les données de l’avion.' },
    { id: 'vent', k: /\b(vent|wind)\b/, a: (c) => { const m = c.plan && (/(depart|decoll)/.test(c.q) ? c.plan.metarDep : c.plan.metarArr); const w = wind(m); return w ? (/(depart|decoll)/.test(c.q) ? 'Au départ : ' : 'À l’arrivée : ') + w + '.' : 'Je n’ai pas le vent dans le plan.'; } },
    { id: 'qnh', k: /\b(qnh|calage|altimetre|pression)/, a: (c) => { const m = c.plan && (/(depart|decoll)/.test(c.q) ? c.plan.metarDep : c.plan.metarArr); const q = qnh(m); return q ? (/(depart|decoll)/.test(c.q) ? 'Au départ : ' : 'À ' + (c.plan.destination.icao) + ' : ') + q + '.' + (c.plan.transLevel && !/(depart|decoll)/.test(c.q) ? ' Niveau de transition ' + fl(c.plan.transLevel) + '.' : '') : 'Je n’ai pas le QNH dans le plan.'; } },
    { id: 'meteo', k: /\b(meteo|metar|quel temps|temps qu il fait|ciel|temperature|pluie|nuage|orage)/, a: (c) => !c.plan ? 'Pas de météo sans plan SimBrief.' : /(depart|decoll)/.test(c.q) ? meteo(c.plan.metarDep, c.plan.origin.icao) : /(degagement|alternate|altn)/.test(c.q) ? meteo(c.plan.metarAltn, c.plan.alternate && c.plan.alternate.icao) : meteo(c.plan.metarArr, c.plan.destination.icao) },
    { id: 'piste', k: /\b(piste|runway|rwy)/, a: (c) => !c.plan ? 'Pas de piste sans plan SimBrief.' : /(depart|decoll)/.test(c.q) ? 'Départ ' + rwy(c.plan.origin) + ' à ' + c.plan.origin.icao + '.' : 'Arrivée ' + rwy(c.plan.destination) + ' à ' + c.plan.destination.icao + (/(depart|decoll)/.test(c.q) ? '' : ', départ ' + rwy(c.plan.origin) + ' à ' + c.plan.origin.icao) + '.' },
    { id: 'sid', k: /\bsid\b/, a: (c) => c.plan && c.plan.sid ? 'SID prévue : ' + c.plan.sid + ', ' + rwy(c.plan.origin) + '.' : 'Pas de SID dans le plan.' },
    { id: 'star', k: /\bstar\b|arrivee standard/, a: (c) => c.plan && c.plan.star ? 'STAR prévue : ' + c.plan.star + ', ' + rwy(c.plan.destination) + '.' : 'Pas de STAR dans le plan.' },
    { id: 'degagement', k: /\b(degagement|alternate|altn|deroutement)/, a: (c) => c.plan && c.plan.alternate && c.plan.alternate.icao ? 'Dégagement prévu : ' + c.plan.alternate.icao + (c.plan.alternate.name ? ', ' + c.plan.alternate.name : '') + (c.plan.alternate.rwy ? ', piste ' + c.plan.alternate.rwy : '') + '.' : 'Pas de dégagement dans le plan.' },
    { id: 'point', k: /\b(prochain point|waypoint|prochain fix|point suivant|balise)/, a: (c) => c.ops && c.ops.next ? 'Prochain point : ' + c.ops.next.ident + (c.ops.next.cum != null && c.ops.along != null ? ', dans ' + fmt(Math.max(0, c.ops.next.cum - c.ops.along)) + ' nautiques' : '') + '.' : 'Je n’ai pas le prochain point sans plan SimBrief.' },
    { id: 'palier', k: /\b(palier|step)/, a: (c) => c.plan && c.plan.steps && c.plan.steps.length ? 'Paliers prévus : ' + c.plan.steps.map((s) => fl(s.alt) + ' à ' + s.ident).join(', ') + '.' : 'Pas de palier prévu dans le plan.' },
    { id: 'transition', k: /\btransition\b/, a: (c) => !c.plan ? 'Pas de plan SimBrief.' : [c.plan.transAlt ? 'altitude de transition au départ ' + fmt(c.plan.transAlt) + ' pieds' : '', c.plan.transLevel ? 'niveau de transition à l’arrivée ' + fl(c.plan.transLevel) : ''].filter(Boolean).join(', ').replace(/^./, (x) => x.toUpperCase()) + '.' || 'Pas d’info de transition dans le plan.' },
    { id: 'check', k: /\b(check|checklist|check-list|liste|reste a faire|oublie)/, a: (c) => { if (!c.ck) return 'Pas de check-list en cours.'; const todo = c.ck.items.filter((i) => !i.done).map((i) => i.text.charAt(0).toLowerCase() + i.text.slice(1)); return todo.length ? 'Check-list ' + c.ck.title.toLowerCase() + ', il reste : ' + todo.join(', ') + '.' : 'Check-list ' + c.ck.title.toLowerCase() + ' terminée.'; } },
    { id: 'eta', k: /\b(arrive|arrivee prevue|eta|heure d arrivee|quand.*(arriv|atterri|pose))/, a: (c) => c.ops && c.ops.eta ? 'Arrivée prévue vers ' + hhmm(c.ops.eta) + ', dans ' + dur((c.ops.eta - c.now) / 60000) + '.' : 'Je calcule l’heure d’arrivée une fois en vol avec un plan SimBrief.' },
    { id: 'temps', k: /\b(combien de temps|temps restant|reste.*(temps|minutes|heure)|encore long|duree)/, a: (c) => c.ops && c.ops.eta ? 'Il reste environ ' + dur((c.ops.eta - c.now) / 60000) + ' de vol, arrivée vers ' + hhmm(c.ops.eta) + '.' : 'Je n’ai pas encore le temps restant : il faut un plan SimBrief et être en vol.' },
    { id: 'distance', k: /\b(distance|combien de (miles|nautiques|nm|km)|loin|nautique)/, a: (c) => c.ops && c.ops.remaining != null ? 'Il reste ' + fmt(c.ops.remaining) + ' nautiques jusqu’à ' + (c.plan ? c.plan.destination.icao : 'l’arrivée') + '.' : 'Je n’ai pas la distance restante sans plan SimBrief.' },
    { id: 'tod', k: /\b(tod|top of descent|debut de (la )?descente|quand (je )?descend|descente)/, a: (c) => c.phase >= 5 ? 'Le TOD est passé, on est en descente.' : c.tod && c.tod.distNm != null ? 'TOD dans ' + fmt(c.tod.distNm) + ' nautiques' + (c.tod.minutes != null ? ', environ ' + dur(c.tod.minutes) : '') + '.' : c.plan && c.plan.tod ? 'Je calcule le TOD après le décollage.' : 'Pas de TOD sans plan SimBrief.' },
    { id: 'phase', k: /\b(phase|ou (en )?(est|sommes)|on en est|statut)/, a: (c) => c.phaseName ? 'Phase actuelle : ' + c.phaseName.toLowerCase() + (c.ops && c.ops.remaining != null ? ', ' + fmt(c.ops.remaining) + ' nautiques avant l’arrivée' : '') + '.' : 'Aucun vol en cours.' },
    { id: 'heure', k: /\b(quelle heure|heure (utc|zulu)|heure est)/, a: (c) => 'Il est ' + hhmm(c.now) + '.' },
    { id: 'passagers', k: /\b(passagers?|pax|cabine)/, a: (c) => c.plan && c.plan.pax ? c.plan.pax + ' passagers à bord selon le plan.' : 'Je n’ai pas le nombre de passagers dans le plan.' },
    { id: 'masse', k: /\b(masse|poids|zfw|tow)/, a: (c) => c.plan && (c.plan.zfwKg || c.plan.towKg) ? [c.plan.zfwKg ? 'masse sans carburant ' + fmt(c.plan.zfwKg / 1000, 1) + ' tonnes' : '', c.plan.towKg ? 'masse au décollage ' + fmt(c.plan.towKg / 1000, 1) + ' tonnes' : ''].filter(Boolean).join(', ').replace(/^./, (x) => x.toUpperCase()) + '.' : 'Je n’ai pas les masses dans le plan.' },
    { id: 'merci', k: /\b(merci|super|top|parfait|bien joue)/, a: () => 'Avec plaisir, commandant !' },
    { id: 'bonjour', k: /^(salut|bonjour|hello|coucou|yo)\b/, a: () => 'Salut commandant ! Pose-moi une question sur le vol, ou demande « aide ».' }
  ];

  function answer(question, ctx) {
    const q = norm(question).trim();
    if (!q) return { id: 'vide', text: 'Pose-moi une question sur le vol, par exemple « combien de temps reste-t-il ? ».' };
    const c = Object.assign({ now: Date.now() }, ctx || {}, { q });
    for (const t of TOPICS) {
      if (t.k.test(q)) { let text; try { text = t.a(c); } catch (e) { text = 'Je n’ai pas cette information pour le moment.'; } return { id: t.id, text }; }
    }
    return { id: 'inconnu', text: 'Je n’ai pas compris. Demande-moi par exemple : temps restant, carburant, TOD, météo à l’arrivée, piste, prochain point ou check-list.' };
  }
  const api = { answer, TOPICS, norm };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.AskMax = api;
})(typeof window !== 'undefined' ? window : this);

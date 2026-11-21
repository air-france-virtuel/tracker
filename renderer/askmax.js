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
  function temp(metar) { const m = /\b(M?\d{2})\/(M?\d{2})\b/.exec(metar || ''); return m ? 'température ' + parseInt(m[1].replace('M', '-'), 10) + ' degrés' : ''; }
  function meteo(metar, icao) {
    if (!metar) return 'Je n’ai pas la météo de ' + (icao || 'cet aéroport') + ' dans le plan.';
    const parts = [wind(metar), /CAVOK/.test(metar) ? 'CAVOK' : '', temp(metar), qnh(metar)].filter(Boolean);
    return 'Météo à ' + icao + ' : ' + (parts.length ? parts.join(', ') : metar) + '.';
  }

  const tonnes = (kg) => fmt(kg / 1000, 1) + ' t';
  // point de la route cité dans la question (« carburant à BAXOD », « on passe MTL quand ? »)
  const COMMON = new Set(['LES', 'DES', 'UNE', 'QUE', 'QUI', 'EST', 'POUR', 'AVEC', 'DANS', 'SUR', 'TOC', 'TOD', 'SID', 'STAR', 'QNH', 'TAF', 'ETA', 'ETE', 'FUEL', 'MAX', 'VENT', 'PISTE', 'METEO', 'PLAN', 'ROUTE', 'BLOC', 'TEMPS', 'NIVEAU', 'QUAND', 'COMBIEN', 'QUEL', 'QUELLE', 'RESTE', 'PREVU', 'ALTITUDE', 'VITESSE', 'POINT', 'ARRIVEE', 'DEPART', 'CARBURANT']);
  function pointIn(q, plan) {
    const pts = (plan && plan.route_points) || []; if (!pts.length) return null;
    const apts = new Set([plan.origin && plan.origin.icao, plan.destination && plan.destination.icao, plan.alternate && plan.alternate.icao].filter(Boolean));
    const words = q.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 2 && !COMMON.has(w) && !apts.has(w));
    for (const w of words) { const p = pts.find((x) => x && x.ident && String(x.ident).toUpperCase() === w); if (p) return p; }
    if (/\btoc\b/.test(q)) return pts.find((x) => x.ident === 'TOC') || null;
    if (/\btod\b/.test(q) && /(carburant|fuel|altitude|vent|passe|heure)/.test(q)) return pts.find((x) => x.ident === 'TOD') || null;
    return null;
  }
  function pointInfo(p, c) {
    const bits = [];
    if (p.alt) bits.push('altitude prévue ' + (p.alt >= 18000 ? fl(p.alt) : fmt(p.alt) + ' pieds'));
    if (p.fuelKg != null) bits.push('carburant prévu ' + tonnes(p.fuelKg));
    if (p.windKt != null && p.windDir != null && p.alt > 1000) bits.push('vent prévu ' + String(Math.round(p.windDir)).padStart(3, '0') + '/' + Math.round(p.windKt) + ' nœuds');
    if (p.oat != null && p.alt > 1000) bits.push('température ' + Math.round(p.oat) + ' degrés');
    if (p.eltSec != null) bits.push('passage prévu ' + dur(p.eltSec / 60) + ' après le décollage');
    const rp = c.route && c.route.pts && c.route.pts.find((x) => x.ident === p.ident);
    const cum = rp && rp.cum != null ? rp.cum : p.cum;
    if (c.ops && cum != null && c.ops.along != null) bits.push(cum > c.ops.along ? 'encore ' + fmt(cum - c.ops.along) + ' nautiques' : 'déjà passé');
    return 'À ' + p.ident + (p.name && p.name !== p.ident ? ' (' + p.name.toLowerCase() + ')' : '') + (p.via && p.via !== 'DCT' ? ', sur ' + p.via : '') + ' : ' + (bits.join(', ') || 'pas d’info dans le plan') + '.';
  }

  // Chaque sujet : mots-clés reconnus et réponse (les sujets précis d'abord : « météo à l'arrivée » est une question météo)
  const TOPICS = [
    { id: 'pointroute', k: { test: () => false }, a: () => '' }, // remplacé par la recherche d'un point de la route (voir answer)
    { id: 'aide', k: /\b(aide|help|que (peux|sais)|quoi demander|questions?)\b/, a: () => 'Tu peux me demander : temps restant, distance, heure d’arrivée, altitude, vitesse, carburant (et le détail prévu : bloc, réserve, extra), TOD, route, pistes, météo et TAF, QNH, vent, SID, STAR, dégagement, cost index, temps de vol prévu, prochain point, paliers, transition, phase ou check-list. Tu peux aussi citer un point de la route, par exemple « carburant à BAXOD ».' },
    { id: 'fuelplan', k: /\b(carburant|fuel|kerosene)\b.*\b(prevu|bloc|block|plan|depart|decollage|atterrissage|arrivee|reserve|extra|contingence|delestage|trip|detail)|\b(reserve finale|carburant de reserve|bloc carburant|block fuel|contingence|extra fuel|trip fuel)\b/, a: (c) => {
      const F = c.plan && c.plan.fuel; if (!F) return 'Je n’ai pas le détail du carburant dans le plan.';
      const parts = [['au bloc', F.ramp], ['roulage', F.taxi], ['délestage du vol', F.trip], ['contingence', F.contingency], ['dégagement', F.alternate], ['réserve finale', F.reserve], ['extra', F.extra], ['prévu à l’atterrissage', F.landing]].filter((x) => x[1] != null && x[1] > 0);
      return parts.length ? 'Carburant SimBrief : ' + parts.map(([n, v]) => n + ' ' + tonnes(v)).join(', ') + '.' : 'Je n’ai pas le détail du carburant dans le plan.'; } },
    { id: 'route', k: /\b(route|itineraire|plan de vol|par ou|airways?|voies? aeriennes?)\b/, a: (c) => c.plan && c.plan.route ? 'Route SimBrief : ' + c.plan.origin.icao + ' ' + c.plan.route + ' ' + c.plan.destination.icao + (c.plan.distanceNm ? ', ' + fmt(c.plan.distanceNm) + ' nautiques' : '') + '.' : 'Je n’ai pas la route dans le plan.' },
    { id: 'taf', k: /\b(taf|prevision|prevue? (a|pour) l arrivee)\b/, a: (c) => !c.plan ? 'Pas de plan SimBrief.' : c.side === 'dep' ? (c.plan.tafDep ? 'TAF de ' + c.plan.origin.icao + ' : ' + c.plan.tafDep : 'Pas de TAF du départ dans le plan.') : (c.plan.tafArr ? 'TAF de ' + c.plan.destination.icao + ' : ' + c.plan.tafArr : 'Pas de TAF de l’arrivée dans le plan.') },
    { id: 'duree', k: /\b(temps de vol prevu|duree prevue|ete|temps prevu|combien de temps (dure|prend) le vol|temps bloc)\b/, a: (c) => c.plan && c.plan.eteSec ? 'Temps de vol prévu : ' + dur(c.plan.eteSec / 60) + (c.plan.blockSec ? ', temps bloc ' + dur(c.plan.blockSec / 60) : '') + '.' : 'Je n’ai pas le temps de vol prévu.' },
    { id: 'cost', k: /\b(cost index|ci)\b/, a: (c) => c.plan && (c.plan.costIndex || c.plan.cruiseProfile) ? 'Cost index ' + (c.plan.costIndex || c.plan.cruiseProfile.replace(/^CI\s*/i, '')) + '.' : 'Pas de cost index dans le plan.' },
    { id: 'ventmoyen', k: /\b(vent moyen|composante|vent (de face|arriere|en route|en croisiere))\b/, a: (c) => c.plan && c.plan.avgWindComp != null ? 'Composante de vent moyenne prévue : ' + (c.plan.avgWindComp < 0 ? fmt(-c.plan.avgWindComp) + ' nœuds de face' : fmt(c.plan.avgWindComp) + ' nœuds arrière') + '.' : 'Pas de vent moyen dans le plan.' },
    { id: 'avion', k: /\b(quel avion|immatriculation|immat|indicatif|callsign|numero de vol|type d avion)\b/, a: (c) => c.plan ? 'Vol ' + (c.plan.callsign || c.plan.flightNumber || '?') + ', ' + (c.plan.aircraft || 'avion inconnu') + (c.plan.registration ? ' immatriculé ' + c.plan.registration : '') + ', ' + c.plan.origin.icao + ' → ' + c.plan.destination.icao + '.' : 'Pas de plan SimBrief.' },
    { id: 'carburant', k: /\b(carburant|fuel|kerosene|essence|petrole|reservoir)/, a: (c) => {
      if (!c.t) return 'Je n’ai pas encore les données de l’avion.';
      let s = 'Il reste ' + fmt(c.t.fuelKg / 1000, 1) + ' tonnes à bord.';
      if (c.ops && c.ops.fuelPlan != null) { const d = c.t.fuelKg - c.ops.fuelPlan; s += ' Le plan prévoyait ' + fmt(c.ops.fuelPlan / 1000, 1) + ' tonnes ici : ' + (Math.abs(d) < 150 ? 'c’est conforme.' : (d > 0 ? fmt(d) + ' kilos de plus' : fmt(-d) + ' kilos de moins') + ' que prévu.'); }
      return s; } },
    { id: 'altitude', k: /\b(altitude|niveau|hauteur|fl\d*\b|a quelle hauteur)/, a: (c) => c.t ? 'On est à ' + alt(c.t.alt) + (c.t.vs > 300 ? ', en montée' : c.t.vs < -300 ? ', en descente' : '') + '.' + (c.plan && c.plan.cruiseAlt ? ' Niveau de croisière prévu : ' + fl(c.plan.cruiseAlt) + '.' : '') : 'Je n’ai pas encore les données de l’avion.' },
    { id: 'vitesse', k: /\b(vitesse|speed|noeuds|kt|mach|vite)/, a: (c) => c.t ? 'Vitesse indiquée ' + Math.round(c.t.ias) + ' nœuds, vitesse sol ' + Math.round(c.t.gs) + ' nœuds.' : 'Je n’ai pas encore les données de l’avion.' },
    { id: 'vent', k: /\b(vent|wind)\b/, a: (c) => { const m = c.plan && (c.side === 'dep' ? c.plan.metarDep : c.plan.metarArr); const w = wind(m); return w ? (c.side === 'dep' ? 'Au départ : ' : 'À l’arrivée : ') + w + '.' : 'Je n’ai pas le vent dans le plan.'; } },
    { id: 'qnh', k: /\b(qnh|calage|altimetre|pression)/, a: (c) => { const m = c.plan && (c.side === 'dep' ? c.plan.metarDep : c.plan.metarArr); const q = qnh(m); return q ? (c.side === 'dep' ? 'Au départ : ' : 'À ' + (c.plan.destination.icao) + ' : ') + q + '.' + (c.plan.transLevel && c.side !== 'dep' ? ' Niveau de transition ' + fl(c.plan.transLevel) + '.' : '') : 'Je n’ai pas le QNH dans le plan.'; } },
    { id: 'meteo', k: /\b(meteo|metar|quel temps|temps qu il fait|ciel|temperature|pluie|nuage|orage)/, a: (c) => !c.plan ? 'Pas de météo sans plan SimBrief.' : c.side === 'dep' ? meteo(c.plan.metarDep, c.plan.origin.icao) : c.side === 'altn' ? meteo(c.plan.metarAltn, c.plan.alternate && c.plan.alternate.icao) : meteo(c.plan.metarArr, c.plan.destination.icao) },
    { id: 'piste', k: /\b(piste|runway|rwy)/, a: (c) => c.pistes && c.pistes[c.side === 'dep' ? 'dep' : 'arr'] && c.pistes[c.side === 'dep' ? 'dep' : 'arr'].say ? c.pistes[c.side === 'dep' ? 'dep' : 'arr'].say : !c.plan ? 'Pas de piste sans plan SimBrief.' : c.side === 'dep' ? 'Départ ' + rwy(c.plan.origin) + ' à ' + c.plan.origin.icao + '.' : 'Arrivée ' + rwy(c.plan.destination) + ' à ' + c.plan.destination.icao + (c.side === 'dep' ? '' : ', départ ' + rwy(c.plan.origin) + ' à ' + c.plan.origin.icao) + '.' },
    { id: 'sid', k: /\bsid\b/, a: (c) => c.plan && c.plan.sid ? 'SID prévue : ' + c.plan.sid + ', ' + rwy(c.plan.origin) + '.' : 'Pas de SID dans le plan.' },
    { id: 'star', k: /\bstar\b|arrivee standard/, a: (c) => c.plan && c.plan.star ? 'STAR prévue : ' + c.plan.star + ', ' + rwy(c.plan.destination) + '.' : 'Pas de STAR dans le plan.' },
    { id: 'degagement', k: /\b(degagement|alternate|altn|deroutement)/, a: (c) => c.plan && c.plan.alternate && c.plan.alternate.icao ? 'Dégagement prévu : ' + c.plan.alternate.icao + (c.plan.alternate.name ? ', ' + c.plan.alternate.name : '') + (c.plan.alternate.rwy ? ', piste ' + c.plan.alternate.rwy : '') + '.' : 'Pas de dégagement dans le plan.' },
    { id: 'point', k: /\b(prochain point|waypoint|prochain fix|point suivant|balise)/, a: (c) => c.ops && c.ops.next ? 'Prochain point : ' + c.ops.next.ident + (c.ops.next.cum != null && c.ops.along != null ? ', dans ' + fmt(Math.max(0, c.ops.next.cum - c.ops.along)) + ' nautiques' : '') + '.' : 'Je n’ai pas le prochain point sans plan SimBrief.' },
    { id: 'palier', k: /\b(palier|step)/, a: (c) => c.plan && c.plan.steps && c.plan.steps.length ? 'Paliers prévus : ' + c.plan.steps.map((s) => fl(s.alt) + ' à ' + s.ident).join(', ') + '.' : 'Pas de palier prévu dans le plan.' },
    { id: 'transition', k: /\btransition\b/, a: (c) => !c.plan ? 'Pas de plan SimBrief.' : [c.plan.transAlt ? 'altitude de transition au départ ' + fmt(c.plan.transAlt) + ' pieds' : '', c.plan.transLevel ? 'niveau de transition à l’arrivée ' + fl(c.plan.transLevel) : ''].filter(Boolean).join(', ').replace(/^./, (x) => x.toUpperCase()) + '.' || 'Pas d’info de transition dans le plan.' },
    { id: 'check', k: /\b(check|checklist|check-list|liste|reste a faire|oublie)/, a: (c) => { if (!c.ck) return 'Pas de check-list en cours.'; const todo = c.ck.items.filter((i) => !i.done).map((i) => i.text.charAt(0).toLowerCase() + i.text.slice(1)); return todo.length ? 'Check-list ' + c.ck.title.toLowerCase() + ', il reste : ' + todo.join(', ') + '.' : 'Check-list ' + c.ck.title.toLowerCase() + ' terminée.'; } },
    { id: 'tod', k: /\b(tod|t o d|top of descent|debut de (la )?descente|descen(d|te))/, a: (c) => c.phase >= 5 ? 'Le TOD est passé, on est en descente.' : c.tod && c.tod.distNm != null ? 'TOD dans ' + fmt(c.tod.distNm) + ' nautiques' + (c.tod.minutes != null ? ', environ ' + dur(c.tod.minutes) : '') + '.' : c.plan && c.plan.tod ? 'Je calcule le TOD après le décollage.' : 'Pas de TOD sans plan SimBrief.' },
    { id: 'eta', k: /\b(arrive|arrivee prevue|eta|heure d arrivee|quand.*(arriv|atterri|pose))/, a: (c) => c.ops && c.ops.eta ? 'Arrivée prévue vers ' + hhmm(c.ops.eta) + ', dans ' + dur((c.ops.eta - c.now) / 60000) + '.' : 'Je calcule l’heure d’arrivée une fois en vol avec un plan SimBrief.' },
    { id: 'temps', k: /\b(combien de temps|temps restant|reste.*(temps|minutes|heure)|encore long|duree)/, a: (c) => c.ops && c.ops.eta ? 'Il reste environ ' + dur((c.ops.eta - c.now) / 60000) + ' de vol, arrivée vers ' + hhmm(c.ops.eta) + '.' : 'Je n’ai pas encore le temps restant : il faut un plan SimBrief et être en vol.' },
    { id: 'distance', k: /\b(distance|combien de (miles|nautiques|nm|km)|loin|nautique)/, a: (c) => c.ops && c.ops.remaining != null ? 'Il reste ' + fmt(c.ops.remaining) + ' nautiques jusqu’à ' + (c.plan ? c.plan.destination.icao : 'l’arrivée') + '.' : 'Je n’ai pas la distance restante sans plan SimBrief.' },
    { id: 'phase', k: /\b(phase|ou (en )?(est|sommes)|on en est|statut)/, a: (c) => c.phaseName ? 'Phase actuelle : ' + c.phaseName.toLowerCase() + (c.ops && c.ops.remaining != null ? ', ' + fmt(c.ops.remaining) + ' nautiques avant l’arrivée' : '') + '.' : 'Aucun vol en cours.' },
    { id: 'heure', k: /\b(quelle heure|heure (utc|zulu)|heure est)/, a: (c) => 'Il est ' + hhmm(c.now) + '.' },
    { id: 'passagers', k: /\b(passagers?|pax|cabine)/, a: (c) => c.plan && c.plan.pax ? c.plan.pax + ' passagers à bord selon le plan.' : 'Je n’ai pas le nombre de passagers dans le plan.' },
    { id: 'masse', k: /\b(masse|poids|zfw|tow)/, a: (c) => c.plan && (c.plan.zfwKg || c.plan.towKg) ? [c.plan.zfwKg ? 'masse sans carburant ' + fmt(c.plan.zfwKg / 1000, 1) + ' tonnes' : '', c.plan.towKg ? 'masse au décollage ' + fmt(c.plan.towKg / 1000, 1) + ' tonnes' : ''].filter(Boolean).join(', ').replace(/^./, (x) => x.toUpperCase()) + '.' : 'Je n’ai pas les masses dans le plan.' },
    { id: 'merci', k: /\b(merci|super|top|parfait|bien joue)/, a: () => 'Avec plaisir, commandant !' },
    { id: 'bonjour', k: /^(salut|bonjour|hello|coucou|yo)\b/, a: () => 'Salut commandant ! Pose-moi une question sur le vol, ou demande « aide ».' }
  ];

  // Aéroport visé par la question : départ, arrivée (par défaut) ou dégagement — par son code OACI, sa ville ou les mots « départ » / « dégagement »
  function mentions(q, ap) {
    if (!ap) return false;
    if (ap.icao && new RegExp('\\b' + ap.icao.toLowerCase() + '\\b').test(q)) return true;
    return norm(ap.name || '').split(/[^a-z]+/).filter((w) => w.length >= 5 && !/^(international|airport|aeroport|charles|gaulle|regional)$/.test(w)).some((w) => q.includes(w));
  }
  function sideOf(q, plan) {
    if (plan) {
      if (mentions(q, plan.origin)) return 'dep';
      if (mentions(q, plan.alternate)) return 'altn';
      if (mentions(q, plan.destination)) return 'arr';
    }
    if (/(depart|decoll)/.test(q)) return 'dep';
    if (/(degagement|alternate|altn|deroutement)/.test(q)) return 'altn';
    return 'arr';
  }
  function answer(question, ctx) {
    const q = norm(question).trim();
    if (!q) return { id: 'vide', text: 'Pose-moi une question sur le vol, par exemple « combien de temps reste-t-il ? ».' };
    const c = Object.assign({ now: Date.now() }, ctx || {}, { q });
    c.side = sideOf(q, c.plan);
    // aéroport cité qui n'est ni le départ, ni l'arrivée, ni le dégagement
    const COMMON = /^(dans|pour|avec|sous|vers|mais|donc|elle|nous|vous|sont|tout|plus|quel|fait|faut|peux|veux|vais|cest|leur|bien|tres|deja|ciel|vent|pres|loin|haut|long|lent|vite|pile|gros|meme|aussi|ceux|cela|ceci|elle|iles|lors|onze|deux|sept|neuf|cinq|zero|mode|pist|temp|taxi|gate|stop)$/;
    const other = (q.match(/\b[a-z]{4}\b/g) || []).filter((w) => !COMMON.test(w)).map((w) => [null, w])[0] || null;
    if (c.plan && other && /(meteo|metar|vent|qnh|taf|piste|temps)/.test(q) && c.side === 'arr' && !mentions(q, c.plan.destination) && /^[a-z]{2}[a-z]{2}$/.test(other[1]) && /^(lf|le|lg|li|lp|ls|ed|eg|eb|eh|ek|en|es|ep|lk|lo|lh|lr|lz|ld|ly|lt|ll|gm|dt|da|k[a-z]|c[a-z]|t[a-z]|so|sb|fm|om|ot|ol|rj|zb|vh|wi|ys|ny|fa|ha|hk|ue|uu|ul)/.test(other[1]) && ![c.plan.origin, c.plan.destination, c.plan.alternate].some((a) => a && a.icao && a.icao.toLowerCase() === other[1])) {
      return { id: 'autre', text: 'Je n’ai que la météo du plan SimBrief : départ ' + c.plan.origin.icao + ', arrivée ' + c.plan.destination.icao + (c.plan.alternate && c.plan.alternate.icao ? ', dégagement ' + c.plan.alternate.icao : '') + '. ' + other[1].toUpperCase() + ' n’y est pas.' };
    }
    // un point de la route est cité : Max lit la ligne du navlog SimBrief
    const pt = pointIn(question, c.plan);
    if (pt) return { id: 'pointroute', text: pointInfo(pt, c) };
    for (const t of TOPICS) {
      if (t.k.test(q)) { let text; try { text = t.a(c); } catch (e) { text = 'Je n’ai pas cette information pour le moment.'; } return { id: t.id, text }; }
    }
    return { id: 'inconnu', text: 'Je n’ai pas compris. Demande-moi par exemple : temps restant, carburant, TOD, météo à l’arrivée, piste, prochain point ou check-list.' };
  }
  // Phrase dictée au micro → texte que Max comprend : alphabet aéronautique (Lima Fox Papa Golf → LFPG),
  // mots mal entendus, et phrases que la reconnaissance invente parfois sur un silence.
  const NATO = { alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', fox: 'F', foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whisky: 'W', whiskey: 'W', xray: 'X', yankee: 'Y', zulu: 'Z' };
  function fromSpeech(text) {
    let s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s || /sous-titr|amara\.org|merci d.avoir regard|abonnez-vous/i.test(s)) return '';
    s = s.replace(/\bm[ée]t[ée]?[iy]?o\b/gi, 'météo');
    s = s.replace(/x-ray/gi, 'xray');
    const words = s.split(' ');
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const letters = run.every((r) => /^[A-Z]$/.test(r));
      if (letters && run.length === 4) out.push(run.join('')); else out.push(...run);
      run = [];
    };
    for (const w of words) {
      const bare = w.replace(/[.,;:!?…]+$/, '');
      const key = bare.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (NATO[key]) { run.push(NATO[key]); continue; }
      if (/^[A-Za-z]$/.test(bare) && (run.length || /^[A-Z]$/.test(bare))) { run.push(bare.toUpperCase()); continue; }
      if (/^\d{1,2}$/.test(bare) && run.length && /^[A-Z]$/.test(run[run.length - 1])) { run[run.length - 1] += bare; continue; }
      flush();
      out.push(w);
    }
    flush();
    return out.join(' ').replace(/[.!…]+$/, '').trim();
  }
  const api = { answer, TOPICS, norm, fromSpeech };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.AskMax = api;
})(typeof window !== 'undefined' ? window : this);

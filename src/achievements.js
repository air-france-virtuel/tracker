'use strict';
// Succès à accomplir : calculés à partir des rapports de vol du pilote (vols de démo exclus) et de sa carrière.
// Chaque succès a une progression (valeur / objectif) et la date du vol qui l'a débloqué.

const isFr = (icao) => /^LF/.test(icao || '');
const OUTRE_MER = ['TFFR', 'TFFF', 'FMEE', 'SOCA', 'NTAA', 'TFFJ', 'FMCZ', 'LFVP'];
const AMERIQUES = /^[KCMST]/; // États-Unis, Canada, Mexique, Amérique du Sud, Caraïbes
const ASIE = /^[RVWZO]/; // Japon, Asie, Moyen-Orient
const famille = (r) => {
  const t = String(r.planAircraft || r.aircraft || r.simAircraft || '').toUpperCase();
  if (/B77W|777/.test(t)) return 'B77W';
  if (/A320|A20N|A32/.test(t)) return 'A320';
  return '';
};
const isLat = (r) => /^LAT\d/.test(String(r.flightNumber || r.callsign || '').toUpperCase());
const soft = (r) => typeof r.landingRate === 'number' && Math.abs(r.landingRate) <= 100;
const smooth = (r) => typeof r.landingRate === 'number' && Math.abs(r.landingRate) <= 180;
const longHaul = (r) => (r.flightMinutes || 0) >= 360 || (r.distanceNm || 0) >= 2200;
const hourLocal = (r) => { const d = new Date(r.date); return d.getHours(); };

// définition : id, catégorie, icône, titre, description, objectif, fonction de progression sur les vols (dans l'ordre chronologique)
const LIST = [
  // débuts
  ['premier-vol', 'Débuts', '🛫', 'Premier envol', 'Termine ton premier vol suivi par le tracker.', 1, (rs) => rs.length],
  ['premier-lat', 'Débuts', '🇫🇷', 'Aux couleurs de la compagnie', 'Fais un vol avec un indicatif Les Ailes Tricolores (LAT…).', 1, (rs) => rs.filter(isLat).length],
  ['premier-a320', 'Débuts', '✈️', 'Bienvenue sur A320', 'Fais un vol en A320.', 1, (rs) => rs.filter((r) => famille(r) === 'A320').length],
  ['premier-777', 'Débuts', '🛩️', 'Le géant des mers', 'Fais un vol en 777-300ER.', 1, (rs) => rs.filter((r) => famille(r) === 'B77W').length],
  // carnet de vol
  ['vols-10', 'Carnet de vol', '📒', 'Habitué des pistes', 'Termine 10 vols.', 10, (rs) => rs.length],
  ['vols-50', 'Carnet de vol', '📗', 'Pilote de ligne', 'Termine 50 vols.', 50, (rs) => rs.length],
  ['vols-100', 'Carnet de vol', '📘', 'Centurion', 'Termine 100 vols.', 100, (rs) => rs.length],
  ['heures-10', 'Carnet de vol', '⏱️', '10 heures de vol', 'Cumule 10 heures de vol.', 10, (rs) => Math.floor(rs.reduce((a, r) => a + (r.flightMinutes || 0), 0) / 60)],
  ['heures-100', 'Carnet de vol', '⌛', '100 heures de vol', 'Cumule 100 heures de vol.', 100, (rs) => Math.floor(rs.reduce((a, r) => a + (r.flightMinutes || 0), 0) / 60)],
  ['heures-500', 'Carnet de vol', '🏅', '500 heures de vol', 'Cumule 500 heures de vol.', 500, (rs) => Math.floor(rs.reduce((a, r) => a + (r.flightMinutes || 0), 0) / 60)],
  ['vols-lat-25', 'Carnet de vol', '🎖️', 'Pilier de la compagnie', 'Fais 25 vols Les Ailes Tricolores (indicatif LAT).', 25, (rs) => rs.filter(isLat).length],
  // atterrissages
  ['velours', 'Atterrissages', '🪶', 'Toucher de velours', 'Pose l’avion à 100 ft/min ou moins.', 1, (rs) => rs.filter(soft).length],
  ['velours-10', 'Atterrissages', '🧈', 'Maître du kiss landing', 'Réussis 10 atterrissages à 100 ft/min ou moins.', 10, (rs) => rs.filter(soft).length],
  ['serie-douce', 'Atterrissages', '🎯', 'Série parfaite', 'Enchaîne 5 atterrissages de suite à 180 ft/min ou moins, sans rebond.', 5, (rs) => { let best = 0, cur = 0; for (const r of rs) { if (smooth(r) && !r.bounces) { cur++; best = Math.max(best, cur); } else cur = 0; } return best; }],
  // réseau
  ['dest-5', 'Réseau', '📍', 'Globe-trotter', 'Atterris dans 5 aéroports différents.', 5, (rs) => new Set(rs.map((r) => r.to).filter(Boolean)).size],
  ['dest-20', 'Réseau', '🗺️', 'Grand voyageur', 'Atterris dans 20 aéroports différents.', 20, (rs) => new Set(rs.map((r) => r.to).filter(Boolean)).size],
  ['tour-de-france', 'Réseau', '🥖', 'Tour de France', 'Atterris dans 8 aéroports français différents.', 8, (rs) => new Set(rs.map((r) => r.to).filter(isFr)).size],
  ['long-courrier', 'Réseau', '🌍', 'Long-courrier', 'Fais un vol de 6 heures ou plus.', 1, (rs) => rs.filter(longHaul).length],
  ['atlantique', 'Réseau', '🌊', 'Traversée de l’Atlantique', 'Relie la France et les Amériques.', 1, (rs) => rs.filter((r) => (isFr(r.from) && AMERIQUES.test(r.to || '') && !OUTRE_MER.includes(r.to)) || (isFr(r.to) && AMERIQUES.test(r.from || '') && !OUTRE_MER.includes(r.from))).length],
  ['outre-mer', 'Réseau', '🏝️', 'Cap sur l’outre-mer', 'Relie la métropole et un aéroport d’outre-mer (Antilles, Réunion…).', 1, (rs) => rs.filter((r) => OUTRE_MER.includes(r.to) || OUTRE_MER.includes(r.from)).length],
  ['orient', 'Réseau', '🌏', 'Vers l’Orient', 'Pose-toi en Asie ou au Moyen-Orient.', 1, (rs) => rs.filter((r) => ASIE.test(r.to || '')).length],
  // discipline
  ['250kt', 'Discipline', '🐢', 'Respect des 250 kt', 'Fais 10 vols sans dépasser 250 kt sous le niveau 100.', 10, (rs) => rs.filter((r) => r.overspeed250 === false).length],
  ['roulage', 'Discipline', '🚦', 'Roulage prudent', 'Fais 10 vols sans dépasser 30 kt au roulage.', 10, (rs) => rs.filter((r) => typeof r.maxTaxiSpeed === 'number' && r.maxTaxiSpeed <= 30).length],
  // journées
  ['rotation', 'Journées', '🔁', 'Rotation complète', 'Fais 3 vols dans la même journée.', 3, (rs) => maxPerDay(rs)],
  ['marathon', 'Journées', '🏃', 'Marathon des airs', 'Fais 5 vols dans la même journée.', 5, (rs) => maxPerDay(rs)],
  ['nuit', 'Journées', '🌙', 'Oiseau de nuit', 'Termine un vol entre 23 h et 5 h (heure de ton PC).', 1, (rs) => rs.filter((r) => { const h = hourLocal(r); return h >= 23 || h < 5; }).length],
  // carrière
  ['mission-1', 'Carrière', '📋', 'Mission accomplie', 'Valide ta première mission.', 1, (rs) => rs.filter((r) => r.mission && r.mission.validated).length],
  ['mission-10', 'Carrière', '🗂️', 'Pilote de confiance', 'Valide 10 missions.', 10, (rs) => rs.filter((r) => r.mission && r.mission.validated).length],
  ['grade-po', 'Carrière', '⭐', 'Premier Officier', 'Atteins le grade de Premier Officier.', 1, (rs, c) => (c && c.grade >= 2 ? 1 : 0)],
  ['grade-cdb', 'Carrière', '👨‍✈️', 'Commandant de bord', 'Atteins le grade de Commandant de bord.', 1, (rs, c) => (c && c.grade >= 3 ? 1 : 0)]
];
function maxPerDay(rs) {
  const n = {};
  for (const r of rs) { const d = String(r.date || '').slice(0, 10); n[d] = (n[d] || 0) + 1; }
  return Math.max(0, ...Object.values(n));
}

// reports : du plus récent au plus ancien (comme allReports) ; career : état de carrière (grade…)
function compute(reports, career) {
  const real = (reports || []).filter((r) => r && r.mode !== 'demo').slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return LIST.map(([id, cat, icon, title, desc, target, fn]) => {
    const value = Math.min(target, fn(real, career) || 0);
    let doneAt = null;
    if (value >= target) {
      // date du vol qui a débloqué le succès : premier préfixe chronologique qui atteint l'objectif
      for (let i = 0; i < real.length; i++) if ((fn(real.slice(0, i + 1), career) || 0) >= target) { doneAt = real[i].date; break; }
      if (!doneAt && real.length) doneAt = real[real.length - 1].date;
    }
    return { id, cat, icon, title, desc, target, value, done: value >= target, doneAt };
  });
}

module.exports = { compute, LIST };

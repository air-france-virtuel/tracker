'use strict';
// Lien avec Universal Announcer (logiciel gratuit d'annonces cabine pour MSFS) :
//  1. le tracker peut jouer les sons rangés dans le dossier « Announcements » d'Universal Announcer ;
//  2. le tracker peut copier les annonces importées par le pilote dans le dossier « LAT » d'Universal Announcer ;
//  3. pas de doublon : quand Universal Announcer tourne, c'est lui qui joue les sons, le tracker affiche seulement le texte.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const AIRLINE = 'LAT'; // code compagnie (indicatifs LAT123…) = nom du dossier dans Universal Announcer
const EXTS = ['.ogg', '.mp3', '.wav'];
// annonce du tracker -> fichier Universal Announcer joué au même moment du vol
const MAP = {
  boarding_welcome: 'BoardingWelcome',
  boarding_safety: 'SafetyBriefing',
  taxi_crew: 'ArmDoors',
  takeoff_crew: 'CrewSeatsTakeoff',
  cruise_seatbelt: 'AfterTakeoff',
  cruise_captain: 'TopOfClimbPilot',
  descent_start: 'DescentSeatbelts',
  approach_crew: 'CrewSeatsLanding',
  landing_welcome: 'AfterLanding',
  parking_deplane: 'DisembarkStarted'
};

// Universal Announcer garde ses réglages dans %APPDATA%\UniversalAnnouncer : on y cherche le chemin du dossier Announcements.
function findAnnouncements(env) {
  const e = env || process.env;
  if (!e.APPDATA) return null;
  const dir = path.join(e.APPDATA, 'UniversalAnnouncer');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(json|xml|ini|config|cfg|txt)$/i.test(f)); } catch (err) { return null; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (err) { continue; }
    const re = /([A-Za-z]:(?:\\\\|\\|\/)[^"'<>\r\n]*?Announcements)(?=["'<\r\n\\/]|$)/gi;
    let m;
    while ((m = re.exec(text))) {
      const p = m[1].replace(/\\\\/g, '\\');
      try { if (fs.statSync(p).isDirectory()) return p; } catch (err) { /* chemin périmé */ }
    }
  }
  return null;
}

// Fichier d'une annonce : dossier LAT d'abord, sinon Default. « BoardingWelcome.ogg », « BoardingWelcome[A320].ogg »…
function fileFor(root, uaName, aircraft) {
  if (!root || !uaName) return null;
  for (const folder of [AIRLINE, 'Default']) {
    let list = [];
    try { list = fs.readdirSync(path.join(root, folder)); } catch (err) { continue; }
    const found = list.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      if (!EXTS.includes(ext)) return false;
      const base = f.slice(0, -ext.length);
      return base.toLowerCase() === uaName.toLowerCase() || base.toLowerCase().startsWith(uaName.toLowerCase() + '[');
    });
    if (!found.length) continue;
    const ac = String(aircraft || '').toUpperCase();
    const tagged = ac ? found.filter((f) => f.toUpperCase().includes('[' + ac + ']')) : [];
    const plain = found.filter((f) => !/\[(?![0-9]+\])[^\]]+\]/.test(f)); // sans étiquette d'avion ni d'heure
    const pool = tagged.length ? tagged : (plain.length ? plain : found);
    return path.join(root, folder, pool[Math.floor(Math.random() * pool.length)]);
  }
  return null;
}

// Copie les annonces importées par le pilote dans Announcements\LAT, sous les noms d'Universal Announcer.
function exportPack(root, sounds) {
  if (!root) throw new Error('Dossier Announcements d’Universal Announcer introuvable.');
  const dest = path.join(root, AIRLINE);
  fs.mkdirSync(dest, { recursive: true });
  const done = []; const notOgg = [];
  for (const [key, uaName] of Object.entries(MAP)) {
    const s = sounds && sounds[key];
    if (!s || !s.file || !fs.existsSync(s.file)) continue;
    const ext = path.extname(s.file).toLowerCase();
    // on remplace l'ancienne version de cette annonce, quel que soit son format
    for (const f of fs.readdirSync(dest)) {
      const e = path.extname(f).toLowerCase();
      if (EXTS.includes(e) && f.slice(0, -e.length).toLowerCase() === uaName.toLowerCase()) fs.unlinkSync(path.join(dest, f));
    }
    fs.copyFileSync(s.file, path.join(dest, uaName + ext));
    done.push(uaName);
    if (ext !== '.ogg') notOgg.push(uaName);
  }
  return { folder: dest, copied: done, notOgg };
}

// Universal Announcer est-il lancé ? (Windows uniquement)
function isRunning(exec) {
  if (process.platform !== 'win32' && !exec) return Promise.resolve(false);
  const run = exec || execFile;
  return new Promise((resolve) => {
    run('tasklist', ['/FI', 'IMAGENAME eq UniversalAnnouncer.exe', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      resolve(!err && /UniversalAnnouncer\.exe/i.test(String(out || '')));
    });
  });
}

module.exports = { MAP, AIRLINE, findAnnouncements, fileFor, exportPack, isRunning };

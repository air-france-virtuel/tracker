'use strict';
// Génère les annonces sonores en voix neurale française (Microsoft Azure AI Speech).
// Usage :
//   AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=francecentral node tools/generer-voix.js
//   node tools/generer-voix.js --voix fr-FR-HenriNeural
//   node tools/generer-voix.js --essai          (écrit seulement le SSML, aucun appel réseau)
// Les fichiers sont écrits dans build-res/voix/<cle>.mp3 avec un manifest.json.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build-res', 'voix');
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const VOIX = arg('--voix', 'fr-FR-DeniseNeural');
const VITESSE = arg('--vitesse', '0%');
const ESSAI = args.includes('--essai');
const KEY = process.env.AZURE_SPEECH_KEY || '';
const REGION = process.env.AZURE_SPEECH_REGION || 'francecentral';

// Mêmes clés et textes que les annonces de l'application (renderer/app.js).
// Les parties variables (destination, altitude) deviennent des formulations générales,
// car un fichier audio ne peut pas changer de texte selon le vol.
const ANNONCES = [
  { key: 'boarding_welcome', text: 'Mesdames et messieurs, bonjour et bienvenue à bord de ce vol Les Ailes Françaises à destination de votre aéroport d’arrivée. Merci de ranger vos bagages et de prendre place.' },
  { key: 'boarding_safety', text: 'Nous allons vous présenter les consignes de sécurité. Merci de bien vouloir suivre la démonstration de l’équipage.' },
  { key: 'taxi_crew', text: 'Personnel navigant, préparation pour le départ. Mesdames et messieurs, veuillez attacher votre ceinture.' },
  { key: 'takeoff_crew', text: 'Personnel navigant, à vos places pour le décollage.' },
  { key: 'cruise_seatbelt', text: 'Le signal lumineux vient de s’éteindre. Vous pouvez détacher votre ceinture, mais nous vous conseillons de la garder attachée lorsque vous êtes assis.' },
  { key: 'cruise_captain', text: 'Ici votre commandant de bord. Nous volons à notre altitude de croisière. Le vol se déroule normalement. Bon voyage.' },
  { key: 'descent_start', text: 'Mesdames et messieurs, nous avons commencé notre descente vers notre destination. Merci de regagner votre siège et de relever votre tablette.' },
  { key: 'approach_crew', text: 'Personnel navigant, à vos places pour l’atterrissage.' },
  { key: 'landing_welcome', text: 'Mesdames et messieurs, bienvenue à destination. Merci de rester assis, ceinture attachée, jusqu’à l’arrêt complet de l’appareil.' },
  { key: 'parking_deplane', text: 'Nous sommes arrivés au parking. Merci d’avoir choisi Les Ailes Françaises. Nous vous souhaitons une excellente journée.' }
];

const echappe = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function ssml(texte) {
  return `<speak version="1.0" xml:lang="fr-FR"><voice xml:lang="fr-FR" name="${VOIX}"><prosody rate="${VITESSE}">${echappe(texte)}</prosody></voice></speak>`;
}

async function synthese(texte) {
  const url = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      'User-Agent': 'afv-tracker'
    },
    body: ssml(texte)
  });
  if (!r.ok) throw new Error(`Azure a répondu ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!ESSAI && !KEY) {
    console.error('Clé manquante : définis AZURE_SPEECH_KEY (ou lance avec --essai).');
    process.exit(1);
  }
  const manifest = { voix: VOIX, region: REGION, date: new Date().toISOString(), fichiers: {} };
  for (const a of ANNONCES) {
    if (ESSAI) {
      fs.writeFileSync(path.join(OUT, a.key + '.ssml'), ssml(a.text));
      console.log('SSML écrit :', a.key);
      continue;
    }
    const audio = await synthese(a.text);
    const fichier = a.key + '.mp3';
    fs.writeFileSync(path.join(OUT, fichier), audio);
    manifest.fichiers[a.key] = { fichier, texte: a.text };
    console.log('OK :', fichier, `(${Math.round(audio.length / 1024)} Ko)`);
  }
  if (!ESSAI) fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Terminé. Dossier :', OUT);
})().catch((e) => { console.error('Erreur :', e.message); process.exit(1); });

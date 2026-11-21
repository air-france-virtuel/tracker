'use strict';
/* global afv, Micro */
// Panneau de Max, par-dessus le simulateur : message en cours, derniers messages et check-list de la phase.
// Tout vient du tracker principal (qui garde la voix et les données du vol) ; les clics lui sont renvoyés.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let mini = false;
afv.on('max:data', (d) => {
  $('rt').textContent = d.route || 'Prêt quand tu l’es';
  $('ph').hidden = !d.phaseName; $('ph').textContent = (d.phaseName || '').toUpperCase();
  if (d.msg) $('msg').textContent = d.msg;
  $('say').classList.toggle('talk', !!d.talking);
  $('hist').innerHTML = (d.hist || []).map((h) => '<div>' + esc(h.time) + ' · ' + esc(h.text) + '</div>').join('');
  $('mute').setAttribute('aria-pressed', String(!!d.muted)); $('mute').textContent = d.muted ? '🔇' : '🔈';
  const ck = d.ck;
  if (ck) {
    const n = ck.items.filter((i) => i.done).length;
    $('ckT').textContent = 'CHECK-LIST · ' + ck.title.toUpperCase();
    $('ckN').textContent = n + ' / ' + ck.items.length;
    $('ck').innerHTML = ck.items.map((i) => '<li><button class="' + (i.done ? 'on' : '') + '" data-id="' + esc(i.id) + '" aria-pressed="' + i.done + '"><span class="box"></span><span title="' + esc(i.help || '') + '"><span class="tx">' + esc(i.text) + '</span>' + (i.help && !i.done ? '<span class="hp">' + esc(i.help) + '</span>' : '') +
      (i.done && i.by === 'sim' ? '<span class="sim">vu dans le simu</span>' : i.done && i.by === 'ann' ? '<span class="sim">annonce passée</span>' : '') + '</span></button></li>').join('');
    $('ckDone').hidden = !ck.complete;
  }
});
$('ck').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) afv.maxAction({ type: 'check', id: b.dataset.id }); });
$('ask').addEventListener('submit', (e) => { e.preventDefault(); const q = $('askIn').value.trim(); if (q) { afv.maxAction({ type: 'ask', q: q.slice(0, 160) }); $('askIn').value = ''; } });
$('mute').addEventListener('click', () => afv.maxAction({ type: 'mute' }));
$('close').addEventListener('click', () => afv.maxAction({ type: 'close' }));
$('mini').addEventListener('click', () => { mini = !mini; document.body.classList.toggle('mini', mini); $('mini').setAttribute('aria-pressed', String(mini)); afv.maxAction({ type: 'mini', on: mini }); });
// ---------- micro : on clique, on parle, Max répond ----------
const PH = $('askIn').placeholder;
let mic = null; let micBusy = false;
const micUi = (st, ph) => { $('mic').classList.toggle('rec', st === 'rec'); $('mic').classList.toggle('busy', st === 'busy'); $('mic').setAttribute('aria-pressed', String(st === 'rec')); $('askIn').placeholder = ph || PH; };
function micSetup(st) {
  $('micSet').hidden = false;
  if (st.downloading) { $('micSetTx').textContent = 'Téléchargement de la reconnaissance vocale : ' + (st.percent || 0) + ' %. Tu peux continuer à voler.'; $('micDl').hidden = true; $('micNo').textContent = 'Masquer'; }
  else { $('micSetTx').textContent = (st.error ? 'Le téléchargement a échoué (' + st.error + '). ' : '') + 'Pour t’écouter, je dois télécharger la reconnaissance vocale (environ ' + (st.sizeMb || 640) + ' Mo, une seule fois). Elle fonctionne ensuite sans Internet.'; $('micDl').hidden = false; $('micDl').textContent = st.error ? 'Réessayer' : 'Télécharger'; $('micNo').textContent = 'Plus tard'; }
}
afv.on('ecoute:status', (st) => {
  if ($('micSet').hidden) return;
  if (st.installed && !st.downloading) { $('micSet').hidden = true; micUi('', 'C’est prêt : clique sur le micro et parle-moi.'); setTimeout(() => micUi(''), 6000); } else micSetup(st);
});
$('micDl').addEventListener('click', () => { afv.ecouteDownload(); micSetup({ downloading: true, percent: 0 }); });
$('micNo').addEventListener('click', () => { $('micSet').hidden = true; });
async function heard(samples, rate) {
  mic = null;
  if (!samples) { micUi('', 'Je n’ai rien entendu. Clique sur le micro et parle.'); setTimeout(() => micUi(''), 4000); return; }
  micBusy = true; micUi('busy', 'Je réfléchis…');
  const r = await afv.ecouteText(Array.from(samples), rate);
  micBusy = false;
  if (r && r.text) { micUi(''); afv.maxAction({ type: 'ask', q: r.text.slice(0, 160), voice: true }); }
  else { micUi('', r && r.error ? 'Écoute impossible : ' + r.error : 'Je n’ai pas compris. Réessaie.'); setTimeout(() => micUi(''), 5000); }
}
$('mic').addEventListener('click', async () => {
  if (micBusy) return;
  if (mic) { mic.stop(); return; } // deuxième clic : j'ai fini de parler
  const st = await afv.ecouteStatus();
  if (!st.installed) { micSetup(st); return; }
  afv.maxAction({ type: 'listen' }); // Max se tait pour ne pas s'entendre lui-même
  afv.ecouteWarm();
  try { micUi('rec', 'Je t’écoute… (clique encore quand tu as fini)'); mic = await Micro.listen(heard); }
  catch (e) { mic = null; micUi('', 'Micro introuvable ou bloqué : vérifie le micro dans les paramètres de confidentialité de Windows.'); setTimeout(() => micUi(''), 7000); }
});
afv.maxAction({ type: 'ready' });

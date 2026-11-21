'use strict';
/* global afv */
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
afv.maxAction({ type: 'ready' });

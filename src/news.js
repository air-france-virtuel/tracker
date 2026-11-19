'use strict';
// Actualité Air France pour « Infos du jour » :
// 1) flux RSS officiel de la salle de presse Air France (français, puis anglais)
// 2) en secours, Google Actualités (recherche « Air France », en français)
// On n'affiche que les titres, la date, la source et le lien vers l'article d'origine.

const SOURCES = [
  { url: 'https://corporate.airfrance.com/fr/rss-subscription', name: 'Air France (salle de presse)' },
  { url: 'https://corporate.airfrance.com/en/rss-subscription', name: 'Air France (newsroom)' },
  { url: 'https://news.google.com/rss/search?q=%22Air+France%22+when:7d&hl=fr&gl=FR&ceid=FR:fr', name: 'Google Actualités' }
];
const CACHE_MS = 30 * 60 * 1000;
const UA = 'AFV-Tracker (+https://github.com/air-france-virtuel/tracker)';
let http = (url, o) => fetch(url, o);
function setFetch(fn) { if (typeof fn === 'function') http = fn; }
let cache = null;

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block); return m ? m[1] : ''; };

function parseRss(xml, sourceName) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 20) {
    const b = m[0];
    let title = decode(tag(b, 'title'));
    let link = decode(tag(b, 'link'));
    if (!link) { const g = /<link[^>]*href="([^"]+)"/i.exec(b); link = g ? g[1] : ''; }
    const date = Date.parse(decode(tag(b, 'pubDate')) || decode(tag(b, 'dc:date')));
    let source = decode(tag(b, 'source')) || sourceName;
    // Google Actualités ajoute « - Nom du journal » à la fin du titre
    if (sourceName === 'Google Actualités' && source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    let summary = sourceName === 'Google Actualités' ? '' : decode(tag(b, 'description'));
    if (summary.length > 170) summary = summary.slice(0, 167).replace(/\s+\S*$/, '') + '…';
    if (title && /^https:\/\//.test(link)) items.push({ title, link, date: Number.isFinite(date) ? date : null, source, summary });
  }
  return items;
}

async function news(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const errors = [];
  for (const s of SOURCES) {
    try {
      const r = await http(s.url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const items = parseRss(await r.text(), s.name);
      if (!items.length) throw new Error('flux vide');
      items.sort((a, b) => (b.date || 0) - (a.date || 0));
      cache = { at: Date.now(), source: s.name, items: items.slice(0, 6), error: '' };
      return cache;
    } catch (e) { errors.push(s.name + ' : ' + String((e && e.message) || e).slice(0, 60)); }
  }
  return Object.assign({}, cache || { items: [] }, { error: 'Actualité indisponible pour le moment.', detail: errors.join(' · ') });
}

module.exports = { news, parseRss, setFetch };

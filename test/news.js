// Test du lecteur d'actualité (flux simulés, sans réseau).
const assert = require('assert');
const { parseRss, news, setFetch } = require('../src/news');
const official = `<?xml version="1.0"?><rss><channel><item><title>Air France renforce son réseau &amp; ses vols</title><link>https://corporate.airfrance.com/fr/actualites/a</link><pubDate>Tue, 17 Nov 2026 09:00:00 +0100</pubDate><description><![CDATA[<p>Pour l’hiver, Air France ajoute de nouvelles destinations.</p>]]></description></item>
<item><title>Deuxième actualité</title><link>https://corporate.airfrance.com/fr/actualites/b</link><pubDate>Mon, 16 Nov 2026 09:00:00 +0100</pubDate></item></channel></rss>`;
const google = `<rss><channel><item><title>Air France : un nouvel avion - Le Journal</title><link>https://news.google.com/x</link><pubDate>Wed, 18 Nov 2026 10:00:00 GMT</pubDate><source url="https://j.fr">Le Journal</source></item></channel></rss>`;
const a = parseRss(official, 'Air France (salle de presse)');
assert.strictEqual(a.length, 2);
assert.strictEqual(a[0].title, 'Air France renforce son réseau & ses vols');
assert.strictEqual(a[0].summary, 'Pour l’hiver, Air France ajoute de nouvelles destinations.');
const g = parseRss(google, 'Google Actualités');
assert.deepStrictEqual([g[0].title, g[0].source, g[0].summary], ['Air France : un nouvel avion', 'Le Journal', '']);
(async () => {
  setFetch(async (url) => (url.includes('corporate') ? { ok: false, status: 403 } : { ok: true, status: 200, text: async () => google }));
  const r = await news(true);
  assert.strictEqual(r.source, 'Google Actualités', 'secours si le flux officiel est refusé');
  assert.strictEqual(r.items.length, 1);
  console.log('ACTUALITÉ : TOUS LES TESTS PASSENT');
})().catch((e) => { console.error(e); process.exit(1); });

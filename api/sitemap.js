// Sitemap automatica di ChairShare: servita come https://chairshare.it/sitemap.xml (vedi vercel.json).
// Si aggiorna da sola: legge dal database le categorie, le città e gli annunci attivi.
const BASE = 'https://chairshare.it';
const SUPABASE_URL = 'https://eyghtnxuhxdyqsayjygi.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV5Z2h0bnh1aHhkeXFzYXlqeWdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0Njc3NDgsImV4cCI6MjEwNzA0Mzc0OH0.uzupM1khyMAshMfgmGqjITPBLCr0t72pEirryibTyMY';

const CATEGORIE = ['barbiere', 'estetica', 'massaggi', 'psicoterapia', 'fotografia', 'coworking', 'scrivania', 'ufficio', 'sala_riunioni'];

function slug(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function giorno(d) { const x = new Date(d); return isNaN(x) ? null : x.toISOString().slice(0, 10); }

function costruisci(spazi) {
  const urls = new Map(); // loc -> { lastmod, priority, changefreq }
  const aggiungi = (path, lastmod, priority, changefreq) => {
    const loc = BASE + path;
    const prev = urls.get(loc);
    if (!prev || (lastmod && (!prev.lastmod || lastmod > prev.lastmod))) urls.set(loc, { lastmod: lastmod || (prev && prev.lastmod) || null, priority, changefreq });
  };
  const ultimo = spazi.map(s => giorno(s.created_at)).filter(Boolean).sort().pop() || null;
  aggiungi('/', ultimo, '1.0', 'daily');
  const perCat = new Set(spazi.map(s => s.type));
  if (spazi.some(s => ['scrivania', 'ufficio', 'sala_riunioni', 'coworking'].includes(s.type))) aggiungi('/?macro=uffici', ultimo, '0.7', 'daily');
  spazi.forEach(s => {
    const lm = giorno(s.created_at);
    if (CATEGORIE.includes(s.type)) {
      aggiungi('/?cat=' + s.type, lm, '0.8', 'daily');
      const c = slug(s.city);
      if (c.length >= 2) aggiungi('/?cat=' + s.type + '&city=' + c, lm, '0.7', 'weekly');
    }
    if (s.id) aggiungi('/?spazio=' + s.id, lm, '0.6', 'weekly');
  });
  const righe = [...urls.entries()].map(([loc, u]) =>
    '  <url>\n    <loc>' + esc(loc) + '</loc>\n' + (u.lastmod ? '    <lastmod>' + u.lastmod + '</lastmod>\n' : '') +
    '    <changefreq>' + u.changefreq + '</changefreq>\n    <priority>' + u.priority + '</priority>\n  </url>');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + righe.join('\n') + '\n</urlset>\n';
}

async function caricaSpazi() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/spaces?select=id,type,city,created_at&active=eq.true&order=created_at.desc&limit=5000', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }
  });
  if (!r.ok) throw new Error('Supabase ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  let xml;
  try {
    xml = costruisci(await caricaSpazi());
  } catch (e) {
    console.error('Sitemap: database non raggiungibile, uso la versione minima', e && e.message);
    xml = costruisci([]);
  }
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(xml);
};
module.exports.costruisci = costruisci;

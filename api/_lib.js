// Funzioni di servizio condivise dalle API dei pagamenti (il file con "_" non diventa un indirizzo pubblico).
// Nessuna dipendenza esterna: Stripe e Supabase si chiamano con fetch.
//
// Variabili da impostare su Vercel (Settings > Environment Variables). Non vanno MAI nel codice o su GitHub:
//   STRIPE_SECRET_KEY            chiave privata Stripe (sk_test_... in prova, sk_live_... dopo)
//   STRIPE_WEBHOOK_SECRET        firma del webhook (whsec_...)
//   SUPABASE_SERVICE_ROLE_KEY    chiave "service_role" di Supabase (Project Settings > API)
// Facoltative:
//   COMMISSIONE_PERCENTO         commissione ChairShare, default 10
//   SITE_URL                     default https://chairshare.it
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://eyghtnxuhxdyqsayjygi.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV5Z2h0bnh1aHhkeXFzYXlqeWdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0Njc3NDgsImV4cCI6MjEwNzA0Mzc0OH0.uzupM1khyMAshMfgmGqjITPBLCr0t72pEirryibTyMY';
const SITE = (process.env.SITE_URL || 'https://chairshare.it').replace(/\/$/, '');
const COMMISSIONE = (() => { const n = Number(process.env.COMMISSIONE_PERCENTO || 10); return n > 0 && n < 50 ? n : 10; })();

function env(nome) {
  const v = process.env[nome];
  if (!v) { const e = new Error('CONFIG_MANCANTE ' + nome); e.config = true; throw e; }
  return v;
}

// Stripe vuole i dati come "a[b][c]=1"; gli elenchi di valori semplici diventano "a[]=x&a[]=y"
function codifica(obj, prefisso, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const chiave = prefisso ? prefisso + '[' + k + ']' : k;
    if (Array.isArray(v)) {
      if (v.every(x => x === null || typeof x !== 'object')) v.forEach(x => out.push([chiave + '[]', String(x)]));
      else v.forEach((x, i) => codifica({ [i]: x }, chiave, out));
    } else if (typeof v === 'object') codifica(v, chiave, out);
    else out.push([chiave, String(v)]);
  }
  return out;
}

async function stripe(metodo, percorso, params, idempotenza) {
  const coppie = codifica(params, '', []);
  const corpo = new URLSearchParams(coppie).toString();
  const headers = { Authorization: 'Bearer ' + env('STRIPE_SECRET_KEY') };
  let url = 'https://api.stripe.com/v1' + percorso;
  const opts = { method: metodo, headers };
  if (metodo === 'GET') { if (corpo) url += '?' + corpo; }
  else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = corpo; if (idempotenza) headers['Idempotency-Key'] = idempotenza; }
  const r = await fetch(url, opts);
  const dati = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error('STRIPE ' + ((dati.error && (dati.error.code || dati.error.type)) || r.status) + ': ' + ((dati.error && dati.error.message) || ''));
    e.stripe = true; e.status = r.status; throw e;
  }
  return dati;
}

// Stripe API v2 (account collegati): richieste in JSON
async function stripeV2(metodo, percorso, corpo, idempotenza) {
  const headers = { Authorization: 'Bearer ' + env('STRIPE_SECRET_KEY'), 'Stripe-Version': '2026-10-28.endive', 'Content-Type': 'application/json' };
  if (idempotenza) headers['Idempotency-Key'] = idempotenza;
  const r = await fetch('https://api.stripe.com' + percorso, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const dati = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error('STRIPE ' + ((dati.error && (dati.error.code || dati.error.type)) || r.status) + ': ' + ((dati.error && dati.error.message) || ''));
    e.stripe = true; e.status = r.status; throw e;
  }
  return dati;
}

// Supabase con la chiave di servizio (solo sul server)
async function sb(percorso, opts) {
  const chiave = env('SUPABASE_SERVICE_ROLE_KEY');
  const o = opts || {};
  const r = await fetch(SUPABASE_URL + '/rest/v1' + percorso, {
    method: o.method || 'GET',
    headers: Object.assign({ apikey: chiave, Authorization: 'Bearer ' + chiave, 'Content-Type': 'application/json' }, o.headers || {}),
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  const testo = await r.text();
  let dati = null; try { dati = testo ? JSON.parse(testo) : null; } catch (e) { dati = testo; }
  if (!r.ok) { const e = new Error((dati && dati.message) || ('SUPABASE ' + r.status)); e.db = true; e.dbCode = dati && dati.code; throw e; }
  return dati;
}
const rpc = (nome, args) => sb('/rpc/' + nome, { method: 'POST', body: args || {} });
const aggiorna = (tabellaEFiltro, campi) => sb('/' + tabellaEFiltro, { method: 'PATCH', body: campi, headers: { Prefer: 'return=minimal' } });

// Chi sta chiamando? Si verifica il token dell'utente con Supabase (mai fidarsi dei dati inviati dal browser)
async function utente(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + m[1] } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? { id: u.id, email: u.email || '' } : null;
}

async function corpoJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const testo = typeof req.body === 'string' ? req.body : (await corpoGrezzo(req));
  try { return testo ? JSON.parse(testo) : {}; } catch (e) { return {}; }
}
function corpoGrezzo(req) {
  return new Promise((ok, ko) => {
    const pezzi = []; let tot = 0;
    req.on('data', c => { tot += c.length; if (tot > 1e6) { ko(new Error('TROPPO_GRANDE')); req.destroy(); } else pezzi.push(c); });
    req.on('end', () => ok(Buffer.concat(pezzi).toString('utf8')));
    req.on('error', ko);
  });
}

function rispondi(res, stato, obj) {
  res.statusCode = stato;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
// Errori noti del database/Stripe -> risposta chiara per il sito
function gestisciErrore(res, e) {
  if (e && e.config) { console.error(e.message); return rispondi(res, 503, { error: 'PAGAMENTI_NON_CONFIGURATI' }); }
  if (e && e.db && /^[A-Z_]{4,}$/.test(String(e.message))) return rispondi(res, 400, { error: e.message });
  console.error(e && e.stack || e);
  return rispondi(res, e && e.stripe ? 502 : 500, { error: e && e.stripe ? 'STRIPE_ERRORE' : 'ERRORE_SERVER' });
}

// Firma dei webhook Stripe: HMAC-SHA256 di "timestamp.corpo" con il segreto del webhook
function verificaFirma(corpo, intestazione, segreto, tolleranza) {
  if (!intestazione || !segreto) return false;
  let t = null; const firme = [];
  String(intestazione).split(',').forEach(p => { const i = p.indexOf('='); if (i < 0) return; const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (k === 't') t = v; else if (k === 'v1') firme.push(v); });
  if (!t || !firme.length) return false;
  const tol = tolleranza === undefined ? 300 : tolleranza;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > tol) return false;
  const atteso = Buffer.from(crypto.createHmac('sha256', segreto).update(t + '.' + corpo, 'utf8').digest('hex'));
  return firme.some(f => { const b = Buffer.from(f); return b.length === atteso.length && crypto.timingSafeEqual(b, atteso); });
}

module.exports = { SITE, COMMISSIONE, env, codifica, stripe, stripeV2, sb, rpc, aggiorna, utente, corpoJson, corpoGrezzo, rispondi, gestisciErrore, verificaFirma };

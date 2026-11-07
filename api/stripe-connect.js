// Collegamento dell'Host a Stripe (account Express): crea l'account, dà il link di verifica e lo stato.
// POST /api/stripe-connect   { "azione": "stato" | "collega" | "dashboard" }   (con il token dell'utente)
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return L.rispondi(res, 405, { error: 'METODO_NON_AMMESSO' });
    const u = await L.utente(req);
    if (!u) return L.rispondi(res, 401, { error: 'NON_AUTENTICATO' });
    const b = await L.corpoJson(req);
    const azione = ['stato', 'collega', 'dashboard'].includes(b.azione) ? b.azione : 'stato';

    const prof = (await L.sb('/profiles?id=eq.' + u.id + '&select=role'))[0];
    if (!prof || prof.role !== 'host') return L.rispondi(res, 403, { error: 'SOLO_HOST' });

    let riga = (await L.sb('/host_stripe?user_id=eq.' + u.id + '&select=*'))[0];
    if (!riga) {
      if (azione === 'stato') return L.rispondi(res, 200, { collegato: false, charges_enabled: false, details_submitted: false, payouts_enabled: false });
      // Account collegato con l'API v2 (la v1 non è più accettata da Stripe per le nuove integrazioni):
      // dashboard Express, commissioni e perdite a carico della piattaforma, incassi con carta e ricezione dei trasferimenti
      const acc = await L.stripeV2('POST', '/v2/core/accounts', {
        contact_email: u.email || undefined,
        identity: { country: 'IT' },
        dashboard: 'express',
        defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
        configuration: {
          merchant: { capabilities: { card_payments: { requested: true } } },
          recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } }
        },
        metadata: { user_id: u.id }
      }, 'acct-' + u.id + '-' + Math.floor(Date.now() / 60000)); // la chiave cambia ogni minuto: evita doppioni da doppio clic, ma un errore passato non resta "memorizzato" da Stripe
      await L.sb('/host_stripe?on_conflict=user_id', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: { user_id: u.id, stripe_account_id: acc.id }
      });
      riga = (await L.sb('/host_stripe?user_id=eq.' + u.id + '&select=*'))[0];
    }

    // stato aggiornato direttamente da Stripe (non serve un webhook dedicato).
    // Un ID di account v2 si può passare all'endpoint v1: la risposta ha i campi charges_enabled, details_submitted, payouts_enabled
    const acc = await L.stripe('GET', '/accounts/' + riga.stripe_account_id, {});
    const nuovo = { details_submitted: !!acc.details_submitted, charges_enabled: !!acc.charges_enabled, payouts_enabled: !!acc.payouts_enabled, updated_at: new Date().toISOString() };
    await L.aggiorna('host_stripe?user_id=eq.' + u.id, nuovo);

    if (azione === 'collega' && !(nuovo.charges_enabled && nuovo.details_submitted)) {
      const link = await L.stripeV2('POST', '/v2/core/account_links', {
        account: riga.stripe_account_id,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            collection_options: { fields: 'eventually_due' }, // raccoglie subito tutti i dati richiesti
            refresh_url: L.SITE + '/?stripe=riprova', return_url: L.SITE + '/?stripe=ok'
          }
        }
      });
      return L.rispondi(res, 200, Object.assign({ collegato: true, url: link.url }, nuovo));
    }
    if (azione === 'dashboard' && nuovo.details_submitted) {
      const login = await L.stripe('POST', '/accounts/' + riga.stripe_account_id + '/login_links', {});
      return L.rispondi(res, 200, Object.assign({ collegato: true, url: login.url }, nuovo));
    }
    return L.rispondi(res, 200, Object.assign({ collegato: true }, nuovo));
  } catch (e) { return L.gestisciErrore(res, e); }
};

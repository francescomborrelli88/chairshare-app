// Avvia il pagamento di una postazione: tiene la fascia per 35 minuti e crea la pagina di pagamento Stripe.
// Importi e commissione sono calcolati dal database: il browser non può cambiarli.
// POST /api/stripe-checkout   { "space_id", "day": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM" }
const L = require('./_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIORNO = /^\d{4}-\d{2}-\d{2}$/;
const ORA = /^([01]\d|2[0-3]):00$/;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return L.rispondi(res, 405, { error: 'METODO_NON_AMMESSO' });
    const u = await L.utente(req);
    if (!u) return L.rispondi(res, 401, { error: 'NON_AUTENTICATO' });
    const b = await L.corpoJson(req);
    if (!UUID.test(String(b.space_id)) || !GIORNO.test(String(b.day)) || !ORA.test(String(b.start)) || !ORA.test(String(b.end))) {
      return L.rispondi(res, 400, { error: 'DATI_NON_VALIDI' });
    }
    const fine = b.end;

    // 1) tiene la fascia (controlli su orari, posti, Host collegato a Stripe, importo)
    const r = await L.rpc('reserve_paid_slot', { p_user: u.id, p_space: b.space_id, p_day: b.day, p_start: b.start, p_end: fine, p_fee_pct: L.COMMISSIONE });
    for (const s of (r.to_expire || [])) { try { await L.stripe('POST', '/checkout/sessions/' + s + '/expire', {}); } catch (e) { /* già chiusa */ } }

    // 2) conto Stripe dell'Host
    const host = (await L.sb('/host_stripe?user_id=eq.' + r.host_id + '&select=stripe_account_id,charges_enabled'))[0];
    if (!host || !host.charges_enabled) {
      await L.aggiorna('space_payments?id=eq.' + r.payment_id, { status: 'expired' });
      return L.rispondi(res, 400, { error: 'HOST_NON_PRONTO' });
    }

    // 3) pagina di pagamento: il 100% va a ChairShare, che trasferisce all'Host il netto della commissione
    let sessione;
    try {
      sessione = await L.stripe('POST', '/checkout/sessions', {
        mode: 'payment', locale: 'it',
        success_url: L.SITE + '/?pagamento=ok',
        cancel_url: L.SITE + '/?pagamento=annullato',
        client_reference_id: r.payment_id,
        customer_email: u.email || undefined,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        metadata: { payment_id: r.payment_id },
        line_items: [{
          quantity: 1,
          price_data: { currency: 'eur', unit_amount: r.amount_cents, product_data: { name: 'Postazione - ' + r.space_name + ' - ' + b.day + ' ' + b.start + '/' + fine } }
        }],
        payment_intent_data: {
          application_fee_amount: r.fee_cents,
          transfer_data: { destination: host.stripe_account_id },
          metadata: { payment_id: r.payment_id },
          description: 'ChairShare - ' + r.space_name + ' ' + b.day
        }
      }, 'chk-' + r.payment_id);
    } catch (e) {
      await L.aggiorna('space_payments?id=eq.' + r.payment_id, { status: 'expired' });
      throw e;
    }
    await L.aggiorna('space_payments?id=eq.' + r.payment_id, { stripe_session_id: sessione.id });
    return L.rispondi(res, 200, { url: sessione.url, payment_id: r.payment_id, amount_cents: r.amount_cents });
  } catch (e) { return L.gestisciErrore(res, e); }
};

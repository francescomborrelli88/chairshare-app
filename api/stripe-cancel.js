// Annullamento di una postazione pagata, con rimborso.
//   Annulla il professionista (oltre 24 ore prima): rimborsa l'importo senza la commissione ChairShare, che resta a ChairShare.
//   Annulla l'Host: rimborso totale, commissione compresa.
// POST /api/stripe-cancel   { "block_id": "..." }
const L = require('./_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return L.rispondi(res, 405, { error: 'METODO_NON_AMMESSO' });
    const u = await L.utente(req);
    if (!u) return L.rispondi(res, 401, { error: 'NON_AUTENTICATO' });
    const b = await L.corpoJson(req);
    if (!UUID.test(String(b.block_id))) return L.rispondi(res, 400, { error: 'DATI_NON_VALIDI' });

    const pag = (await L.sb('/space_payments?block_id=eq.' + b.block_id + '&status=eq.paid&select=id'))[0];
    if (!pag) return L.rispondi(res, 404, { error: 'PAGAMENTO_NON_TROVATO' });

    // regole (24 ore, appuntamenti, chi può annullare)
    const c = await L.rpc('precheck_cancel_paid', { p_payment: pag.id, p_actor: u.id });
    if (!c.payment_intent) return L.rispondi(res, 409, { error: 'PAGAMENTO_NON_TROVATO' });

    let rimborsato, motivo;
    if (c.role === 'host') {
      // rimborso totale, anche la commissione
      await L.stripe('POST', '/refunds', { payment_intent: c.payment_intent, reverse_transfer: true, refund_application_fee: true, metadata: { payment_id: pag.id, motivo: 'annullo_host' } }, 'ref-' + pag.id);
      rimborsato = c.amount_cents; motivo = 'annullo_host';
    } else {
      // il professionista riceve l'importo senza la commissione: prima si recupera dall'Host la sua quota, poi si rimborsa
      const quotaHost = c.amount_cents - c.fee_cents;
      const pi = await L.stripe('GET', '/payment_intents/' + c.payment_intent, { expand: ['latest_charge'] });
      const trasferimento = pi.latest_charge && pi.latest_charge.transfer;
      if (!trasferimento) throw Object.assign(new Error('TRASFERIMENTO_NON_TROVATO'), { stripe: true });
      await L.stripe('POST', '/transfers/' + trasferimento + '/reversals', { amount: quotaHost, metadata: { payment_id: pag.id } }, 'rev-' + pag.id);
      try {
        await L.stripe('POST', '/refunds', { payment_intent: c.payment_intent, amount: quotaHost, metadata: { payment_id: pag.id, motivo: 'annullo_professionista' } }, 'ref-' + pag.id);
      } catch (e) {
        await L.aggiorna('space_payments?id=eq.' + pag.id, { status: 'refund_error', refund_reason: 'rimborso non riuscito dopo il recupero della quota Host' });
        throw e;
      }
      rimborsato = quotaHost; motivo = 'annullo_professionista';
    }
    await L.rpc('finalize_cancel_paid', { p_payment: pag.id, p_refunded: rimborsato, p_reason: motivo });
    return L.rispondi(res, 200, { ok: true, rimborsato_cents: rimborsato, ruolo: c.role });
  } catch (e) { return L.gestisciErrore(res, e); }
};

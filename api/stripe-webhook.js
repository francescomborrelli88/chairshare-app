// Riceve gli avvisi di Stripe. La prenotazione si conferma SOLO qui, a pagamento riuscito (payment_intent.succeeded).
// In Stripe (Sviluppatori > Webhook) aggiungi l'indirizzo  https://chairshare.it/api/stripe-webhook
// con gli eventi: payment_intent.succeeded, checkout.session.expired, charge.refunded
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return L.rispondi(res, 405, { error: 'METODO_NON_AMMESSO' });
    const grezzo = await L.corpoGrezzo(req);
    if (!L.verificaFirma(grezzo, req.headers['stripe-signature'], L.env('STRIPE_WEBHOOK_SECRET'))) {
      return L.rispondi(res, 400, { error: 'FIRMA_NON_VALIDA' });
    }
    const evento = JSON.parse(grezzo);
    const ogg = evento.data && evento.data.object ? evento.data.object : {};

    if (evento.type === 'payment_intent.succeeded') {
      const pid = ogg.metadata && ogg.metadata.payment_id;
      if (!pid) return L.rispondi(res, 200, { ignorato: true });
      try {
        await L.rpc('confirm_paid_slot', { p_payment: pid, p_pi: ogg.id });
      } catch (e) {
        const m = String(e.message || '');
        if (m.includes('CONFLITTO')) {
          // pagamento arrivato quando la fascia non era più libera: rimborso totale automatico
          await L.stripe('POST', '/refunds', { payment_intent: ogg.id, reverse_transfer: true, refund_application_fee: true, metadata: { payment_id: pid, motivo: 'conflitto' } }, 'conf-' + pid);
          await L.aggiorna('space_payments?id=eq.' + pid, { status: 'refunded', refunded_cents: ogg.amount_received || ogg.amount || 0, refund_reason: 'conflitto_fascia', stripe_payment_intent: ogg.id });
          return L.rispondi(res, 200, { rimborsato: true });
        }
        if (m.includes('PAGAMENTO_CHIUSO') || m.includes('PAGAMENTO_NON_TROVATO')) return L.rispondi(res, 200, { ignorato: true });
        throw e; // Stripe riprova più tardi
      }
    } else if (evento.type === 'checkout.session.expired') {
      await L.aggiorna('space_payments?stripe_session_id=eq.' + encodeURIComponent(ogg.id) + '&status=eq.pending', { status: 'expired' });
    } else if (evento.type === 'charge.refunded') {
      if (ogg.payment_intent) await L.aggiorna('space_payments?stripe_payment_intent=eq.' + encodeURIComponent(ogg.payment_intent), { refunded_cents: ogg.amount_refunded || 0 });
    }
    return L.rispondi(res, 200, { ricevuto: true });
  } catch (e) { return L.gestisciErrore(res, e); }
};

// serve il corpo "grezzo" per verificare la firma
module.exports.config = { api: { bodyParser: false } };

const { normalizeInboundText } = require('./inbound-message-policy');

function isPaymentProofClarification(message, history) {
  const receipt = history.findLast(entry => entry.direction === 'outbound');
  if (!/^✅\s*¡?(?:comprobante recibido|recibimos tu comprobante)\b/i.test(receipt?.content || '')) return false;

  const text = normalizeInboundText(message).replace(/[.,!]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Consume the whole statement so a second request or a question keeps its normal routing.
  const action = /^(?:ya )?(?:transferi|deposite|pague|(?:lo|la) (?:realice|hice|pague)|(?:realice|hice) (?:el pago|la transferencia))\b/;
  const when = /^(?:el mismo dia|ese (?:mismo )?dia|hoy|ayer|anoche)\b/;
  const account = /^(?:pero )?(?:fue )?(?:desde |con |de )?(?:la|otra|mi) cuenta(?: bancaria)?(?: de mi (?:hij[oa]|espos[oa]|pareja|herman[oa]|mama|papa|madre|padre))?$/;
  const payer = /^mi (?:hij[oa]|espos[oa]|pareja|herman[oa]|mama|papa|madre|padre) (?:hizo la transferencia|pago|transfirio)$/;
  if (account.test(text) || payer.test(text)) return true;
  if (!action.test(text)) return false;
  const detail = text.replace(action, '').trim().replace(when, '').trim();
  return detail === '' || account.test(detail);
}

function isDeliveredOrder(order) {
  if (!order) return false;
  return order.is_delivered === true
    || order.is_delivered === 'true'
    || ['entregado', 'paid'].includes(String(order.status || '').toLowerCase())
    || !!order.delivered_at;
}

function buildPaymentProofReply({ order, amountMatches, amountText = '', firstName = '' }) {
  const delivered = isDeliveredOrder(order);
  const hi = firstName ? ` ${firstName}` : '';

  if (delivered) {
    const ref = `tu pedido #DR-${order.id}`;
    if (amountMatches === true) {
      return `✅ ¡Comprobante recibido${hi}! El pago de ${amountText} por ${ref} quedó registrado. ¡Muchas gracias! 🙌`;
    }
    if (amountMatches === false) {
      return `✅ Recibimos tu comprobante${hi}. El monto (${amountText}) no coincide con ${ref} ($${Number(order.total_price).toLocaleString('es-CL')}), así que el equipo lo revisa y te confirma por acá 🔍`;
    }
    return `✅ ¡Recibimos tu comprobante${hi}! Lo dejamos registrado para ${ref} y te confirmamos en cuanto lo verifiquemos. ¡Gracias! 🙌`;
  }

  if (amountMatches === true) {
    return `✅ ¡Comprobante recibido${hi}! Tu pago de ${amountText} quedó registrado. Te avisaremos por aquí cuando haya novedades de tu pedido.`;
  }
  if (amountMatches === false) {
    return `✅ Recibimos tu comprobante${hi}. Detectamos una diferencia en el monto, así que el equipo lo revisará y te confirmará por aquí 🔍`;
  }
  return `✅ ¡Recibimos tu comprobante de pago${hi}! Lo verificaremos a la brevedad y te confirmaremos por aquí. ¡Gracias!`;
}

module.exports = { isDeliveredOrder, buildPaymentProofReply, isPaymentProofClarification };

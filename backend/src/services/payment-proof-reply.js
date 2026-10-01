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
    const ref = `tu pedido #${order.id}`;
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

module.exports = { isDeliveredOrder, buildPaymentProofReply };

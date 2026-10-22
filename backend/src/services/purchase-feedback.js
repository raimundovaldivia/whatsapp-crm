'use strict';

const ACTIVE_STATES = new Set(['exploring', 'interested', 'future_interest', 'template_sent']);

function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOptOut(text) {
  return /\b(no me (?:escriban|contacten)|no quiero (?:mas )?mensajes|dejen de escribir|dar de baja|eliminar mi numero)\b/.test(text);
}

function isRenewedPurchase(text) {
  return /\b(ahora si|si quiero|quiero comprar|quiero pedir|deme|dame|mandame|enviame|anotame|agregame|hacer (?:un )?pedido)\b/.test(text);
}

function initialSignal(value) {
  const text = normalize(value);
  if (!text || isOptOut(text)) return null;
  if (/\b(ya )?(compre|compramos|lo compre).{0,55}\b(otro medio|otro lado|otra parte|otra tienda|otro proveedor)\b/.test(text)) {
    return 'competitor';
  }
  if (/\b(ya no necesito|no necesito|no requiero|no lo (?:tomare|quiero)|por (?:ahora|el momento) no lo (?:tomare|quiero)|no voy a (?:comprar|querer)(?: por ahora)?)\b/.test(text)) {
    return 'no_need';
  }
  return null;
}

function reasonFromAnswer(value) {
  const text = normalize(value);
  if (!text) return null;
  if (/\b(precio|caro|costoso|presupuesto|no me alcanza)\b/.test(text)) return 'price';
  if (/\b(despacho|envio|reparto|entrega|ubicacion|distancia|muy lejos)\b/.test(text)) return 'delivery';
  if (/\b(disponibilidad|sin stock|no habia|no tienen|se acabo)\b/.test(text)) return 'stock';
  if (/\b(producto|tamano|calidad|formato|variedad)\b/.test(text)) return 'stock';
  if (/\b(pago|transferencia|efectivo|tarjeta)\b/.test(text)) return 'payment';
  if (/\b(atencion|servicio|trato|respuesta|demora|se demoraron)\b/.test(text)) return 'service';
  if (/\b(otro proveedor|otra tienda|otro medio|otro lado|otra parte)\b/.test(text)) return 'competitor';
  return null;
}

function affirmative(value) {
  const text = normalize(value);
  return /^(si|claro|por supuesto|obvio|probablemente|puede ser|quizas|tal vez)(\b|$)/.test(text);
}

function negative(value) {
  const text = normalize(value);
  return /^(no|nop|no creo|definitivamente no)(\b|$)/.test(text);
}

function draftWithFeedback(draft, feedback) {
  return { ...(draft || {}), purchase_feedback: feedback };
}

function nextAction({ message, draft = {}, state = 'exploring' } = {}) {
  const text = normalize(message);
  const feedback = draft?.purchase_feedback;
  if (!text || isOptOut(text)) return null;

  if (feedback?.status === 'awaiting_future_consideration') {
    const directReason = reasonFromAnswer(text);
    if (directReason) {
      return {
        state: 'future_interest',
        response: 'Gracias por contármelo. Lo tendremos en cuenta para mejorar 😊',
        draft: draftWithFeedback(draft, {
          status: 'completed', future_consideration: false,
          reason: directReason, initial_reason: feedback.initial_reason || 'no_need',
        }),
      };
    }
    if (affirmative(text)) {
      return {
        state: 'future_interest',
        response: 'Perfecto, muchas gracias 😊 Cuando vuelvas a necesitar, aquí estaremos.',
        draft: draftWithFeedback(draft, {
          status: 'completed', future_consideration: true,
          reason: feedback.initial_reason || 'no_need',
        }),
      };
    }
    if (negative(text)) {
      return {
        state: 'future_interest',
        response: 'Gracias por decírmelo. Para ayudarnos a mejorar, ¿cuál fue la razón principal: precio, despacho, disponibilidad o producto, forma de pago, atención u otro proveedor?',
        draft: draftWithFeedback(draft, {
          status: 'awaiting_loss_reason', future_consideration: false,
          initial_reason: feedback.initial_reason || 'no_need',
        }),
      };
    }
    if (isRenewedPurchase(text)) return null;
    return {
      state: 'future_interest',
      response: 'Gracias por responder 😊 Lo tendremos en cuenta.',
      draft: draftWithFeedback(draft, {
        status: 'completed', future_consideration: null,
        reason: feedback.initial_reason || 'no_need',
      }),
    };
  }

  if (feedback?.status === 'awaiting_loss_reason') {
    if (isRenewedPurchase(text)) return null;
    const reason = reasonFromAnswer(text) || feedback.initial_reason || 'declined';
    return {
      state: 'future_interest',
      response: 'Gracias por contármelo. Lo tendremos en cuenta para mejorar 😊',
      draft: draftWithFeedback(draft, {
        status: 'completed', future_consideration: false, reason,
      }),
    };
  }

  if (!ACTIVE_STATES.has(state)) return null;
  const signal = initialSignal(text);
  if (!signal) return null;

  if (feedback?.status === 'completed') {
    return {
      state: 'future_interest',
      response: 'Entiendo, gracias por avisarme 😊',
      draft,
    };
  }

  return {
    state: 'future_interest',
    response: 'Entiendo, gracias por avisarme 😊 ¿Nos considerarías para una próxima compra?',
    draft: draftWithFeedback(draft, {
      status: 'awaiting_future_consideration', initial_reason: signal,
    }),
  };
}

module.exports = { normalize, initialSignal, reasonFromAnswer, nextAction };

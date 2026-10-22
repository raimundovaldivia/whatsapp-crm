const AFFIRMATIVE = /^(?:s[ií]+|claro|dale|ok(?:ey)?|bueno|por\s+favor|me\s+gustar[iía]|quiero)(?:\s|$)/iu;
const NEGATIVE = /^(?:no|mejor\s+no|est[aá]\s+bien|d[eé]jalo|me\s+los\s+quedo)(?:\s|$)/iu;

const FOOD_SAFETY = /\b(podrid[oa]|descompuest[oa]|en\s+mal\s+estado|vencid[oa]|hongos?|moho|mal\s+olor|olor\s+raro|agrio|cortad[oa]|echad[oa]\s+a\s+perder|me\s+enferm[oó]|intoxicaci[oó]n)\b|\b(queso|producto|alimento)\b.{0,30}\b(malo|mala|dañad[oa])\b/iu;
const RECEIVED = /\b(lleg[oó]|llegaron|recib[ií]|trajeron|entregaron|mandaron|ven[iía]|vinieron)\b/iu;
const WRONG_ITEM = /\b(equivocad[oa]s?|incorrect[oa]s?|distint[oa]s?|diferente(?:s)?|otro\s+(?:producto|color|tipo)|no\s+(?:era|eran)\s+(?:el|la|los|las)|ped[ií].{0,45}(?:pero|y).{0,45}(?:lleg|traj|mand)|dos\s+(?:bandejas?|cajas?).{0,35}(?:color|distint))\b/iu;
const EGG_SIZE = /\b(huevos?|bandeja)\b.{0,70}\b(chic(?:o|a|os|as)|pequeñ(?:o|a|os|as)|tamaño|calibre|peso|parecen\s+(?:l|m|s))\b|\b(chic(?:o|a|os|as)|pequeñ(?:o|a|os|as)|tamaño|calibre|peso)\b.{0,70}\b(huevos?|bandeja)\b/iu;
const GENERIC_SIZE_COMPLAINT = /\b(muy\s+)?(chic(?:o|a|os|as)|pequeñ(?:o|a|os|as))\b|\b(no\s+parecen|parecen)\b.{0,20}\b(?:xl|l|grandes?|extra\s+grandes?)\b/iu;
const THIRD_PARTY = /\b(?:pedido|encargo)\b.{0,70}\b(?:de|a\s+nombre\s+de|para)\b.{0,45}\b(?:amig[oa]|conocid[oa]|clienta|vecin[oa]|mam[aá]|pap[aá]|herman[oa]|señor(?:a)?)\b|\b(?:amig[oa]|conocid[oa]|clienta|vecin[oa])\b.{0,70}\b(?:pedido|encargo)\b/iu;
const STATUS = /\b(d[oó]nde|cu[aá]ndo|hora|llega|viene|reparto|despacho|entrega|en\s+camino|estado)\b/iu;

const CHILEAN_EGG_WEIGHTS = Object.freeze({
  grande: '54–61 g',
  extraGrande: '61–68 g',
  especial: 'más de 68 g',
});

function detectPostSaleResolution(message, { pendingExchange = false, hasRecentDeliveredOrder = false, recentOrderHasEggs = false } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  if (pendingExchange) {
    const answer = text.replace(/[¡!¿?.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (NEGATIVE.test(answer)) return { kind: 'exchange_decline' };
    if (AFFIRMATIVE.test(answer)) return { kind: 'exchange_accept' };
  }

  // Inocuidad y productos en mal estado siempre quedan en manos humanas.
  if (FOOD_SAFETY.test(text)) return null;

  if (hasRecentDeliveredOrder && RECEIVED.test(text) && WRONG_ITEM.test(text)) {
    return { kind: 'exchange_offer' };
  }

  if ((EGG_SIZE.test(text) && (hasRecentDeliveredOrder || RECEIVED.test(text)))
      || (recentOrderHasEggs && GENERIC_SIZE_COMPLAINT.test(text))) {
    return { kind: 'egg_weight_explanation', weights: CHILEAN_EGG_WEIGHTS };
  }

  if (THIRD_PARTY.test(text) && STATUS.test(text)) {
    return { kind: 'third_party_delivery_status' };
  }

  return null;
}

function exchangeOfferText(firstName = '') {
  const name = String(firstName || '').trim().split(/\s+/)[0];
  return `${name ? `${name}, ` : ''}lamento que el pedido no haya llegado como lo pediste. Como fue entregado recientemente, ¿te gustaría que coordinemos un cambio?`;
}

function eggWeightExplanationText(firstName = '') {
  const name = String(firstName || '').trim().split(/\s+/)[0];
  return `${name ? `${name}, ` : ''}gracias por contarnos. Sí podemos revisar el tema del tamaño: los huevos se clasifican por peso, no solo por cómo se ven. ¿Alcanzaste a pesar alguno? Si puedes, envíanos una foto de 2 o 3 huevos sobre la balanza o cuéntanos cuántos gramos marcaron. Usamos como referencia la norma chilena NCh 1372: Grande 54–61 g, Extra Grande 61–68 g y Especial sobre 68 g por unidad. Con ese dato revisamos si correspondían al calibre indicado y te damos una respuesta concreta.`;
}

function thirdPartyStatusText() {
  return 'Claro, puedo ayudarte con el estado general del despacho. Envíame el número de pedido o el teléfono con que se hizo la compra. Por privacidad no compartiré otros datos de la clienta.';
}

module.exports = {
  CHILEAN_EGG_WEIGHTS,
  detectPostSaleResolution,
  exchangeOfferText,
  eggWeightExplanationText,
  thirdPartyStatusText,
};

/**
 * Política pura para texto saliente generado por IA.
 *
 * Se ejecuta en el pipeline común y también desde el guardrail de cada
 * proveedor. Solo bloquea instrucciones internas con señales de alta certeza;
 * una frase comercial normal nunca debe silenciarse por una palabra aislada.
 */

const INTERNAL_INSTRUCTION_PATTERNS = [
  /^[^\p{L}\p{N}]{0,8}el (?:[uú]ltimo|ultimo) mensaje\b/iu,
  /(?:^|[.!?]\s+)[^\p{L}\p{N}]{0,8}tu respuesta anterior (?:fue|estuvo|era) (?:correcta|incorrecta|bien|mal)\b/iu,
  /(?:^|[.!?]\s+)[^\p{L}\p{N}]{0,8}el cliente acaba de (?:decir|preguntar|confirmar|indicar|responder)\b/iu,
  /(?:^|[.!?]\s+)[^\p{L}\p{N}]{0,8}(?:t[uú]|usted) puede(?:s)? (?:responder|decirle|confirmarle|preguntarle|ofrecerle)\b/iu,
  /(?:^|[.!?]\s+)[^\p{L}\p{N}]{0,8}la respuesta (?:correcta )?(?:ser[ií]a|deber[ií]a ser)\b/iu,
  /el (?:[uú]ltimo|ultimo) mensaje est[aá] incompleto/iu,
  /responde (?:[uú]nicamente|unicamente|solo) a lo que/iu,
  /si el cliente (?:completa|est[aá] a punto)/iu,
  /lee todo antes de responder/iu,
  /para responder apropiadamente/iu,
  /mant[eé]n la calma/iu,
  /^[^\p{L}\p{N}]{0,8}deber[ií]a (?:esperar|responder|ignorar)\b/iu,
  /sin embargo, si el cliente\b/iu,
];

function checkOutboundText(value) {
  const text = String(value || '').trim();
  if (!text) return { ok: true };

  const matched = INTERNAL_INSTRUCTION_PATTERNS.find(pattern => pattern.test(text));
  if (!matched) return { ok: true };

  return {
    ok: false,
    reason: 'instrucciones_internas',
    detail: 'El texto contiene instrucciones para el agente, no una respuesta al cliente.',
  };
}

module.exports = { checkOutboundText, INTERNAL_INSTRUCTION_PATTERNS };

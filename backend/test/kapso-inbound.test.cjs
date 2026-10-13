const test = require('node:test');
const assert = require('node:assert/strict');
const kapso = require('../src/services/kapso-whatsapp');

test('normaliza el error 131051 sin entregar el texto técnico al bot', () => {
  const parsed = kapso.parseWebhookMessage({
    message: {
      id: 'wamid.unsupported',
      type: 'unknown',
      kapso: { direction: 'inbound', content: '[Unsupported message - Error 131051]: Message type unknown' },
    },
    conversation: { phone_number: '+56911112222', kapso: { contact_name: 'Cliente' } },
  }, 'whatsapp.message.received');

  assert.equal(parsed.unsupported, true);
  assert.equal(parsed.text, '📎 [Mensaje no compatible de WhatsApp]');
  assert.equal(parsed.from, '56911112222');
});

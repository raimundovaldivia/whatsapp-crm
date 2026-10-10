const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAdReferral, evolutionReferral, summarizeInsights } = require('../src/services/ad-attribution');

test('normaliza referencias Click-to-WhatsApp oficiales y de Evolution', () => {
  assert.deepEqual(normalizeAdReferral({
    source_type: 'ad', source_id: '12001', ctwa_clid: 'click-1',
    source_url: 'https://fb.me/ad', headline: 'Huevos de campo', body: 'Oferta',
  }, 'meta'), {
    provider: 'meta', sourceType: 'ad', sourceId: '12001', ctwaClid: 'click-1',
    sourceUrl: 'https://fb.me/ad', headline: 'Huevos de campo', body: 'Oferta',
    mediaType: null,
    raw: { source_type: 'ad', source_id: '12001', ctwa_clid: 'click-1', source_url: 'https://fb.me/ad', headline: 'Huevos de campo', body: 'Oferta' },
  });

  const referral = evolutionReferral({
    extendedTextMessage: {
      text: 'Hola',
      contextInfo: { externalAdReply: { sourceId: '12002', ctwaClid: 'click-2', sourceUrl: 'https://fb.me/ad2', title: 'Quesos' } },
    },
  });
  assert.equal(referral.provider, 'evolution');
  assert.equal(referral.sourceId, '12002');
  assert.equal(referral.ctwaClid, 'click-2');
  assert.equal(referral.headline, 'Quesos');
});

test('resume las conversaciones sin duplicar aliases de Meta', () => {
  const metrics = summarizeInsights({
    spend: '66844', impressions: '1234', reach: '1000', clicks: '50', ctr: '4.05',
    actions: [
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '34' },
      { action_type: 'messaging_conversation_started_7d', value: '34' },
      { action_type: 'onsite_conversion.messaging_first_reply', value: '21' },
    ],
  });
  assert.equal(metrics.conversations, 34);
  assert.equal(metrics.newContacts, 21);
  assert.equal(metrics.costPerConversation, 1966);
  assert.equal(metrics.clicks, 50);
});


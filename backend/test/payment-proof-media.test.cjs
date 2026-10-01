const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('voucher media accepts direct Kapso URLs and legacy media IDs', async () => {
  const calls = [];
  const cache = new Map();
  const service = load('src/services/payment-proof-media.js', {
    './kapso-whatsapp': {
      getMediaUrl: async id => { calls.push(['resolve', id]); return { url: `https://app.kapso.ai/${id}` }; },
      downloadMedia: async url => { calls.push(['download', url]); return { data: Buffer.from('image'), contentType: 'image/jpeg' }; },
    },
    './media-cache': {
      get: key => cache.get(key) || null,
      set: (key, data, contentType) => cache.set(key, { data, contentType }),
    },
  });

  const direct = 'https://app.kapso.ai/rails/active_storage/signed-voucher';
  assert.equal((await service.getPaymentProofMedia(1, direct, {})).contentType, 'image/jpeg');
  assert.deepEqual(calls, [['download', direct]], 'a direct URL must never be sent to the media-ID endpoint');
  await service.getPaymentProofMedia(1, direct, {});
  assert.equal(calls.length, 1, 'the downloaded voucher is reused from cache');

  await service.getPaymentProofMedia(1, 'legacy-media-id', {});
  assert.deepEqual(calls.slice(1), [
    ['resolve', 'legacy-media-id'],
    ['download', 'https://app.kapso.ai/legacy-media-id'],
  ]);
});

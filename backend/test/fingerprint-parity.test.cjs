const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { load } = require('./helpers.cjs');

// Misma entrada en backend y frontend: la huella de aprobación debe coincidir byte a byte.
test('la huella de aprobación con varias ofertas por destinatario coincide entre backend y frontend', async () => {
  const drafts = load('src/services/broadcast-drafts.js', { '../db/database': { normalizePhone: p => String(p).replace(/\D/g, '') } });
  const offers = [
    { product_id: '51', offer_price: 8000, expires_at: '2026-10-25', scope: 'all_units', recipients: ['56967692870'], margin_confirmed: true },
    { product_id: '50', offer_price: 6000, expires_at: '2026-10-25', scope: { cap_units: 10 }, recipients: ['56967692870'], margin_confirmed: false },
  ];
  const items = [{ phone: '56967692870', message: 'Hola', offers }, { phone: '56911112222', message: 'Chao', offers: [] }];
  const backend = drafts.fingerprint(items);
  const frontendPath = pathToFileURL(path.join(__dirname, '../../frontend/src/utils/broadcast-drafts.mjs')).href;
  const script = `import('${frontendPath}').then(async m => {
    const entries = ${JSON.stringify(items)}.map(i => ({ item: { phone: i.phone, message: i.message, offers: i.offers } }));
    console.log(await m.reviewFingerprint(entries));
  })`;
  const frontend = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  assert.equal(frontend, backend);
});

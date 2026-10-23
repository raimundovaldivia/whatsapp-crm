import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDraftAudience, offerCatalog, offerExpiryInput, restoreDraftEntries, canApproveDrafts, setEntryOffers, setEntryOfferChecks, offersSnapshot } from './broadcast-drafts.mjs';

test('catalog accepts the actual products envelope and excludes inactive or retired products', () => {
  const rows = [{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: true, deprecated_at: '2026-10-01' }];
  assert.deepEqual(offerCatalog({ products: rows }), [rows[0]]);
  assert.deepEqual(offerCatalog(rows), [rows[0]]);
  assert.throws(() => offerCatalog({ data: [] }), /catálogo/);
});

test('expiry editor displays Chile time independently of host timezone', () => {
  assert.equal(offerExpiryInput('2026-10-20'), '2026-10-20T23:59:59');
  assert.equal(offerExpiryInput('2026-10-20T16:00:00Z'), '2026-10-20T13:00:00');
  assert.equal(offerExpiryInput('2026-07-20T17:00:00Z'), '2026-07-20T13:00:00');
  assert.equal(offerExpiryInput('2026-10-20T13:00'), '2026-10-20T13:00');
  assert.equal(offerExpiryInput('invalid'), '');
});

const audience = [{ phone: '56911111111', name: 'Ana' }, { phone: '56922222222', name: 'Luis' }];
const saved = { contacts: [{ phone: audience[1].phone, message: 'Consulta por Jumbo.' }, { phone: audience[0].phone, message: 'Consulta por XL.' }] };

test('restore preserves exact text and order but discards approvals, force, pricing and imported identity', () => {
  saved.contacts[0].force = true;
  saved.contacts[0].name = 'Untrusted';
  saved.contacts[0].offers = [{ product_id: '99', offer_price: 1 }];
  const entries = restoreDraftEntries(saved, audience);
  assert.equal(entries[0].item.phone, audience[1].phone);
  assert.equal(entries[0].item.message, saved.contacts[0].message);
  assert.equal(entries[0].item.contactName, 'Luis');
  assert.equal(entries[0].item.force, undefined);
  assert.deepEqual(entries[0].item.offers, []);
  assert.equal(canApproveDrafts({ entries }, new Set([0, 1])), false);
  let plan = { entries };
  for (let i = 0; i < 2; i++) {
    plan = setEntryOffers(plan, i, [{ product_id: '1', offer_price: 43500, expires_at: '2026-10-20T13:00', scope: 'all_units' }]);
    plan = setEntryOfferChecks(plan, i, [{ ok: true }], offersSnapshot(plan.entries[i]));
  }
  assert.equal(canApproveDrafts(plan, new Set()), false);
  assert.equal(canApproveDrafts(plan, new Set([0, 1])), true);
});

test('restore rejects mismatched audience, duplicates, opt-outs, oversized text and placeholders', () => {
  assert.throws(() => restoreDraftEntries(saved, [audience[0]]), /seleccionados/);
  assert.throws(() => restoreDraftEntries([saved.contacts[0], saved.contacts[0]], audience), /repetido/);
  assert.throws(() => restoreDraftEntries(saved, [audience[0], { ...audience[1], opt_out: true }]), /excluido/);
  assert.throws(() => restoreDraftEntries(saved, [audience[0], { ...audience[1], identity_blocked: true }]), /excluido/);
  for (const message of ['', 'x'.repeat(1201), 'Hola {{nombre}}']) {
    assert.throws(() => restoreDraftEntries([{ phone: audience[0].phone, message }], [audience[0]]), /texto/);
  }
  assert.throws(() => restoreDraftEntries([{ phone: '56999999999', message: 'Hola' }], [audience[0]]), /selección/);
});


test('100 selected recipients are accounted for and exclusions group by stable reason', () => {
  const excluded = Array.from({ length: 10 }, (_, i) => ({ reasonCode: 'recent_campaign', reason: `Campaña hace ${i} días` }));
  excluded.push(...Array.from({ length: 10 }, () => ({ reasonCode: 'opt_out' })));
  const summary = summarizeDraftAudience(80, excluded);
  assert.equal(summary.total, 100);
  assert.equal(summary.prepared, 80);
  assert.equal(summary.excluded, 20);
  assert.deepEqual(summary.reasons.map(r => r.count), [10, 10]);
  assert.equal(summarizeDraftAudience(0, []).total, 0);
  assert.equal(summarizeDraftAudience(0, [{ reason: 'Motivo anterior sin código' }]).reasons[0].label, 'Motivo anterior sin código');
});

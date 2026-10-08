const test = require('node:test');
const assert = require('node:assert/strict');
const now = Date.parse('2026-10-05T15:00:00Z');
const ago = days => ({ phone: String(days), last_order_at: new Date(now - days * 86400000).toISOString() });

test('purchase age uses strict thresholds and excludes absent or invalid history', async () => {
  const { matchesPurchaseAge } = await import('../../frontend/src/utils/broadcast-audience.mjs');
  for (const days of [7, 15, 30, 45, 60, 90]) {
    assert.equal(matchesPurchaseAge(ago(days), String(days), now), false);
    assert.equal(matchesPurchaseAge(ago(days + 1), String(days), now), true);
    assert.equal(matchesPurchaseAge(ago(days - 1), String(days), now), false);
  }
  for (const last_order_at of [null, '', 'invalid']) {
    assert.equal(matchesPurchaseAge({ last_order_at }, '15', now), false);
    assert.equal(matchesPurchaseAge({ last_order_at }, 'all', now), true);
  }
  for (const days of ['', '0', '-1', '1.5', '3651', 'invalid']) {
    assert.equal(matchesPurchaseAge(ago(100), days, now), false);
  }
});

test('changing audience cannot send to selected contacts hidden by the filter', async () => {
  const { matchesPurchaseAge, selectedAudience } = await import('../../frontend/src/utils/broadcast-audience.mjs');
  const contacts = [ago(10), ago(20), ago(40), { phone: 'unknown' }];
  const selected = new Set(contacts.map(contact => contact.phone));
  assert.deepEqual(selectedAudience(contacts.filter(c => matchesPurchaseAge(c, '15', now)), selected).map(c => c.phone), ['20', '40']);
  assert.deepEqual(selectedAudience(contacts.filter(c => matchesPurchaseAge(c, '30', now)), selected).map(c => c.phone), ['40']);
  selected.delete('40');
  assert.equal(selectedAudience(contacts.filter(c => matchesPurchaseAge(c, '30', now)), selected).length, 0);
});

test('campaign ranges include boundaries without overlapping or including unknown purchases', async () => {
  const { matchesPurchaseAge } = await import('../../frontend/src/utils/broadcast-audience.mjs');
  const now = Date.parse('2026-10-08T12:00:00Z');
  for (const age of [0, 6.99, 7, 29, 29.99, 30, 60, 60.99, 61, 90]) {
    const contact = { last_order_at: new Date(now - age * 86400000).toISOString() };
    assert.equal(matchesPurchaseAge(contact,'range_7_29',now),age >= 7 && age < 30);
    assert.equal(matchesPurchaseAge(contact,'range_30_60',now),age >= 30 && age < 61);
  }
  assert.equal(matchesPurchaseAge({},'range_7_29',now),false);
  assert.equal(matchesPurchaseAge({last_order_at:'bad'},'range_30_60',now),false);
});

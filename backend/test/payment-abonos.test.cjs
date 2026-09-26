const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');
const balanceService = load('src/services/payment-proof-balance.js');
const proof = (amount, extra = {}) => ({ extracted_amount: amount, status: 'pending', ...extra });

test('partial receipts: 10000 + 2000 cover 12000 without claiming bank settlement', () => {
  const first = balanceService.summarizeProofs([proof(10000)], 12000);
  assert.equal(first.remaining, 2000);
  const total = balanceService.summarizeProofs([proof(10000), proof(2000)], 12000);
  assert.equal(total.received, 12000);
  assert.equal(total.remaining, 0);
  assert.equal(total.count, 2);
  const text = balanceService.balanceText(total);
  assert.match(text, /completa el total/);
  assert.match(text, /confirmará la recepción bancaria/);
  assert.doesNotMatch(text, /no coincide|pago.*confirmado/i);
});

test('duplicates by image, operation or ambiguous receipt are not added twice', () => {
  for (const pair of [
    [proof(6000, { image_sha256: 'same', media_id: 'a' }), proof(6000, { image_sha256: 'same', media_id: 'b' })],
    [proof(6000, { extracted_reference: '123', extracted_bank: 'Banco' }), proof(6000, { extracted_reference: '123', extracted_bank: 'Banco' })],
    [proof(6000), proof(6000)],
  ]) {
    const result = balanceService.summarizeProofs(pair, 12000);
    assert.equal(result.received, 6000);
    assert.equal(result.duplicates, 1);
  }
  assert.equal(balanceService.summarizeProofs([
    proof(6000, { extracted_reference: 'one' }), proof(6000, { extracted_reference: 'two' }),
  ], 12000).remaining, 0);
});

test('rejected, unreadable and foreign-currency receipts do not cover a CLP order', () => {
  const result = balanceService.summarizeProofs([
    proof(12000, { status: 'rejected' }), proof(null), proof('12.000,00'),
    proof(12000, { extracted_currency: 'USD' }), proof(-12000), proof(2000),
  ], 12000);
  assert.equal(result.received, 2000);
  assert.equal(result.remaining, 10000);
  assert.equal(result.unreadable, 4);
  assert.equal(balanceService.summarizeProofs([proof(15000)], 12000).excess, 3000);
});

test('WhatsApp registers two partial receipts, explains the total and ignores a resent image', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }
  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
      INSERT INTO conversations(id,organization_id,phone_number,contact_name) VALUES(1,1,'111','Gloria'),(2,2,'222','Other');
      INSERT INTO orders(id,organization_id,conversation_id,items,total_price,status,payment_method)
      VALUES(145,1,1,'[]',12000,'entregado','transferencia'),(146,2,2,'[]',12000,'entregado','transferencia');`);
    const realDb = load('src/db/database.js', { pg: { Pool } });
    const conversation = { id: 1, contact_name: 'Gloria' };
    const db = { ...realDb,
      getOrgByPhoneNumberId: async () => ({ org: { id: 1 }, whatsappConfig: {} }),
      getSetting: async () => null, upsertConversation: async () => conversation,
      getConversationById: async () => conversation, touchUserWaWindow: async () => {},
      touchLead: async () => {}, saveMessage: async () => {}, updateConversationLastMessage: async () => {},
      updateLastInbound: async () => {},
    };
    const balances = load('src/services/payment-proof-balance.js', { '../db/database': db });
    let receipt = { amount: 10000, reference: 'op-one', image: 'image-one' };
    const replies = [];
    const router = load('src/routes/kapso-webhook.js', {
      '../db/database': db,
      '../services/staff-identity': load('src/services/staff-identity.js', { '../db/database': db }),
      '../middleware/webhook-auth': { verifyWebhook: () => noop },
      '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
      '../services/commercial': { permitted: async () => true },
      '../services/payment-proof-balance': balances,
      '../services/admin-relay': load('src/services/admin-relay.js', {
        '../db/database': db,
        './admin-assignment': load('src/services/admin-assignment.js', { '../db/database': db }),
      }),
      '../services/kapso-whatsapp': {
        parseStatusUpdate: () => null,
        parseWebhookMessage: () => ({ type: 'image', from: '111', mediaUrl: `https://example.test/${replies.length}`, messageId: `msg-${replies.length}` }),
        markAsRead: async () => {}, downloadMedia: async () => ({ data: Buffer.from(receipt.image), contentType: 'image/png' }),
        sendTextMessage: async (_to, text) => { replies.push(text); return {}; },
      },
      '../services/analyzePaymentProof': { analyzePaymentProof: async () => ({ is_payment_proof: true,
        amount: receipt.amount, reference: receipt.reference, bank: 'Test bank', currency: 'CLP', confidence: 'high' }) },
      '../services/media-cache': { set() {} },
      '../services/admin-notify': { notifyAdmin: async () => {} },
      '../services/notifications': { notifyAgentsPayment: async () => {} },
    });
    const receive = () => handler(router, 'post', '/')({ headers: { 'x-webhook-event': 'whatsapp.message.received' }, body: { phone_number_id: 'test' } }, response());
    await receive();
    assert.match(replies[0], /saldo de \$2\.000/);
    receipt = { amount: 2000, reference: 'op-two', image: 'image-two' };
    await receive();
    assert.match(replies[1], /suman \$12\.000 de \$12\.000/);
    assert.doesNotMatch(replies[1], /no coincide|despach/i);
    await receive();
    assert.match(replies[2], /suman \$12\.000 de \$12\.000/);
    assert.match(replies[2], /repetidos/);
    assert.equal((await query('SELECT status FROM orders WHERE id=145')).rows[0].status, 'entregado');
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM payment_proofs WHERE status != 'pending'")).rows[0].n, 0);
    assert.equal((await balances.getOrderProofBalance(2, 145, 12000)).received, 0, 'organization boundary');
    assert.equal((await balances.getOrderProofBalance(1, 146, 12000)).received, 0, 'order boundary');
  } finally { await engine.close(); }
});

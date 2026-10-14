const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const events = require('../src/services/social-events');
const { streamInfo } = require('../src/services/webhook-inbox');

const connection = { page_id: 'page-1', instagram_account_id: 'ig-1' };

test('normaliza mensajes privados de Facebook e Instagram e ignora ecos', () => {
  const facebook = events.extractSocialEvents({ object: 'page', entry: [{ id: 'page-1', messaging: [
    { sender: { id: 'person-1' }, recipient: { id: 'page-1' }, timestamp: 1000, message: { mid: 'm-1', text: '¿Cuánto cuesta?' } },
    { sender: { id: 'page-1' }, recipient: { id: 'person-1' }, timestamp: 1001, message: { mid: 'm-2', text: 'eco', is_echo: true } },
  ] }] }, connection);
  assert.equal(facebook.length, 1);
  assert.deepEqual(
    { kind: facebook[0].kind, channel: facebook[0].channel, senderId: facebook[0].senderId, externalId: facebook[0].externalId, content: facebook[0].content },
    { kind: 'message', channel: 'facebook', senderId: 'person-1', externalId: 'm-1', content: '¿Cuánto cuesta?' }
  );

  const instagram = events.extractSocialEvents({ object: 'instagram', entry: [{ id: 'ig-1', messaging: [
    { sender: { id: 'person-2' }, recipient: { id: 'ig-1' }, timestamp: 2000, message: { mid: 'm-3', text: 'Hola' } },
  ] }] }, connection);
  assert.equal(instagram[0].channel, 'instagram');
  assert.equal(events.messageEndpoint(connection, instagram[0].channel), 'ig-1/messages');
});

test('normaliza comentarios nuevos y descarta eliminaciones o payloads incompletos', () => {
  const parsed = events.extractSocialEvents({ object: 'page', entry: [{ id: 'page-1', changes: [
    { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'fb-comment', post_id: 'post-1', from: { id: 'person-1', name: 'Ana' }, message: '¿Despachan a Paine?' } },
    { field: 'feed', value: { item: 'comment', verb: 'remove', comment_id: 'removed', from: { id: 'person-2' }, message: 'borrado' } },
    { field: 'comments', value: { id: 'ig-comment', media: { id: 'media-1' }, from: { id: 'person-3', username: 'cliente' }, text: 'Precio' } },
  ] }] }, connection);
  assert.equal(parsed.length, 2);
  assert.deepEqual({ kind: parsed[0].kind, channel: parsed[0].channel, externalId: parsed[0].externalId, authorName: parsed[0].authorName }, { kind: 'comment', channel: 'facebook', externalId: 'fb-comment', authorName: 'Ana' });
  assert.deepEqual({ kind: parsed[1].kind, channel: parsed[1].channel, externalId: parsed[1].externalId, postId: parsed[1].postId }, { kind: 'comment', channel: 'instagram', externalId: 'ig-comment', postId: 'media-1' });
  assert.equal(events.commentReplyEndpoint({ external_comment_id: 'fb-comment', channel: 'facebook' }), 'fb-comment/comments');
  assert.equal(events.commentReplyEndpoint({ external_comment_id: 'ig-comment', channel: 'instagram' }), 'ig-comment/replies');
});

test('identifica actores propios para no contestar al mismo negocio', () => {
  assert.equal(events.isOwnActor({ authorId: 'page-1' }, connection), true);
  assert.equal(events.isOwnActor({ senderId: 'ig-1' }, connection), true);
  assert.equal(events.isOwnActor({ authorId: 'person-9' }, connection), false);
});

test('la cola durable separa conversaciones sociales sin alterar las claves de WhatsApp', () => {
  assert.equal(streamInfo('meta-social', { entry: [{ messaging: [{ sender: { id: 'ig_user-123' } }] }] }, '').key, 'ig_user-123');
  assert.equal(streamInfo('meta', { entry: [{ changes: [{ value: { messages: [{ from: '+56 9 1234 5678' }] } }] }] }, '').key, '56912345678');
});

test('el webhook social exige una firma HMAC válida', () => {
  const oldSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'test-meta-secret';
  delete require.cache[require.resolve('../src/routes/meta-webhook')];
  const validSignature = require('../src/routes/meta-webhook')._validSignature;
  const rawBody = Buffer.from('{"entry":[]}');
  const signature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')}`;
  assert.equal(validSignature({ rawBody, get: name => name === 'x-hub-signature-256' ? signature : null }), true);
  assert.equal(validSignature({ rawBody, get: () => 'sha256=incorrecta' }), false);
  if (oldSecret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = oldSecret;
});

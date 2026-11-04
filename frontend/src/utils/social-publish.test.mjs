import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialPublisher } from './social-publish.js';

const draft = { platform: 'both', message: 'Pedido de prueba', mediaUrl: 'https://example.com/photo.jpg', mediaType: 'image' };
const reject = (status, message = 'Rechazado') => Object.assign(new Error(message), { response: { status, data: { error: message } } });

test('starts both networks together with one shared draft, and deduplicates a double click', async () => {
  const calls = []; const finish = {};
  const publish = createSocialPublisher(data => { calls.push(data); return new Promise(resolve => { finish[data.platform] = resolve; }); });
  const first = publish(draft);
  assert.equal(publish(draft), first);
  assert.deepEqual(calls, ['facebook', 'instagram'].map(platform => ({ ...draft, platform })));
  finish.instagram({ success: true, id: 'ig-1' });
  finish.facebook({ success: true, id: 'fb-1' });
  assert.deepEqual(await first, { instagram: { state: 'published', id: 'ig-1' }, facebook: { state: 'published', id: 'fb-1' } });
});

test('rejects Instagram without media before publishing anything to Facebook', async () => {
  let calls = 0; const publish = createSocialPublisher(() => { calls++; });
  await assert.rejects(publish({ ...draft, mediaUrl: '' }), /Instagram necesita/);
  await assert.rejects(publish({ ...draft, message: '', mediaUrl: '' }), /Agrega/);
  assert.equal(calls, 0);
});

for (const failedPlatform of ['facebook', 'instagram']) {
  test(`retries only a rejected ${failedPlatform}, retaining the other network's confirmation`, async () => {
    const calls = []; let fail = true;
    const publish = createSocialPublisher(async data => {
      calls.push(data.platform);
      if (fail && data.platform === failedPlatform) throw reject(400);
      return { success: true, id: data.platform + '-id' };
    });
    const results = await publish(draft);
    assert.equal(results[failedPlatform].state, 'failed');
    fail = false;
    const retried = await publish(draft, results);
    assert.deepEqual(calls, ['facebook', 'instagram', failedPlatform]);
    assert.equal(retried.facebook.state, 'published');
    assert.equal(retried.instagram.state, 'published');
    await publish(draft, retried);
    assert.equal(calls.length, 3);
  });
}

test('never retries ambiguous network, timeout, or server outcomes', async () => {
  for (const failure of [new Error('Network Error'), reject(408), reject(502), null]) {
    const calls = [];
    const publish = createSocialPublisher(async data => {
      calls.push(data.platform);
      if (data.platform === 'facebook') return { success: true, id: 'fb-1' };
      if (failure) throw failure;
      return { success: true };
    });
    const results = await publish(draft);
    assert.equal(results.instagram.state, 'unknown');
    assert.equal(results.facebook.state, 'published');
    await publish(draft, results);
    assert.deepEqual(calls, ['facebook', 'instagram']);
  }
});

test('keeps single-network text, image, and video publishing compatible', async () => {
  const calls = []; const publish = createSocialPublisher(async data => { calls.push(data); return { success: true, id: 'id' }; });
  for (const value of [{ ...draft, platform: 'facebook', mediaUrl: '' }, { ...draft, platform: 'instagram' }, { ...draft, mediaType: 'reel' }]) {
    await publish(value);
  }
  assert.deepEqual(calls.map(p => [p.platform, p.mediaType]), [['facebook', 'image'], ['instagram', 'image'], ['facebook', 'reel'], ['instagram', 'reel']]);
});

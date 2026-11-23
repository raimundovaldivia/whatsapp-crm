const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const { validateEndpoint } = require('../src/services/evolution-whatsapp');

test('Evolution requires an exact operator-approved HTTPS origin', () => {
  const env = { EVOLUTION_ALLOWED_ORIGINS: 'https://evolution.example, https://second.example:8443' };
  assert.equal(validateEndpoint('https://evolution.example/', env), 'https://evolution.example');
  assert.equal(validateEndpoint('https://second.example:8443/api/', env), 'https://second.example:8443/api');
  for (const url of ['http://evolution.example', 'https://evolution.example.attacker.invalid',
    'https://attacker.invalid/?next=https://evolution.example', 'https://evolution.example:8443',
    'https://user:password@evolution.example', 'http://169.254.169.254',
    'https://evolution.example/#secret', 'https://evolution.example/?redirect=1']) {
    assert.throws(() => validateEndpoint(url, env), e => e.code === 'EVOLUTION_ENDPOINT_DENIED');
  }
  assert.throws(() => validateEndpoint('https://evolution.example', {}));
  assert.throws(() => validateEndpoint('https://evolution.example', { EVOLUTION_ALLOWED_ORIGINS: '*' }));
  assert.throws(() => validateEndpoint('https://evolution.example', { EVOLUTION_ALLOWED_ORIGINS: 'https://evolution.example/api' }));
});

test('a tenant cannot send the global key to an unapproved host; approved clients never follow redirects', async () => {
  let calls = 0, options;
  const service = load('src/services/evolution-whatsapp.js', {
    axios: { create(config) { calls++; options=config; return { get: async () => ({ data: {} }) }; } },
  }, { process: { env: { EVOLUTION_API_KEY: 'synthetic-global-key', EVOLUTION_ALLOWED_ORIGINS: 'https://trusted.invalid' } } });
  await assert.rejects(() => service.getConnectionState({ evolution_api_url: 'https://attacker.invalid', evolution_instance: 'x' }), e => e.code === 'EVOLUTION_ENDPOINT_DENIED');
  assert.equal(calls, 0);
  await service.getConnectionState({ evolution_api_url: 'https://trusted.invalid', evolution_instance: 'x' });
  assert.equal(calls, 1);
  assert.equal(options.headers.apikey, 'synthetic-global-key');
  assert.equal(options.maxRedirects, 0);
});

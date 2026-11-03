import test from 'node:test';
import assert from 'node:assert/strict';
import { readSocialImage, MAX_SOCIAL_IMAGE_BYTES } from './social-image.js';

test('rejects unsupported types, empty and oversized files before reading', async () => {
  for (const file of [null, { type: 'text/html', size: 100 }, { type: 'image/svg+xml', size: 100 },
    { type: 'image/png', size: 0 }, { type: 'image/jpeg', size: MAX_SOCIAL_IMAGE_BYTES + 1 }]) {
    await assert.rejects(readSocialImage(file));
  }
});

test('reads only the chosen image payload and reports local read failures', async t => {
  const original = globalThis.FileReader;
  t.after(() => { if (original === undefined) delete globalThis.FileReader; else globalThis.FileReader = original; });
  const file = { type: 'image/png', size: 10 };
  globalThis.FileReader = class {
    readAsDataURL(selected) {
      assert.equal(selected, file);
      this.result = 'data:image/png;base64,aGVsbG8=';
      this.onload();
    }
  };
  assert.equal(await readSocialImage(file), 'aGVsbG8=');
  globalThis.FileReader = class { readAsDataURL() { this.onerror(); } };
  await assert.rejects(readSocialImage(file), /No se pudo leer/);
});

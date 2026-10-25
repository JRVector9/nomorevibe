import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageReceipt } from './ci-image-receipt.mjs';

const valid = { release: 'a'.repeat(40), tree: 'b'.repeat(40), kind: 'worker', digest: 'sha256:' + 'c'.repeat(64),
  runId: '123', runAttempt: '2', testProfile: 'full', rulesVersion: 'v2' };
test('binds an immutable image to the actual main CI tree and attempt', () => {
  assert.deepEqual(createImageReceipt(valid), { schemaVersion: 1, release: valid.release, tree: valid.tree,
    kind: 'worker', image: 'ghcr.io/jrvector9/nomorevibe-worker@' + valid.digest,
    runId: 123, runAttempt: 2, testProfile: 'full', rulesVersion: 'v2' });
});
test('private web image and UI test scope stay explicit', () => {
  const result = createImageReceipt({ ...valid, kind: 'web', testProfile: 'ui' });
  assert.equal(result.image, 'ghcr.io/jrvector9/nomorevibe-runtime-web@' + valid.digest);
  assert.equal(result.testProfile, 'ui');
});
test('does not publish unverified, mutable, or malformed image provenance', () => {
  for (const invalid of [{ release: 'main' }, { tree: '' }, { kind: 'monitor' }, { digest: 'latest' },
    { runId: '0' }, { runId: '1e3' }, { runAttempt: '0' }, { testProfile: 'docs' }, { rulesVersion: 'v1' }]) {
    assert.throws(() => createImageReceipt({ ...valid, ...invalid }), /image_receipt_invalid/);
  }
});

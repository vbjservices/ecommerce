import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importedProductHash, readWorkspaceRoute } from '../src/browser/workspace-route';

const candidateId = '00000000-0000-4000-8000-000000000010';

test('imported product routes are GitHub Pages-safe and validate candidate identities', () => {
  const hash = importedProductHash(candidateId);
  assert.equal(hash, `#/imported/${candidateId}`);
  assert.deepEqual(readWorkspaceRoute(hash), { kind: 'imported-product', candidateId });
  assert.deepEqual(readWorkspaceRoute('#/imported/not-a-product'), { kind: 'workspace' });
  assert.deepEqual(readWorkspaceRoute(''), { kind: 'workspace' });
  assert.throws(() => importedProductHash('not-a-product'), /Invalid imported product ID/);
});

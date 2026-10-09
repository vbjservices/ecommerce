import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeDiscoveryRun } from '../src/application/discovery/execute-discovery-run';
import { discoveryProfiles } from '../src/application/discovery/profiles';
import type { DiscoveryRunRepository } from '../src/application/ports/discovery-run-repository';
import type { SupplierAdapter } from '../src/application/ports/supplier-adapter';
import type { DiscoveryProfile } from '../src/domain/discovery';

const profile: DiscoveryProfile = {
  ...discoveryProfiles.pets!,
  enabledStrategies: ['original_query'],
  search: { ...discoveryProfiles.pets!.search, maxExpansions: 0 },
};

test('discovery execution reuses a fresh persisted run without calling the supplier', async () => {
  let supplierCalls = 0;
  const adapter: SupplierAdapter = {
    provider: 'fixture',
    providerName: 'Fixture supplier',
    discovery: { search: async () => {
      supplierCalls++;
      throw new Error('supplier should not be called');
    } },
  };
  const cached = { runId: 'run-cached', candidateCount: 12, observationCount: 12 };
  const repository: DiscoveryRunRepository = {
    findFresh: async () => cached,
    save: async () => { throw new Error('cache should not be saved again'); },
  };
  const result = await executeDiscoveryRun({ adapter, repository }, {
    query: '  Cat   Toy ', profile,
  });
  assert.deepEqual(result, { source: 'cache', persisted: cached, run: null });
  assert.equal(supplierCalls, 0);
});

test('discovery execution searches and persists through one application boundary', async () => {
  let savedProvider: { code: string; name: string } | null = null;
  const adapter: SupplierAdapter = {
    provider: 'fixture',
    providerName: 'Fixture supplier',
    discovery: { search: async () => ({
      products: [],
      nextCursor: null,
      totalResults: 0,
      source: 'fixture-api',
      retrievedAt: '2026-10-09T01:00:00.000Z',
      rawPayload: { products: [] },
    }) },
  };
  const persisted = { runId: 'run-new', candidateCount: 0, observationCount: 0 };
  const repository: DiscoveryRunRepository = {
    findFresh: async () => null,
    save: async (provider, run) => {
      savedProvider = provider;
      assert.equal(run.originalQuery, 'cat toy');
      return persisted;
    },
  };
  const result = await executeDiscoveryRun({
    adapter,
    repository,
    clock: () => Date.parse('2026-10-09T01:00:00.000Z'),
  }, {
    query: 'Cat Toy', profile, refresh: true,
    budget: {
      maxApiRequests: 1,
      maxPagesPerStrategy: 1,
      maxRawCandidates: 10,
      maxEnrichments: 0,
      pageSize: 10,
    },
  });
  assert.equal(result.source, 'supplier');
  assert.equal(result.run.status, 'completed');
  assert.deepEqual(result.persisted, persisted);
  assert.deepEqual(savedProvider, { code: 'fixture', name: 'Fixture supplier' });
});

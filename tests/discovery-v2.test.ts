import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessDiscoveryProduct } from '../src/application/discovery/assess-product';
import { assessProductRelevance } from '../src/application/discovery/assess-relevance';
import { buildQueryExpansions } from '../src/application/discovery/expand-query';
import { assertValidDiscoveryProfile, discoveryProfiles } from '../src/application/discovery/profiles';
import { runProductDiscovery } from '../src/application/discovery/run-product-discovery';
import { IntegrationError } from '../src/application/ports/integration-error';
import type { QueryExpansionProvider } from '../src/application/ports/query-expansion-provider';
import type { SupplierAdapter } from '../src/application/ports/supplier-adapter';
import type { DiscoveryOccurrence, DiscoveryProfile } from '../src/domain/discovery';
import type { SupplierDiscoveryProduct } from '../src/domain/suppliers';
import { OllamaQueryExpansionProvider } from '../src/server/integrations/query-expansion/ollama';

const pets = discoveryProfiles.pets!;

function product(
  id: string,
  title: string,
  overrides: Partial<SupplierDiscoveryProduct> = {},
): SupplierDiscoveryProduct {
  return {
    externalProductId: id,
    title,
    supplierSku: null,
    imageUrl: `https://example.com/${id}.jpg`,
    imageUrls: [`https://example.com/${id}.jpg`],
    sourceUrl: `https://example.com/${id}`,
    category: 'Pet Supplies > Cat Toys',
    costRange: { minAmount: '3.00', maxAmount: '5.00', currency: 'USD' },
    listedCount: 120,
    inventory: 1_000,
    verifiedInventory: 900,
    unverifiedInventory: 100,
    createdAt: '2026-01-01T00:00:00Z',
    deliveryDays: { min: 3, max: 5 },
    hasVideo: true,
    freeShipping: false,
    customizable: false,
    personalized: false,
    hasCertification: false,
    productType: 'ORDINARY_PRODUCT',
    saleStatus: 'on_sale',
    visible: true,
    ...overrides,
  };
}

function occurrence(strategy: DiscoveryOccurrence['strategy'] = 'original_query'): DiscoveryOccurrence {
  return {
    strategy,
    query: 'cat toy',
    querySource: 'original',
    page: 1,
    rank: 1,
    sortBy: 'relevance',
    filters: {},
    source: 'fixture',
    retrievedAt: '2026-09-30T10:00:00Z',
  };
}

test('query planning preserves original intent and adds bounded deterministic expansions', async () => {
  const result = await buildQueryExpansions('  Cát   Toys  ', pets);
  assert.equal(result.queries[0]!.query, 'cat toys');
  assert.equal(result.queries[0]!.source, 'original');
  assert.ok(result.queries.some((query) => query.query === 'kitten toys'));
  assert.ok(result.queries.some((query) => query.query === 'cat interactive toy'));
  assert.ok(result.queries.length <= pets.search.maxExpansions + 1);
  assert.deepEqual(result.warnings, []);
});

test('discovery profiles reject invalid weights and thresholds before provider calls', () => {
  assert.throws(() => assertValidDiscoveryProfile({
    ...pets,
    scoring: { ...pets.scoring, relevance: -1 },
  }), /profile pets is invalid/);
  assert.throws(() => assertValidDiscoveryProfile({
    ...pets,
    eligibility: { ...pets.eligibility, maximumCost: pets.eligibility.targetCostMax },
  }), /profile pets is invalid/);
});

test('optional expansion failure degrades to deterministic queries', async () => {
  const unavailable: QueryExpansionProvider = {
    name: 'fixture-model',
    expand: async () => { throw new Error('offline'); },
  };
  const profile = {
    ...pets,
    search: { ...pets.search, maxExpansions: 8 },
  };
  const result = await buildQueryExpansions('cat toy', profile, unavailable);
  assert.ok(result.queries.length > 1);
  assert.deepEqual(result.warnings, [{
    strategy: 'query_expansion', query: 'cat toy', code: 'fixture-model_unavailable',
  }]);
});

test('Ollama expansion uses structured output and rejects malformed model responses', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = new OllamaQueryExpansionProvider('http://ollama.test', 'small-model', async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json({ response: JSON.stringify({
      expansions: [{ query: 'interactive cat toy', confidence: 0.8, reason: 'preserves intent' }],
    }) });
  });
  const result = await provider.expand({ originalQuery: 'cat toy', profile: pets, maximumExpansions: 2 });
  assert.equal(calls[0]!.url, 'http://ollama.test/api/generate');
  assert.equal(calls[0]!.body.stream, false);
  assert.equal(typeof calls[0]!.body.format, 'object');
  assert.deepEqual(result, [{
    query: 'interactive cat toy', confidence: 0.8, reason: 'preserves intent', source: 'local_model',
  }]);
  const malformed = new OllamaQueryExpansionProvider('http://ollama.test', 'small-model', async () =>
    Response.json({ response: '{bad json' }));
  await assert.rejects(
    malformed.expand({ originalQuery: 'cat toy', profile: pets, maximumExpansions: 2 }),
    /invalid structured output/,
  );
});

test('relevance distinguishes exact, related, and excluded products with explicit reasons', () => {
  const exact = assessProductRelevance(product('exact', 'Interactive Cat Toy'), 'cat toy', pets);
  assert.equal(exact.level, 'exact');
  const relatedProduct = product('related', 'Automatic Rechargeable Rolling Ball', {
    category: 'Pet Supplies > Cat Products',
  });
  const related = assessProductRelevance(relatedProduct, 'cat toy', pets);
  assert.equal(related.level, 'related');
  assert.ok(related.matchedSynonyms.includes('ball'));
  const excludedProduct = product('excluded', 'Cat Print Hoodie', { category: 'Clothing' });
  const excluded = assessProductRelevance(excludedProduct, 'cat toy', pets);
  assert.equal(excluded.level, 'weak');
  assert.deepEqual(excluded.negativeTerms, ['hoodie']);
  const assessment = assessDiscoveryProduct(excludedProduct, 'cat toy', pets, [occurrence()],
    Date.parse('2026-09-30T10:00:00Z'));
  assert.equal(assessment.eligibility.status, 'fail');
  assert.equal(assessment.score <= 100, true);
  assert.notEqual(assessment.score, assessment.confidence);
  assert.ok(assessment.unknownEvidence.some((item) => item.includes('consumer demand')));
});

test('budgeted discovery paginates, merges candidates, preserves provenance, and tolerates a strategy failure', async () => {
  const calls: Array<{ query: string; cursor?: string; sortBy?: string }> = [];
  const shared = product('shared', 'Interactive Cat Toy');
  const adapter: SupplierAdapter = {
    provider: 'fixture',
    providerName: 'Fixture supplier',
    discovery: { search: async (input) => {
      calls.push({
        query: input.query,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.sortBy ? { sortBy: input.sortBy } : {}),
      });
      if (input.sortBy === 'listings') throw new IntegrationError('rate_limited', 'fixture');
      const secondPage = input.cursor === '2';
      return {
        products: secondPage ? [shared] : [shared, product('second', 'Cat Puzzle Toy')],
        nextCursor: secondPage ? null : '2',
        totalResults: 3,
        source: 'fixture-api',
        retrievedAt: '2026-09-30T10:00:00Z',
        rawPayload: { page: secondPage ? 2 : 1 },
      };
    } },
  };
  const profile: DiscoveryProfile = {
    ...pets,
    enabledStrategies: ['original_query', 'listing_activity'],
    search: { ...pets.search, maxExpansions: 0 },
  };
  const run = await runProductDiscovery(adapter, {
    query: 'cat toy',
    profile,
    budget: {
      maxApiRequests: 4, maxPagesPerStrategy: 2, maxRawCandidates: 20,
      maxEnrichments: 0, pageSize: 10,
    },
  }, undefined, () => Date.parse('2026-09-30T10:00:00Z'));
  assert.equal(calls.length, 3);
  assert.equal(run.status, 'completed_with_warnings');
  assert.equal(run.metrics.pagesFetched, 2);
  assert.equal(run.metrics.uniqueProductsFound, 2);
  assert.equal(run.metrics.duplicatesFound, 1);
  assert.equal(run.candidates.find((item) => item.product.externalProductId === 'shared')!.occurrences.length, 2);
  assert.deepEqual(run.warnings, [{ strategy: 'listing_activity', query: 'cat toy', code: 'rate_limited' }]);
  assert.equal(run.sourcePages.length, 2);
  assert.equal(run.cacheExpiresAt, '2026-09-30T16:00:00.000Z');
});

test('raw-candidate budget is enforced on the final supplier page', async () => {
  const limits: number[] = [];
  const adapter: SupplierAdapter = {
    provider: 'fixture',
    providerName: 'Fixture supplier',
    discovery: { search: async (input) => {
      const limit = input.limit ?? 0;
      limits.push(limit);
      const page = limits.length;
      return {
        products: Array.from({ length: limit }, (_, index) =>
          product(`${page}-${index}`, `Cat Toy ${page}-${index}`)),
        nextCursor: String(page + 1),
        totalResults: 50,
        source: 'fixture-api',
        retrievedAt: '2026-09-30T10:00:00Z',
        rawPayload: { page },
      };
    } },
  };
  const profile: DiscoveryProfile = {
    ...pets,
    enabledStrategies: ['original_query'],
    search: { ...pets.search, maxExpansions: 0 },
  };
  const run = await runProductDiscovery(adapter, {
    query: 'cat toy',
    profile,
    budget: {
      maxApiRequests: 4, maxPagesPerStrategy: 4, maxRawCandidates: 5,
      maxEnrichments: 0, pageSize: 3,
    },
  });
  assert.deepEqual(limits, [3, 2]);
  assert.equal(run.metrics.productsFetched, 5);
  assert.equal(run.metrics.uniqueProductsFound, 5);
  assert.equal(run.metrics.stoppingReason, 'raw_candidate_budget_reached');
});

test('ranked shortlist media is enriched within the shared API budget', async () => {
  const base = product('gallery', 'Interactive Cat Toy');
  const adapter: SupplierAdapter = {
    provider: 'fixture',
    providerName: 'Fixture supplier',
    discovery: { search: async () => ({
      products: [base],
      nextCursor: null,
      totalResults: 1,
      source: 'fixture-list',
      retrievedAt: '2026-09-30T10:00:00Z',
      rawPayload: { page: 1 },
    }) },
    media: { getProductImages: async (externalProductId) => ({
      externalProductId,
      imageUrls: [base.imageUrls[0]!, 'https://example.com/gallery-side.jpg'],
      source: 'fixture-detail',
      retrievedAt: '2026-09-30T10:01:00Z',
      rawPayload: { detail: true },
    }) },
  };
  const profile: DiscoveryProfile = {
    ...pets,
    enabledStrategies: ['original_query'],
    search: { ...pets.search, maxExpansions: 0 },
  };
  const run = await runProductDiscovery(adapter, {
    query: 'cat toy',
    profile,
    budget: {
      maxApiRequests: 2, maxPagesPerStrategy: 1, maxRawCandidates: 10,
      maxEnrichments: 1, pageSize: 10,
    },
  });
  assert.equal(run.metrics.apiRequestsUsed, 2);
  assert.equal(run.metrics.enrichmentsUsed, 1);
  assert.deepEqual(run.candidates[0]!.product.imageUrls, [
    'https://example.com/gallery.jpg',
    'https://example.com/gallery-side.jpg',
  ]);
  assert.equal(run.sourcePages[1]!.strategy, 'media_enrichment');
});

test('a second niche reuses the same discovery and assessment pipeline', async () => {
  const home = discoveryProfiles['home-products']!;
  const adapter: SupplierAdapter = {
    provider: 'fixture',
    providerName: 'Fixture supplier',
    discovery: { search: async () => ({
      products: [product('home', 'Space Saving Storage Organizer', { category: 'Home Storage' })],
      nextCursor: null,
      totalResults: 1,
      source: 'fixture-api',
      retrievedAt: '2026-09-30T10:00:00Z',
      rawPayload: {},
    }) },
  };
  const profile: DiscoveryProfile = { ...home, enabledStrategies: ['original_query'] };
  const run = await runProductDiscovery(adapter, { query: 'home storage', profile });
  assert.equal(run.candidates[0]!.assessment.eligibility.status, 'pass');
  assert.equal(run.profileId, 'home-products');
});

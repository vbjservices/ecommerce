import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rankSupplierDiscoveryProducts } from '../src/application/discovery/rank-supplier-products';
import { searchSupplierProducts } from '../src/application/discovery/search-supplier-products';
import type { SupplierAdapter } from '../src/application/ports/supplier-adapter';
import { CjSupplierAdapter } from '../src/server/integrations/suppliers/cj/adapter';
import { CjClient } from '../src/server/integrations/suppliers/cj/client';

test('CJ discovery maps documented search facts and ranking stays explainable', async () => {
  const discoveryFixture = JSON.parse(
    await readFile('tests/fixtures/cj-discovery-query.json', 'utf8'),
  ) as unknown;
  const calls: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return Response.json(url.endsWith('/authentication/getAccessToken')
      ? {
          code: 200, result: true,
          data: { accessToken: 'token', accessTokenExpiryDate: '2099-01-01T00:00:00Z' },
        }
      : discoveryFixture);
  };
  const adapter = new CjSupplierAdapter(new CjClient('key', fetchMock, 'https://cj.test', 0));
  const snapshot = await adapter.discovery.search({
    query: 'cat toy',
    limit: 2,
    sortBy: 'listings',
    filters: {
      maxCost: '25', minInventory: 100, verifiedOnly: true,
      productFlag: 'trending', freeShipping: true,
      hasCertification: true, customizable: false,
    },
  });
  const request = new URL(calls[1]!);
  assert.equal(request.pathname, '/product/listV2');
  assert.equal(request.searchParams.get('keyWord'), 'cat toy');
  assert.equal(request.searchParams.get('orderBy'), '1');
  assert.equal(request.searchParams.get('verifiedWarehouse'), '1');
  assert.equal(request.searchParams.get('productFlag'), '0');
  assert.equal(request.searchParams.get('addMarkStatus'), '1');
  assert.equal(request.searchParams.get('hasCertification'), '1');
  assert.equal(request.searchParams.get('customization'), '0');
  assert.equal(snapshot.nextCursor, '2');
  assert.equal(snapshot.totalResults, 3);
  assert.deepEqual(snapshot.products[0], {
    externalProductId: 'product-high-confidence',
    title: 'Interactive Cat Puzzle Toy',
    supplierSku: 'CAT-PUZZLE',
    imageUrl: 'https://example.com/cat-puzzle.jpg',
    sourceUrl: 'https://cjdropshipping.com/product/interactive-cat-puzzle-toy-p-product-high-confidence.html',
    category: 'Pet Chase Toys',
    costRange: { minAmount: '4.50', maxAmount: '6.00', currency: 'USD' },
    listedCount: 740,
    inventory: 5100,
    verifiedInventory: 5000,
    unverifiedInventory: 100,
    createdAt: '2025-03-01T00:00:00.000Z',
    deliveryDays: { min: 3, max: 5 },
    hasVideo: true,
    freeShipping: false,
    customizable: false,
    personalized: false,
    hasCertification: true,
    productType: 'ORDINARY_PRODUCT',
    saleStatus: 'on_sale',
    visible: true,
  });

  const ranked = rankSupplierDiscoveryProducts(snapshot.products, undefined,
    Date.parse('2026-09-29T00:00:00Z'), 'cat toy');
  assert.equal(ranked[0]!.product.externalProductId, 'product-high-confidence');
  assert.equal(ranked[0]!.eligible, true);
  assert.equal(ranked[0]!.coverage, 100);
  assert.ok(ranked[0]!.score > ranked[1]!.score);
  assert.ok(ranked[0]!.reasons.includes('strong listing activity'));
  assert.match(ranked[1]!.risks.join(' '), /manual compliance review: food, treat/);
  assert.equal(ranked[1]!.eligible, false);
  assert.match(ranked[1]!.risks.join(' '), /weak query match/);
});

test('multi-term discovery merges provider results before applying strict relevance', async () => {
  const calls: string[] = [];
  const product = (id: string, title: string) => ({
    externalProductId: id,
    title,
    supplierSku: null,
    imageUrl: null,
    sourceUrl: `https://example.com/${id}`,
    category: 'Pet Toys',
    costRange: { minAmount: '2.00', maxAmount: '2.00', currency: 'USD' },
    listedCount: 100,
    inventory: 500,
    verifiedInventory: 500,
    unverifiedInventory: 0,
    createdAt: '2026-01-01T00:00:00Z',
    deliveryDays: { min: 3, max: 5 },
    hasVideo: false,
    freeShipping: false,
    customizable: false,
    personalized: false,
    hasCertification: false,
    productType: 'ORDINARY_PRODUCT',
    saleStatus: 'on_sale',
    visible: true,
  });
  const shared = product('shared', 'Interactive Cat Toys');
  const adapter = {
    provider: 'test',
    providerName: 'Test',
    discovery: {
      search: async ({ query }: { query: string }) => {
        calls.push(query);
        return {
          products: query === 'cat' ? [shared, product('cat-only', 'Cat Bed')] :
            [shared, product('toy-only', 'Desk Toy')],
          nextCursor: null,
          totalResults: 2,
          source: 'test',
          retrievedAt: '2026-09-30T00:00:00Z',
          rawPayload: {},
        };
      },
    },
  } as SupplierAdapter;
  const result = await searchSupplierProducts(adapter, { query: 'cat toy' });
  assert.deepEqual(calls, ['cat', 'toy']);
  assert.equal(result.products.length, 3);
  const ranked = rankSupplierDiscoveryProducts(
    result.products, undefined, Date.parse('2026-09-30T00:00:00Z'), 'cat toy',
  );
  assert.equal(ranked[0]!.product.externalProductId, 'shared');
  assert.equal(ranked.filter((item) => item.eligible).length, 2);
});

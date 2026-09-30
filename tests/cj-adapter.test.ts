import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IntegrationError } from '../src/application/ports/integration-error';
import { CjSupplierAdapter } from '../src/server/integrations/suppliers/cj/adapter';
import { CjClient } from '../src/server/integrations/suppliers/cj/client';

const fixture = async (name: string) => JSON.parse(
  await readFile(`tests/fixtures/${name}.json`, 'utf8'),
) as unknown;

test('CJ adapter authenticates once and normalizes a product with explicit variants', async () => {
  const [product, variants, stock] = await Promise.all([
    fixture('cj-product-query'), fixture('cj-variant-query'), fixture('cj-stock-query'),
  ]);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const body = url.endsWith('/authentication/getAccessToken')
      ? {
          code: 200, result: true, success: true, message: 'Success',
          data: { accessToken: 'test-access-token', accessTokenExpiryDate: '2099-01-01T00:00:00Z' },
        }
      : url.includes('/variant/query') ? variants
      : url.includes('/stock/getInventoryByPid') ? stock
      : product;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const adapter = new CjSupplierAdapter(new CjClient('private-api-key', fetchMock, 'https://cj.test', 0));
  const snapshot = await adapter.catalog.getProduct('1561984433618694144');

  assert.equal(calls.filter((call) => call.url.endsWith('/authentication/getAccessToken')).length, 1);
  assert.equal(calls.length, 4);
  assert.equal(JSON.parse(String(calls[0]!.init?.body)).apiKey, 'private-api-key');
  for (const call of calls.slice(1)) {
    assert.equal(new Headers(call.init?.headers).get('CJ-Access-Token'), 'test-access-token');
  }
  assert.equal(snapshot.product.title, 'Catnip Balls Cat Treats Rotary Molar Teeth Cleaning');
  assert.equal(snapshot.product.description, 'Product Details:\nFlavor: Mint & catnip');
  assert.equal(snapshot.product.imageUrl, 'https://cf.cjdropshipping.com/product/catnip-balls.jpg');
  assert.deepEqual(snapshot.product.imageUrls, [
    'https://cf.cjdropshipping.com/product/catnip-balls.jpg',
    'https://cf.cjdropshipping.com/product/catnip-balls-alt.jpg',
  ]);
  assert.equal(snapshot.product.sourceUrl,
    'https://cjdropshipping.com/product/catnip-balls-cat-treats-rotary-molar-teeth-cleaning-p-1561984433618694144.html');
  assert.equal(snapshot.product.variants.length, 2);
  assert.deepEqual(snapshot.product.variants[1], {
    externalVariantId: '2506170616321605300',
    sku: 'CJMY154835404DW',
    options: { Color: 'As shown', style: '10pcs' },
    cost: {
      value: { amount: '3.16', currency: 'USD' },
      source: 'cj-api-v2:product/variant/query',
      retrievedAt: snapshot.retrievedAt,
    },
    stock: {
      value: 8337,
      source: 'cj-api-v2:product/stock/getInventoryByPid',
      retrievedAt: snapshot.retrievedAt,
    },
  });
  assert.ok('product' in (snapshot.rawPayload as Record<string, unknown>));

  const media = await adapter.media.getProductImages('1561984433618694144');
  assert.deepEqual(media.imageUrls, snapshot.product.imageUrls);
  assert.equal(media.source, 'cj-api-v2:product/query');
  assert.equal(calls.length, 5);
});

test('CJ adapter exposes provider failures without converting them into empty products', async () => {
  const fetchMock: typeof fetch = async (input) => {
    if (String(input).endsWith('/authentication/getAccessToken')) {
      return Response.json({
        code: 200, result: true,
        data: { accessToken: 'token', accessTokenExpiryDate: '2099-01-01T00:00:00Z' },
      });
    }
    return Response.json({ code: 503, result: false, message: 'Provider unavailable', data: null });
  };
  const adapter = new CjSupplierAdapter(new CjClient('key', fetchMock, 'https://cj.test', 0));
  await assert.rejects(
    adapter.catalog.getProduct('1561984433618694144'),
    (error: unknown) => error instanceof IntegrationError && error.code === 'unavailable',
  );
});

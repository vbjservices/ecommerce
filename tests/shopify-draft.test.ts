import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareShopifyDraftInput } from '../supabase/functions/_shared/shopify-draft';

const payload = {
  candidateId: '00000000-0000-4000-8000-000000000001',
  productId: '00000000-0000-4000-8000-000000000002',
  title: 'Cat <Toy>',
  description: 'Safe & useful\nSecond line',
  retailCurrency: 'EUR',
  imageUrls: ['https://example.com/one.png', 'javascript:invalid', 'https://example.com/one.png'],
  variants: [
    {
      internalProductVariantId: '00000000-0000-4000-8000-000000000011',
      supplierExternalVariantId: 'supplier-red-small',
      existingExternalVariantId: 'gid://shopify/ProductVariant/101',
      sku: 'RED-S', options: { Color: 'Red', Size: 'Small' }, retailPrice: '19.99',
    },
    {
      internalProductVariantId: '00000000-0000-4000-8000-000000000012',
      supplierExternalVariantId: 'supplier-blue-large',
      sku: 'BLUE-L', options: { Color: 'Blue', Size: 'Large' }, retailPrice: '24.99',
    },
  ],
};

test('Shopify draft input preserves structured options, prices, media identity, and internal mappings', () => {
  const input = prepareShopifyDraftInput(payload, 'ecommerce-source-product');
  assert.equal(input.status, 'DRAFT');
  assert.equal(input.handle, 'ecommerce-source-product');
  assert.equal(input.descriptionHtml, 'Safe &amp; useful<br>Second line');
  assert.deepEqual(input.productOptions.map((option) => option.name), ['Color', 'Size']);
  assert.deepEqual(input.variants.map((variant) => ({
    price: variant.price,
    sku: variant.sku,
    id: 'id' in variant ? variant.id : undefined,
  })), [
    { price: '19.99', sku: 'RED-S', id: 'gid://shopify/ProductVariant/101' },
    { price: '24.99', sku: 'BLUE-L', id: undefined },
  ]);
  assert.equal(input.files.length, 1);
  assert.equal(input.files[0]!.duplicateResolutionMode, 'REPLACE');
  assert.match(input.files[0]!.filename, /00000000000040008000000000000002-01\.png$/);
});

test('Shopify draft input falls back to a single unique option when supplier option shapes collide', () => {
  const input = prepareShopifyDraftInput({
    ...payload,
    variants: payload.variants.map((variant) => ({ ...variant, options: { Color: 'Red' } })),
  }, 'ecommerce-collision');
  assert.deepEqual(input.productOptions.map((option) => option.name), ['Variant']);
  assert.equal(new Set(input.productOptions[0]!.values.map((value) => value.name)).size, 2);
  assert.equal(input.variants.length, 2);
});

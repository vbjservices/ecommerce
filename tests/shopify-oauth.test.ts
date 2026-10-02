import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptShopifyToken,
  encryptShopifyToken,
  hashOauthState,
  normalizeShopDomain,
  verifyShopifyHmac,
} from '../supabase/functions/_shared/shopify-oauth.ts';

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url');
}

test('Shopify OAuth token encryption is domain-bound and round trips without plaintext storage', async () => {
  const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const shop = 'petvia.myshopify.com';
  const token = 'shpat_private_example';
  const encrypted = await encryptShopifyToken(token, key, shop);
  assert.notEqual(encrypted.ciphertext, token);
  assert.equal(await decryptShopifyToken(encrypted.ciphertext, encrypted.iv, key, shop), token);
  await assert.rejects(
    decryptShopifyToken(encrypted.ciphertext, encrypted.iv, key, 'other.myshopify.com'),
  );
});

test('Shopify OAuth validation normalizes only permanent store domains and verifies signed callbacks', async () => {
  assert.equal(normalizeShopDomain(' HTTPS://Petvia.myshopify.com/ '), 'petvia.myshopify.com');
  assert.equal(normalizeShopDomain('petvia.com'), null);
  assert.equal(await hashOauthState('state'),
    '4ba69735ca53765ed6a709edb56c6ea236b7193a3b29a6b390c346f0f4340e4e');

  const params = new URLSearchParams({
    code: 'authorization-code',
    shop: 'petvia.myshopify.com',
    state: 'nonce',
    timestamp: '1790935200',
  });
  const message = [...params.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, value]) => `${key}=${value}`).join('&');
  const secret = 'client-secret';
  const signingKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  params.set('hmac', Buffer.from(await crypto.subtle.sign(
    'HMAC', signingKey, new TextEncoder().encode(message),
  )).toString('hex'));
  assert.equal(await verifyShopifyHmac(params, secret), true);
  params.set('shop', 'attacker.myshopify.com');
  assert.equal(await verifyShopifyHmac(params, secret), false);
});

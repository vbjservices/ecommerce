import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

test('one-click import edge function parses and keeps privileged work behind user and membership checks', async () => {
  const source = await readFile('supabase/functions/import-cj-product/index.ts', 'utf8');
  await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: 'supabase/functions/import-cj-product/index.ts',
  });
  assert.match(source, /withSupabase\(\{ auth: 'user' \}/);
  const membershipCheck = source.indexOf("rpc('is_internal_user')");
  const privilegedWrite = source.indexOf("ctx.supabaseAdmin.rpc('ingest_supplier_product'");
  const quotePromotion = source.indexOf("ctx.supabaseAdmin.rpc('promote_discovery_shipping_quotes'");
  assert.ok(membershipCheck > 0);
  assert.ok(privilegedWrite > membershipCheck);
  assert.ok(quotePromotion > privilegedWrite);
  assert.match(source, /Deno\.env\.get\('CJ_API_KEY'\)/);

  const browser = await readFile('src/browser/main.ts', 'utf8');
  assert.match(browser, /body: \{ discoveryCandidateId: candidate\.id \}/);
  assert.doesNotMatch(browser, /CJ_API_KEY|SUPABASE_SERVICE_ROLE_KEY/);

  const config = await readFile('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.import-cj-product\][\s\S]*verify_jwt = true/);
});

test('worldwide shipping edge function checks the supplier catalog in bounded cached batches', async () => {
  const source = await readFile('supabase/functions/quote-cj-shipping/index.ts', 'utf8');
  await transform(source, {
    loader: 'ts', format: 'esm', target: 'es2022',
    sourcefile: 'supabase/functions/quote-cj-shipping/index.ts',
  });
  assert.match(source, /withSupabase\(\{ auth: 'user' \}/);
  assert.ok(source.indexOf("rpc('is_internal_user')") <
    source.indexOf("ctx.supabaseAdmin.rpc('upsert_supplier_shipping_quotes'"));
  assert.match(source, /const allCjDestinations = \[/);
  assert.match(source, /const destinationBatchSize = 8/);
  assert.match(source, /supplier_shipping_quotes/);
  assert.match(source, /discovery_shipping_quotes/);
  assert.match(source, /upsert_discovery_shipping_quotes/);
  assert.match(source, /discoveryCandidateId/);
  assert.match(source, /\/logistic\/freightCalculate/);
  assert.match(source, /Deno\.env\.get\('CJ_API_KEY'\)/);

  const browser = await readFile('src/browser/main.ts', 'utf8');
  assert.match(browser, /functions\.invoke\('quote-cj-shipping'/);
  assert.match(browser, /Continue worldwide shipping scan/);
  assert.doesNotMatch(browser, /CJ_API_KEY|SUPABASE_SERVICE_ROLE_KEY/);

  const config = await readFile('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.quote-cj-shipping\][\s\S]*verify_jwt = true/);
});

test('product review edge function keeps approval behind verified identity and membership', async () => {
  const source = await readFile('supabase/functions/review-product/index.ts', 'utf8');
  await transform(source, {
    loader: 'ts', format: 'esm', target: 'es2022',
    sourcefile: 'supabase/functions/review-product/index.ts',
  });
  assert.match(source, /withSupabase\(\{ auth: 'user' \}/);
  const identity = source.indexOf('ctx.userClaims?.id');
  const membership = source.indexOf("rpc('is_internal_user')");
  const write = source.indexOf("ctx.supabaseAdmin.rpc('review_product_candidate'");
  assert.ok(identity > 0);
  assert.ok(membership > identity);
  assert.ok(write > membership);
  assert.doesNotMatch(source, /SHOPIFY_CLIENT_SECRET|SUPABASE_SERVICE_ROLE_KEY/);

  const browser = await readFile('src/browser/main.ts', 'utf8');
  assert.match(browser, /functions\.invoke\('review-product'/);
  assert.match(browser, /Approve for Shopify draft/);

  const config = await readFile('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.review-product\][\s\S]*verify_jwt = true/);
});

test('Shopify draft function records intent, keeps credentials server-side, and reconciles mappings', async () => {
  const source = await readFile('supabase/functions/publish-shopify-draft/index.ts', 'utf8');
  await transform(source, {
    loader: 'ts', format: 'esm', target: 'es2022',
    sourcefile: 'supabase/functions/publish-shopify-draft/index.ts',
  });
  assert.match(source, /withSupabase\(\{ auth: 'user' \}/);
  const membership = source.indexOf("rpc('is_internal_user')");
  const intent = source.indexOf("rpc('begin_shopify_draft_listing'");
  const provider = source.indexOf('syncDraft(store');
  const reconciliation = source.indexOf("rpc('complete_shopify_draft_listing'");
  assert.ok(membership > 0);
  assert.ok(intent > membership);
  assert.ok(provider > intent);
  assert.ok(reconciliation > provider);
  assert.match(source, /Deno\.env\.get\('SHOPIFY_TOKEN_ENCRYPTION_KEY'\)/);
  assert.match(source, /rpc\('get_shopify_connection'/);
  assert.match(source, /decryptShopifyToken/);
  assert.match(source, /status: 'draft'/);

  const browser = await readFile('src/browser/main.ts', 'utf8');
  assert.match(browser, /functions\.invoke\('publish-shopify-draft'/);
  assert.match(browser, /body: \{ candidateId: candidate\.id, salesChannelId: connectedChannel\?\.id \}/);
  assert.doesNotMatch(browser, /SHOPIFY_CLIENT_SECRET|SHOPIFY_CLIENT_ID/);

  const config = await readFile('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.publish-shopify-draft\][\s\S]*verify_jwt = true/);
});

test('Shopify connection uses authenticated OAuth start, verified public callback, and encrypted token storage', async () => {
  const start = await readFile('supabase/functions/start-shopify-connection/index.ts', 'utf8');
  const callback = await readFile('supabase/functions/shopify-oauth-callback/index.ts', 'utf8');
  const crypto = await readFile('supabase/functions/_shared/shopify-oauth.ts', 'utf8');
  for (const [source, sourcefile] of [
    [start, 'supabase/functions/start-shopify-connection/index.ts'],
    [callback, 'supabase/functions/shopify-oauth-callback/index.ts'],
    [crypto, 'supabase/functions/_shared/shopify-oauth.ts'],
  ] as const) await transform(source, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile });

  assert.match(start, /withSupabase\(\{ auth: 'user' \}/);
  assert.ok(start.indexOf("rpc('is_internal_user')") < start.indexOf("rpc('create_shopify_oauth_state'"));
  assert.match(start, /scope', 'write_products'/);
  assert.match(callback, /verifyShopifyHmac/);
  assert.match(callback, /rpc\('consume_shopify_oauth_state'/);
  assert.match(callback, /expiring: 0/);
  assert.match(callback, /encryptShopifyToken/);
  assert.match(callback, /rpc\('connect_shopify_channel'/);
  assert.doesNotMatch(callback, /console\.(?:log|error).*token/);

  const browser = await readFile('src/browser/main.ts', 'utf8');
  assert.match(browser, /functions\.invoke\('start-shopify-connection'/);
  assert.doesNotMatch(browser, /SHOPIFY_CLIENT_SECRET|SHOPIFY_TOKEN_ENCRYPTION_KEY/);

  const config = await readFile('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.start-shopify-connection\][\s\S]*verify_jwt = true/);
  assert.match(config, /\[functions\.shopify-oauth-callback\][\s\S]*verify_jwt = false/);
});

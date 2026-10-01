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
  assert.ok(membershipCheck > 0);
  assert.ok(privilegedWrite > membershipCheck);
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
  assert.match(source, /const destinationBatchSize = 20/);
  assert.match(source, /supplier_shipping_quotes/);
  assert.match(source, /\/logistic\/freightCalculate/);
  assert.match(source, /Deno\.env\.get\('CJ_API_KEY'\)/);

  const browser = await readFile('src/browser/main.ts', 'utf8');
  assert.match(browser, /functions\.invoke\('quote-cj-shipping'/);
  assert.match(browser, /Continue worldwide shipping scan/);
  assert.doesNotMatch(browser, /CJ_API_KEY|SUPABASE_SERVICE_ROLE_KEY/);

  const config = await readFile('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.quote-cj-shipping\][\s\S]*verify_jwt = true/);
});

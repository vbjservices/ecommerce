import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const member = '00000000-0000-4000-8000-000000000001';
const rpcSql = 'select * from public.persist_discovery_run($1, $2, $3::jsonb)';

async function migrate(db: PGlite) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    insert into auth.users values ('${member}');
  `);
  for (const file of (await readdir('supabase/migrations')).sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  }
  await db.exec(`insert into private.internal_users(user_id) values ('${member}')`);
}

function runPayload() {
  return {
    profile_id: 'pets',
    original_query: 'cat toy',
    status: 'completed',
    configuration_version: 'discovery-v2.0',
    scoring_version: 'supplier-opportunity-v2.0',
    started_at: '2026-09-30T10:00:00Z',
    completed_at: '2026-09-30T10:01:00Z',
    cache_expires_at: '2026-09-30T16:01:00Z',
    budget: { maxApiRequests: 4 },
    metrics: { apiRequestsUsed: 1, uniqueProductsFound: 1 },
    warnings: [],
    queries: [{
      query: 'cat toy', source: 'original', confidence: 1, reason: 'original user query',
    }],
    candidates: [{
      external_product_id: 'cj-product-1',
      title: 'Interactive Cat Toy',
      image_url: 'https://example.com/cat.jpg',
      source_url: 'https://example.com/product',
      eligibility_status: 'pass',
      relevance_level: 'exact',
      score: 82,
      confidence: 91,
      coverage: 95,
      assessment: { scoringVersion: 'supplier-opportunity-v2.0', risks: [] },
      occurrences: [{
        strategy: 'original_query', query: 'cat toy', query_source: 'original',
        page: 1, rank: 1, sort_by: 'relevance', filters: {}, source: 'fixture-api',
        retrieved_at: '2026-09-30T10:00:30Z',
      }],
      observation: {
        observed_at: '2026-09-30T10:00:30Z', source: 'fixture-api',
        supplier_cost_min: '3.00', supplier_cost_max: '5.00', currency: 'USD',
        listing_count: 100, inventory: 1000, verified_inventory: 900,
        unverified_inventory: 100, delivery_days_min: 3, delivery_days_max: 5,
        sale_status: 'on_sale', visible: true,
        normalized_snapshot: {
          externalProductId: 'cj-product-1',
          title: 'Interactive Cat Toy',
          imageUrl: 'https://example.com/cat.jpg',
          imageUrls: [
            'https://example.com/cat.jpg',
            'https://example.com/cat-side.jpg',
          ],
        },
      },
    }],
    source_pages: [{
      strategy: 'original_query', query: 'cat toy', page: 1, source: 'fixture-api',
      retrieved_at: '2026-09-30T10:00:30Z', raw_payload: { requestId: 'private-raw' },
    }],
  };
}

async function asRole<T>(db: PGlite, role: string, userId: string, action: () => Promise<T>) {
  await db.exec('begin');
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const result = await action();
    await db.exec('commit');
    return result;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

test('discovery persistence is atomic, retains provenance, and keeps raw pages private', async () => {
  const db = new PGlite();
  await migrate(db);
  try {
    await assert.rejects(asRole(db, 'authenticated', member, () =>
      db.query(rpcSql, ['cj', 'CJdropshipping', JSON.stringify(runPayload())])), /permission denied/);
    await assert.rejects(asRole(db, 'service_role', '', () => db.exec(
      "insert into public.discovery_runs(supplier_id,profile_id,original_query,status,configuration_version,scoring_version,started_at,completed_at,cache_expires_at,budget,metrics) select id,'pets','bypass','completed','v','v',now(),now(),now(),'{}','{}' from public.suppliers limit 1",
    )), /permission denied/);

    const saved = await asRole(db, 'service_role', '', () => db.query<{
      run_id: string; candidate_count: number; observation_count: number;
    }>(rpcSql, ['cj', 'CJdropshipping', JSON.stringify(runPayload())]));
    assert.equal(saved.rows[0]!.candidate_count, 1);
    assert.equal(saved.rows[0]!.observation_count, 1);

    for (const [table, expected] of [
      ['discovery_runs', 1],
      ['discovery_queries', 1],
      ['discovery_candidates', 1],
      ['discovery_occurrences', 1],
      ['supplier_product_observations', 1],
    ] as const) {
      const count = await db.query<{ count: number }>(`select count(*)::int as count from public.${table}`);
      assert.equal(count.rows[0]!.count, expected, table);
    }
    const snapshots = await db.query<{ count: number }>(
      'select count(*)::int as count from private.discovery_snapshots',
    );
    assert.equal(snapshots.rows[0]!.count, 1);
    await assert.rejects(asRole(db, 'service_role', '', () =>
      db.exec('delete from public.discovery_runs')), /permission denied/);
    await assert.rejects(asRole(db, 'authenticated', member, () =>
      db.query('select * from private.discovery_snapshots')), /permission denied/);

    const memberCandidates = await asRole(db, 'authenticated', member, () =>
      db.query<{ title: string; score: string; image_urls: string[] }>(
        'select title,score::text,image_urls from public.discovery_candidates',
      ));
    assert.deepEqual(memberCandidates.rows, [{
      title: 'Interactive Cat Toy',
      score: '82.00',
      image_urls: ['https://example.com/cat.jpg', 'https://example.com/cat-side.jpg'],
    }]);

    const invalid = runPayload();
    invalid.candidates.push(structuredClone(invalid.candidates[0]!));
    await assert.rejects(asRole(db, 'service_role', '', () =>
      db.query(rpcSql, ['cj', 'CJdropshipping', JSON.stringify(invalid)])), /unique constraint/);
    const runsAfterFailure = await db.query<{ count: number }>(
      'select count(*)::int as count from public.discovery_runs',
    );
    assert.equal(runsAfterFailure.rows[0]!.count, 1);
  } finally {
    await db.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPublicConfig } from '../src/browser/config';
import { readCjConfig, readOptionalOllamaConfig, readServerConfig } from '../src/server/config';
import { checkAccess } from '../src/browser/auth';
import { readRecentCandidates, readRecentDiscoveryCandidates } from '../src/browser/workspace-repository';
import { isWorkspaceSnapshotFresh, WORKSPACE_CACHE_TTL_MS, type WorkspaceSnapshot } from '../src/browser/workspace-cache';

const publicEnv = { PUBLIC_SUPABASE_URL: 'https://example.supabase.co', PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TEST_ONLY' };
const jwt = (role: string) => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;

test('configuration fails clearly without echoing values or accepting privileged browser keys', () => {
  assert.throws(() => readPublicConfig({}), /Missing PUBLIC_SUPABASE_URL/);
  for (const key of ['sb_secret_TEST_ONLY', jwt('service_role'), 'invalid']) {
    assert.throws(() => readPublicConfig({ ...publicEnv, PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }), /Privileged keys are forbidden/);
  }
  assert.equal(readPublicConfig(publicEnv).supabaseUrl, publicEnv.PUBLIC_SUPABASE_URL);
  assert.equal(readPublicConfig({ ...publicEnv, PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt('anon') }).supabasePublishableKey, jwt('anon'));
  assert.throws(() => readPublicConfig({ ...publicEnv, PUBLIC_SUPABASE_URL: 'https://user:private@example.com' }), /HTTPS origin/);
  assert.throws(() => readPublicConfig({ ...publicEnv, PUBLIC_SUPABASE_URL: 'http://example.com' }), /HTTPS origin/);
  assert.equal(readPublicConfig({ ...publicEnv, PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }).supabaseUrl, 'http://127.0.0.1:54321');
  assert.throws(() => readServerConfig({ SUPABASE_URL: publicEnv.PUBLIC_SUPABASE_URL }), /Missing SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => readServerConfig({ SUPABASE_URL: publicEnv.PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: jwt('anon') }), /must be a secret/);
  assert.throws(() => readCjConfig({}), /Missing CJ_API_KEY/);
  assert.equal(readCjConfig({ CJ_API_KEY: 'private-cj-key' }).apiKey, 'private-cj-key');
  assert.equal(readOptionalOllamaConfig({}), null);
  assert.deepEqual(readOptionalOllamaConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'local-5b' }), {
    baseUrl: 'http://127.0.0.1:11434', model: 'local-5b',
  });
  assert.throws(() => readOptionalOllamaConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' }), /configured together/);
});

function authClient(session: boolean, user: boolean, membership: boolean, rpcError = false) {
  let rpcCalls = 0;
  return {
    calls: () => rpcCalls,
    client: {
      auth: {
        getSession: async () => ({ data: { session: session ? {} : null }, error: null }),
        getUser: async () => ({ data: { user: user ? { id: '00000000-0000-4000-8000-000000000001', email: 'test@example.com' } : null }, error: user ? null : new Error() }),
      },
      rpc: async () => { rpcCalls++; return { data: membership, error: rpcError ? new Error() : null }; },
    } as unknown as SupabaseClient,
  };
}

test('dashboard checks verified identity and explicit membership; fails closed', async () => {
  const anon = authClient(false, false, false);
  assert.deepEqual(await checkAccess(anon.client), { status: 'signed_out' });
  assert.equal(anon.calls(), 0);
  const invalid = authClient(true, false, true);
  await assert.rejects(checkAccess(invalid.client), /could not be verified/);
  assert.equal(invalid.calls(), 0);
  assert.deepEqual(await checkAccess(authClient(true, true, false).client), { status: 'denied' });
  assert.deepEqual(await checkAccess(authClient(true, true, true).client), {
    status: 'authorized',
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'test@example.com',
  });
  await assert.rejects(checkAccess(authClient(true, true, true, true).client), /could not be checked/);
});

test('repository does not convert failed or malformed reads into a valid empty workspace', async () => {
  const client = (data: unknown, error: unknown) => ({ from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data, error }) }) }) }) }) as unknown as SupabaseClient;
  await assert.rejects(readRecentCandidates(client(null, new Error('raw secret error'))), /^Error: Candidates could not be loaded/);
  await assert.rejects(readRecentCandidates(client([{ status: 'invented' }], null)), /expected format/);
  assert.deepEqual(await readRecentCandidates(client([], null)), []);
  const row = {
    id: '00000000-0000-4000-8000-000000000010',
    status: 'discovered',
    created_at: '2026-09-29T10:00:00Z',
    products: {
      title: 'Candidate',
      image_url: 'https://cf.cjdropshipping.com/product/candidate.jpg',
      image_urls: [
        'https://cf.cjdropshipping.com/product/candidate.jpg',
        'https://cf.cjdropshipping.com/product/candidate-side.jpg',
      ],
    },
    supplier_products: {
      external_product_id: 'supplier-product',
      source_url: 'https://example.com/product',
      last_seen_at: '2026-09-29T10:00:00Z',
      suppliers: { name: 'Supplier' },
      supplier_variants: [{ cost: 3.16, currency: 'USD', stock: 10 }],
    },
  };
  assert.deepEqual(await readRecentCandidates(client([row], null)), [row]);
});

test('repository stays readable during the additive product image migration', async () => {
  let calls = 0;
  const row = {
    id: '00000000-0000-4000-8000-000000000010',
    status: 'discovered',
    created_at: '2026-09-29T10:00:00Z',
    products: { title: 'Candidate' },
    supplier_products: {
      external_product_id: 'supplier-product', source_url: null,
      last_seen_at: '2026-09-29T10:00:00Z', suppliers: { name: 'Supplier' },
      supplier_variants: [],
    },
  };
  const client = {
    from: () => ({ select: () => ({ order: () => ({ limit: async () => {
      calls++;
      return calls < 3
        ? { data: null, error: { code: '42703' } }
        : { data: [row], error: null };
    } }) }) }),
  } as unknown as SupabaseClient;
  assert.deepEqual(await readRecentCandidates(client), [{
    ...row, products: { ...row.products, image_url: null, image_urls: [] },
  }]);
  assert.equal(calls, 3);
});

test('discovery read model tolerates an undeployed migration and validates deployed rows', async () => {
  const client = (data: unknown, error: unknown) => ({
    from: () => ({ select: () => ({ order: () => ({ order: () => ({
      limit: async () => ({ data, error }),
    }) }) }) }),
  }) as unknown as SupabaseClient;
  assert.deepEqual(await readRecentDiscoveryCandidates(client(null, { code: '42P01' })), []);
  await assert.rejects(readRecentDiscoveryCandidates(client([{ score: 'invalid' }], null)), /expected format/);
  const row = {
    id: '00000000-0000-4000-8000-000000000020',
    rank: 1,
    external_product_id: 'cj-product-1',
    title: 'Interactive Cat Toy',
    image_url: null,
    image_urls: [],
    source_url: 'https://example.com/product',
    eligibility_status: 'pass',
    relevance_level: 'exact',
    score: '82.00',
    confidence: '90.00',
    coverage: '95.00',
    suppliers: { name: 'Supplier' },
    discovery_runs: {
      original_query: 'cat toy', profile_id: 'pets', completed_at: '2026-09-30T10:00:00Z',
    },
    discovery_occurrences: [{ strategy: 'original_query' }],
    supplier_product_observations: [{
      supplier_cost_min: '3.00', supplier_cost_max: '5.00', currency: 'USD',
      listing_count: 100, inventory: 1_000, verified_inventory: 900,
      delivery_days_min: 3, delivery_days_max: 5,
    }],
    assessment: {
      positiveEvidence: ['Strong relevance.'],
      unknownEvidence: ['External demand is unknown.'],
      eligibility: { reasons: ['Passes current gates.'] },
      risks: [],
    },
  };
  assert.deepEqual(await readRecentDiscoveryCandidates(client([row], null)), [row]);
});

test('discovery read model falls back to the primary image until galleries are migrated', async () => {
  let calls = 0;
  const row = {
    id: '00000000-0000-4000-8000-000000000020',
    rank: 1,
    external_product_id: 'cj-product-1',
    title: 'Interactive Cat Toy',
    image_url: 'https://example.com/cat.jpg',
    source_url: null,
    eligibility_status: 'pass',
    relevance_level: 'exact',
    score: '82.00', confidence: '90.00', coverage: '95.00',
    suppliers: { name: 'Supplier' },
    discovery_runs: { original_query: 'cat toy', profile_id: 'pets', completed_at: '2026-09-30T10:00:00Z' },
    discovery_occurrences: [],
    supplier_product_observations: [],
    assessment: {
      positiveEvidence: [], unknownEvidence: [], eligibility: { reasons: [] }, risks: [],
    },
  };
  const client = {
    from: () => ({ select: () => ({ order: () => ({ order: () => ({
      limit: async () => {
        calls++;
        return calls === 1
          ? { data: null, error: { code: '42703' } }
          : { data: [row], error: null };
      },
    }) }) }) }),
  } as unknown as SupabaseClient;
  assert.deepEqual(await readRecentDiscoveryCandidates(client), [{
    ...row, image_urls: ['https://example.com/cat.jpg'],
  }]);
  assert.equal(calls, 2);
});

test('workspace cache is page-memory only and expires after five minutes', () => {
  const fetchedAt = 1_000_000;
  const snapshot: WorkspaceSnapshot = {
    access: { status: 'authorized', userId: '00000000-0000-4000-8000-000000000001', email: 'test@example.com' },
    candidates: [],
    discoveryCandidates: [],
    fetchedAt,
  };
  assert.equal(isWorkspaceSnapshotFresh(snapshot, fetchedAt), true);
  assert.equal(isWorkspaceSnapshotFresh(snapshot, fetchedAt + WORKSPACE_CACHE_TTL_MS - 1), true);
  assert.equal(isWorkspaceSnapshotFresh(snapshot, fetchedAt + WORKSPACE_CACHE_TTL_MS), false);
  assert.equal(isWorkspaceSnapshotFresh(snapshot, fetchedAt - 1), false);
  assert.equal(isWorkspaceSnapshotFresh(null, fetchedAt), false);
});

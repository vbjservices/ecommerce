import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPublicConfig } from '../src/browser/config';
import { readServerConfig } from '../src/server/config';
import { checkAccess } from '../src/browser/auth';
import { readRecentCandidates } from '../src/browser/workspace-repository';

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
});

function authClient(session: boolean, user: boolean, membership: boolean, rpcError = false) {
  let rpcCalls = 0;
  return {
    calls: () => rpcCalls,
    client: {
      auth: {
        getSession: async () => ({ data: { session: session ? {} : null }, error: null }),
        getUser: async () => ({ data: { user: user ? { email: 'test@example.com' } : null }, error: user ? null : new Error() }),
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
  assert.equal((await checkAccess(authClient(true, true, true).client)).status, 'authorized');
  await assert.rejects(checkAccess(authClient(true, true, true, true).client), /could not be checked/);
});

test('repository does not convert failed or malformed reads into a valid empty workspace', async () => {
  const client = (data: unknown, error: unknown) => ({ from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data, error }) }) }) }) }) as unknown as SupabaseClient;
  await assert.rejects(readRecentCandidates(client(null, new Error('raw secret error'))), /^Error: Candidates could not be loaded/);
  await assert.rejects(readRecentCandidates(client([{ status: 'invented' }], null)), /expected format/);
  assert.deepEqual(await readRecentCandidates(client([], null)), []);
});

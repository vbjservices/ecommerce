import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]))).flat();
}

test('domain is independent of providers, persistence, and UI; ports depend only on domain', async () => {
  for (const file of [...await files('src/domain'), ...await files('src/application/ports')]) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        const target = match[1]!;
        assert.ok(target.startsWith('.'), `${file}: third-party dependency ${target}`);
        assert.ok(!/server|browser|supabase|integrations/.test(target), `${file}: invalid domain dependency`);
    }
    assert.ok(!/shopify_|cj_/i.test(source), `${file}: provider identity leaked into domain`);
  }
});

test('secret-bearing environment files are ignored while the names-only example is trackable', () => {
  const paths = ['.env', '.env.local', '.env.production', '.env.staging.local', 'src/server/.env', 'src/browser/.env.production'];
  const output = execFileSync('git', ['check-ignore', '--no-index', ...paths], { encoding: 'utf8' });
  for (const path of paths) assert.ok(output.includes(path));
  assert.throws(() => execFileSync('git', ['check-ignore', '--no-index', '.env.example'], { stdio: 'pipe' }));
});

test('browser build refuses a transitive server import', async () => {
  await assert.rejects(build({
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input: resolve('tests/fixtures/browser-server-import.ts') } },
  }), /Server-only code/);
});

test('browser bundle contains only explicitly allowed public config, never server or unrelated env', async () => {
  const env = {
    PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_BUILD_TEST_ONLY',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_SERVER_CANARY_DO_NOT_SHIP',
    PUBLIC_UNRELATED_SECRET: 'CANARY_NOT_ALLOWLISTED',
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const result = await build({ logLevel: 'silent', build: { write: false } });
    const output = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []);
    const bundle = output.map(item => item.type === 'chunk' ? item.code : String(item.source)).join('\n');
    const html = output.find(item => item.type === 'asset' && item.fileName === 'index.html');
    const htmlSource = html?.type === 'asset' ? String(html.source) : '';
    assert.ok(bundle.includes(env.PUBLIC_SUPABASE_URL));
    assert.ok(bundle.includes(env.PUBLIC_SUPABASE_PUBLISHABLE_KEY));
    assert.ok(!bundle.includes(env.SUPABASE_SERVICE_ROLE_KEY));
    assert.ok(!bundle.includes(env.PUBLIC_UNRELATED_SECRET));
    assert.ok(!bundle.includes('createPrivilegedDatabase'));
    assert.match(htmlSource, /Content-Security-Policy/);
    assert.match(htmlSource, /default-src (?:'|&#39;)none(?:'|&#39;)/);
    assert.match(htmlSource, /connect-src https:\/\/example\.supabase\.co wss:\/\/example\.supabase\.co/);
    assert.doesNotMatch(htmlSource, /unsafe-inline|unsafe-eval/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

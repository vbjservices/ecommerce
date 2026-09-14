# Ecommerce platform

A small internal ecommerce foundation: a static dashboard on GitHub Pages, Supabase PostgreSQL/Auth for persistent state and access, and TypeScript boundaries for future server-side integrations.

CJ is the first planned supplier. Shopify is the first planned sales channel. Neither defines our products, candidates, or orders.

## Run

Requires Node 24.13+ (24.x) and npm. On Windows PowerShell, use `npm.cmd` if script execution is restricted.

```sh
npm ci
npm run dev
```

Without configuration the page displays **Workspace setup pending**. To enable sign-in, follow [Supabase setup](docs/setup.md). No demo credentials, users, or business records are created.

## Structure

```text
src/
  domain/                 provider-neutral products, variants, candidates, suppliers,
                          sales channels, mappings, and order contracts
  application/ports/      SupplierAdapter and SalesChannelAdapter contracts
  browser/                minimal dashboard, Auth, narrow read repository
  config/                 shared configuration validation (no environment access)
  server/                 privileged Supabase client and health command
supabase/
  migrations/             schema, constraints, grants, RLS, restricted raw snapshots
  config.toml             local Supabase settings
tests/                    configuration, Auth, dependency, bundle, PostgreSQL/RLS tests
scripts/                  static Pages artifact staging/checking
docs/                     setup, architecture, and next implementation instructions
index.html + assets/      generated GitHub Pages output; do not edit by hand
```

## Checks and publishing

```sh
npm test
npm run pages:build
npm run check
```

GitHub Pages stays configured as **Deploy from a branch → main → / (root)**. `pages:build` compiles the browser into `dist/` and stages only its entry page and assets at the repository root. Commit those generated files with source changes, then push `main`. `.nojekyll` enables static serving. Relative asset paths work at `/ecommerce/` without a router or server rewrite.

CI tests the foundation and rejects stale committed Pages output. With a configured deployment, set the two matching public configuration repository variables described in [setup](docs/setup.md). No privileged credentials are needed by the browser build or CI.

Tests run migrations in ephemeral PostgreSQL through PGlite with a minimal Supabase Auth-role harness. They require no Docker, cloud account, or production data. They do **not** test hosted Auth, PostgREST, or the complete Supabase stack; the setup guide includes that smoke check.

## Scope

Implemented: sign-in/out and session checks, explicit internal membership, five-minute in-memory workspace caching, quiet stale refreshes, a restrictive production Content Security Policy, read-only recent candidates, neutral domain/adapter contracts, source-ID mappings, private historical raw snapshots, migrations, and security tests.

Deferred: provider implementations, ingestion/normalization workflows, scoring, approval writes/audit workflow, listing persistence, order persistence, webhooks, queues, shipping quotes, purchasing, fulfillment, and tracking. There is no public signup or multi-tenant system.

Next: [CJ ingestion into products, variants, and candidates](docs/architecture.md#next-implementation).

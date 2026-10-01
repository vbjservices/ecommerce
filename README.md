# Ecommerce platform

A small internal ecommerce foundation: a static dashboard on GitHub Pages, Supabase PostgreSQL/Auth for persistent state and access, and TypeScript boundaries for future server-side integrations.

CJ is the first supplier integration. Shopify is the selected first sales channel, with Europe as the initial shipping market. Neither defines our products, candidates, or orders.

## Run

Requires Node 24.13+ (24.x) and npm. On Windows PowerShell, use `npm.cmd` if script execution is restricted.

```sh
npm ci
npm run dev
```

Trusted CJ tools use server-only environment values:

```sh
npm run cj:search -- "cat toy"   # ranked preview; no database writes
npm run cj:import -- PRODUCT_ID  # atomic candidate ingestion
npm run cj:discover -- "cat toy" --profile=pets  # budgeted V2 run persisted to Supabase
```

See [product discovery and search](docs/discovery.md) for current behavior and the [Discovery V2 implementation specification](docs/discovery-v2-implementation-spec.md) for the approved next-stage brief.

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

Implemented: sign-in/out and session checks, explicit internal membership, five-minute in-memory workspace caching, quiet stale refreshes, a restrictive production Content Security Policy, separate Discovery and Imported products dashboard tabs, hover-only automatic/manual product-image galleries, supplier cost/stock/activity/delivery overviews, explicit unknown shipping status, an authenticated one-click CJ import Edge Function, neutral domain/adapter contracts, CJ product/variant/inventory/media reads, atomic idempotent supplier ingestion, and Discovery V2 foundations: configurable niche profiles, original-intent query planning, controlled deterministic expansion, optional Ollama expansion, budgeted multi-strategy pagination and shortlist media enrichment, provenance-preserving deduplication, separate relevance/eligibility/scoring, score/confidence/coverage, durable discovery runs, timestamped supplier observations, private raw snapshots, and an explainable dashboard shortlist.

Deferred: scheduling, external research/scraping adapters, destination shipping quotes, landed-cost economics, approval writes/audit workflow, listing persistence, order persistence, webhooks, queues, purchasing, fulfillment, maintenance, and tracking. There is no public signup or multi-tenant system.

Next: calibrate Discovery V2 with real runs and operator feedback, then add destination-specific Europe shipping quotes before human review and Shopify publishing.

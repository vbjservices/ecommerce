# Architecture decisions

## Context and precedence

Read the repository's [parent issue #1](https://github.com/vbjservices/ecommerce/issues/1), [discovery #2](https://github.com/vbjservices/ecommerce/issues/2), [research #3](https://github.com/vbjservices/ecommerce/issues/3), [review #4](https://github.com/vbjservices/ecommerce/issues/4), [suppliers #5](https://github.com/vbjservices/ecommerce/issues/5), [orders #6](https://github.com/vbjservices/ecommerce/issues/6), [jobs #7](https://github.com/vbjservices/ecommerce/issues/7), [conventions #8](https://github.com/vbjservices/ecommerce/issues/8), and [Supabase #9](https://github.com/vbjservices/ecommerce/issues/9) before implementation.

The current foundation request supersedes the parent issue's local database and Shopify-specific schema suggestions. Supabase owns state; GitHub Pages owns static dashboard hosting; the Mac mini will execute privileged work. Only foundations are implemented here, not the full acceptance criteria of every architecture issue.

## Runtime and dependency direction

```text
GitHub Pages → browser → Supabase Auth + RLS-protected reads

future Mac mini API/workers → application services → adapter contracts
                                     │                  │
                                     ▼                  ▼
                              Supabase repositories   CJ / Shopify / future
                                     │
                              internal domain
```

A single npm package and strict TypeScript keep this small. The dashboard uses Vite and semantic HTML; no server renderer, router, component framework, local business database, or distributed framework is needed for this slice. Future application services belong in `src/application/`; concrete HTTP/provider adapters and write repositories belong under `src/server/`.

The domain imports only domain types. Ports import the domain. Browser code never imports `src/server/`: both the build and tests enforce this. Shared configuration validators receive explicit values and do not read environment variables themselves.

## Identity and persistence

Products and variants have internal UUIDs. Supplier products/variants are explicit mappings with provider-scoped uniqueness; composite foreign keys prevent attaching another product's variant/candidate to a supplier product. Titles and variant array positions are never identities. Multiple configured connections can share a sales-channel provider.

Candidate review state is independent of listing state. `approved` does not mean published or even draft-created. The current database requires an authenticated actor and timestamp for approved/rejected states, but full transition policy, audit history, and idempotency belong in the later trusted review service/migration. There are no browser write permissions.

`ChannelListing` anticipates internal-product and variant-to-external-listing mappings scoped by `salesChannelId`. `Order` has its own UUID, channel connection, external order and line IDs, and nullable variant mappings. Listing and order tables are intentionally deferred until their workflows are implemented. Future uniqueness must include the connection, not just the provider name.

Supplier observations retain provenance and retrieval timestamps. Raw responses go into restricted `private.supplier_snapshots`; service-role access is SELECT/INSERT only on that history table. Unknown cost, currency, stock, and unavailable descriptions stay null. Decimal money uses PostgreSQL numeric and decimal strings at domain boundaries. Do not perform money arithmetic with floating-point numbers. Shipping will have destination/time-specific quote records, never one permanent product shipping price.

We deliberately do not hand-maintain a fake Supabase-generated `Database` type. Narrow browser read models are runtime-validated with Zod. Generate schema types with the Supabase CLI from the migrated development database when implementing write repositories; SQL migrations remain the schema authority.

## Adapter contracts

`SupplierAdapter` optionally exposes `catalog.getProduct` and `discovery.search`. Catalog returns a normalized `SupplierProduct` plus source, timestamp, and raw payload. The application assigns/looks up internal IDs. CJ payload parsing, auth, transport, throttling, and safe retries belong inside its server adapter; scoring and persistence do not.

`SalesChannelAdapter` optionally exposes `drafts.create` and `listings.get`. Capability presence is the only source of truth: there are no flags that can disagree with implemented methods. A read-only channel need not support drafts. A channel without a safe non-public draft capability cannot use the draft workflow. Never substitute a live listing. The draft operation requires an idempotency key and returns explicit variant mappings, but the future application service must persist intent/reconciliation state before any external call.

Do not add a generic publishing/fulfillment framework now. Extend contracts when a real next integration needs a capability. Provider-specific behavior stays inside that adapter. Normalize failures into sanitized `IntegrationError` codes; preserve raw errors only in restricted operational storage. Missing results and provider failures must never become successful empty imports.

## Security

Supabase Auth identifies a user. An active row in `private.internal_users` authorizes workspace reads. Users cannot enroll themselves or change membership, including through custom user metadata. The only exposed helper checks the current JWT user's membership; it is a tightly scoped SECURITY DEFINER function with an empty search path. RLS is evaluated on every read, including direct API calls. Revocation does not require waiting for JWT expiry.

All foundation application tables have RLS. Anonymous access is denied. Authenticated users have SELECT only on dashboard-safe tables, conditional on active membership. Private raw payloads and the membership list are inaccessible to browser roles. Future sensitive customer/order records should remain private unless a deliberate minimal read model is required.

Dashboard Auth persists in tab-scoped sessionStorage, validates identity with `getUser`, and checks membership before querying candidates. Authorized workspace results are cached only in memory for five minutes. Returning to a tab keeps the current screen; stale results refresh in the background, while sign-out clears the cache immediately. RLS, not the page or cache, enforces API security. Supabase tokens are still accessible to JavaScript: the production page uses a restrictive Content Security Policy, has no third-party scripts, uses textContent for untrusted values, and must not render supplier HTML without sanitization.

Only `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` can be embedded by the build. Public config rejects secret/service-role keys. The server client reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (also accepts the modern secret-key format), disables session persistence, and must not receive arbitrary caller Authorization headers. It bypasses RLS; future backend requests must verify users and authorization separately before using it. No privileged HTTP endpoint exists yet.

All secret-bearing `.env*` files are ignored, including nested ones. `.env.example` has empty assignments only. Pages assets, public keys, and all tracked repository content must be treated as public. A static host cannot conceal server credentials or source files accidentally committed to its publication root.

## Next implementation

Implement one bounded **CJ product-by-ID ingestion** slice, using a development Supabase project:

1. Add `src/server/integrations/suppliers/cj/` with authenticated HTTP reads, input validation, fixture-tested normalization, sanitized errors, and catalog capability.
2. Add a trusted ingestion service and repository transaction/RPC for deterministic supplier-ID deduplication, product/variant mappings, private raw snapshots, provenance, and one candidate. Handle variant partial failures explicitly. Do not use a series of independent browser writes.
3. Prove repeat imports do not duplicate identities and unknown values remain unknown. Add local Supabase integration tests for the transaction and repository.
4. Show the real ingested candidate in the existing protected dashboard. Add needed read fields deliberately.
5. Then implement authenticated review, audit events, durable draft intent/idempotency, and the Shopify draft adapter. Keep candidate review and channel listing outcomes separate.

Do not add scoring, bulk discovery, purchases, or customer-facing publication to this slice.

# Supabase and GitHub Pages setup

## 1. Create a development Supabase project

Keep development and production projects separate. The foundation does not create cloud resources or apply production migrations automatically.

Use Node 24.x. CLI examples are pinned for reproducibility (`npx.cmd` on restricted Windows PowerShell):

```sh
npx --yes supabase@2.117.0 login
npx --yes supabase@2.117.0 link --project-ref YOUR_PROJECT_REF
npx --yes supabase@2.117.0 db push --dry-run
npx --yes supabase@2.117.0 db push
```

Use the CLI's interactive prompts for credentials; never add passwords or tokens to these commands or tracked files. Review the linked project before pushing. This applies the version-controlled foundation migration and records it in Supabase migration history. Future schema changes get new migration files; do not edit an applied migration.

For an entirely local stack, start Docker and run `npx --yes supabase@2.117.0 start`. The committed config already initializes the project. `npx --yes supabase@2.117.0 db reset --local` recreates **local** data from migrations and deletes existing local development records; never use this to reset a hosted project. Docker is optional for unit/RLS tests.

## 2. Restrict Auth and provision an internal user

In the hosted project's Authentication settings:

- Disable new user signup and anonymous sign-ins. The committed `config.toml` sets these for local development; it does **not** change a hosted project's Auth settings.
- Set the Site URL to `https://vbjservices.github.io/ecommerce/` for the deployed dashboard, or the local development URL for the development project.
- Create a confirmed email/password user using the administrative Auth user controls. This version supports password sign-in only; magic links, invites, password recovery, and OAuth callbacks are intentionally not implemented.
- In the SQL Editor, insert that user's UUID into the allowlist, using your own Auth user's ID:

```sql
insert into private.internal_users (user_id)
values ('REPLACE_WITH_AUTH_USER_UUID');
```

Membership is a deliberate operator data change, not a seeded production identity. To revoke access:

```sql
update private.internal_users
set active = false
where user_id = 'REPLACE_WITH_AUTH_USER_UUID';
```

Do not expose the `private` schema through the Data API. Keep exposed schemas at the Supabase defaults; the browser uses `public` only. A future server ingestion transaction can access private data through narrowly granted RPCs; do not expose the whole schema just to write snapshots.

## 3. Configure the dashboard

Copy `.env.example` to the ignored `.env.local`. Set:

| Variable | Value/use |
| --- | --- |
| `PUBLIC_SUPABASE_URL` | Project URL from Supabase project settings |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe publishable key; legacy anon also accepted |
| `SUPABASE_URL` | Same project URL, only needed for trusted server tools |
| `SUPABASE_SERVICE_ROLE_KEY` | Server secret or legacy service-role key, only for trusted tools |
| `CJ_API_KEY` | CJ API key, only needed for trusted CJ ingestion and discovery |
| `SHOPIFY_STORE_DOMAIN` | Permanent `store-name.myshopify.com` domain; used only by the Shopify Edge Function |
| `SHOPIFY_CLIENT_ID` | Shopify Dev Dashboard app client ID; server-only |
| `SHOPIFY_CLIENT_SECRET` | Shopify Dev Dashboard app client secret; server-only |
| `OLLAMA_BASE_URL` | Optional Ollama HTTP(S) origin for query expansion, such as `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Optional local model name; configure together with `OLLAMA_BASE_URL` |

Leave server-only fields empty when working only on the dashboard. Public configuration is intentionally visible in browser JavaScript. Never put privileged credentials in any `PUBLIC_` variable. The build exposes exactly the two named public variables and rejects privileged key formats in the public key field. `.env.example` must remain names with empty assignments.

The Supabase Edge Function reads `CJ_API_KEY` from Edge Function Secrets. The local `.env` value is separate: keep it only if you use `npm run cj:search`, `npm run cj:import`, or `npm run cj:discover` from this computer. The dashboard import button does not read the local value.

```sh
npm ci
npm run dev
```

With both public values missing, the dashboard explicitly reports pending setup and makes no Supabase requests. If only one is supplied or a value is unsafe, the dev/build command fails with a configuration error. There is no local fallback database and no fake successful login.

## 4. Verify hosted access

After the migration and configuration:

1. An unauthenticated visit shows the sign-in form with no business data.
2. The provisioned allowlisted user can sign in and sees the empty candidate workspace.
3. A confirmed Auth user without an allowlist row sees “Access not granted.”
4. Revoking membership and refreshing removes workspace access.
5. Sign out; a reload must not restore business data.
6. With server credentials configured, `npm run health` checks a real Supabase table read with a timeout. Missing/invalid configuration and network/schema failures exit nonzero without printing secrets. This is not a full migration-version, Auth, or provider health check.

The automated PGlite tests prove SQL grants, RLS, and constraints with modeled Auth roles. This hosted check separately verifies Supabase Auth/PostgREST deployment wiring.

## 5. Import a CJ product from a trusted machine

Apply all migrations first. The supplier-ingestion migration exposes one service-role-only RPC that atomically writes normalized products, variants, mappings, a candidate, and a private raw snapshot. Browser roles cannot execute it.

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CJ_API_KEY` in the ignored `.env.local` or `.env`, then run:

```sh
npm run cj:search -- "catnip"
npm run cj:import -- 1561984433618694144
npm run cj:discover -- "cat toy" --profile=pets
```

`cj:search` is the legacy read-only preview and does not persist results. `cj:discover` executes the budgeted V2 pipeline and atomically persists its run, query plan, ranked candidates, occurrences, normalized observations, shortlist image galleries, and private raw pages. Apply `20260930000200_discovery_runs.sql`, `20260930000300_product_image_galleries.sql`, `20261001000100_supplier_shipping_quotes.sql`, `20261001000200_product_reviews.sql`, and `20261001000300_shopify_draft_listings.sql` before using every dashboard feature. A CJ product URL is also accepted by the import command. Repeating an import updates the same mapped product, image gallery, and variants, creates another private historical snapshot, and does not duplicate the candidate. The commands never print credentials, access tokens, or raw provider responses.

The image-gallery, shipping-quote, and product-review migrations are safe to retry in the SQL Editor. This matters when an earlier attempt created a helper function or table and then stopped: use the current complete file and run it again rather than deleting existing objects.

### Deploy one-click product import

The dashboard's **Import product** action calls the authenticated `import-cj-product` Supabase Edge Function. In **Edge Functions → Secrets**, add `CJ_API_KEY` with the same private CJ API key used by the CLI. Supabase injects its own URL and secret keys; do not create browser variables for them.

Deploy the committed function from the linked project:

```sh
npx --yes supabase@2.117.0 functions deploy import-cj-product --use-api
npx --yes supabase@2.117.0 functions deploy quote-cj-shipping --use-api
npx --yes supabase@2.117.0 functions deploy review-product --use-api
npx --yes supabase@2.117.0 functions deploy publish-shopify-draft --use-api
```

Keep JWT verification enabled. The functions check the signed-in user against `private.internal_users` through `is_internal_user()` before reading a candidate or invoking privileged writes. Test by scanning one Discovery card, importing it, and confirming that it leaves Discovery, appears in Imported products, and retains the checked shipping evidence.

On a Discovery or imported card, **Start worldwide shipping scan** checks CJ's published 249-country destination catalog in batches of 8. High-value markets are checked first, then every remaining CJ country code. A rejected destination is left unchecked for a later retry while successful destinations in the same batch are saved. The dashboard separates confirmed, unavailable, and unchecked destinations, shows the confirmed cost range, and lists country-level carrier and delivery estimates. Continue the scan until no destinations remain unchecked.

A pre-import batch uses one inventory call, one variant call, and up to 8 freight calls; at CJ's current point schedule that is up to 100 points. Once imported, the selected variant is already known, so a batch uses up to 90 points. Quotes replace the current normalized value while raw CJ responses remain private history. Recheck before approval because freight prices and routes change.

### Review pricing and approve a product

Open **Product review and pricing** on an imported card. Choose only confirmed European markets, select the variants to sell, enter their EUR prices, and record the current source-cost-to-EUR exchange rate. The variable cost reserve can represent payment fees, VAT, advertising, returns, and other percentage-based costs. Landed cost uses the highest selected-market one-unit quote from the scanned representative variant; materially different variants still need verification before publishing. Gross and contribution estimates use exact fixed-point decimal arithmetic.

**Save review** keeps a draft in `ready_for_review`. **Approve for Shopify draft** requires a current supplier cost for every selected variant, confirmed shipping evidence for every selected market, an exchange rate when currencies differ, and at least one priced variant. **Reject product** requires a note. Every action appends an audit event. Approval does not create or publish a Shopify product.

## 6. Configure Shopify draft creation

Shopify is the selected first channel. Apply `20261001000300_shopify_draft_listings.sql` before deploying the draft function. The migration adds durable listing intent, explicit product/variant mappings, restricted attempt history, and read-only dashboard status.

Create the app in Shopify's Dev Dashboard, choose custom distribution to your store, request only `write_products` for the first product-publishing slice, release the app version, and install it on the store. Keep the Client secret in a server-side secret store. Record the store's permanent `*.myshopify.com` domain; a custom storefront domain can change and is not the Admin API identity.

In **Supabase Dashboard -> Edge Functions -> Secrets**, add:

```text
SHOPIFY_STORE_DOMAIN=store-name.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
```

Do not add a custom storefront domain, URL scheme, path, or trailing slash. These values can remain empty in local `.env` files because the dashboard calls the deployed Edge Function. Deploy it from the linked project:

```sh
npx --yes supabase@2.117.0 functions deploy publish-shopify-draft --use-api
```

Approve a product review, then select **Create Shopify draft** on its imported-product card. The function verifies the signed-in internal user, records the attempt before calling Shopify, exchanges the credentials for a short-lived server token, and sends only the approved title, description, images, selected variants, prices, SKUs, and option data. Shopify receives `DRAFT` status; the function never activates or publishes the product. A successful response persists the Shopify product and every variant ID. Repeating the action updates the same draft and preserves reconciled variant identities.

If Shopify succeeds but Supabase reconciliation fails, retry the same action. The deterministic handle targets the same product. Provider responses and failure detail remain restricted; the browser receives only sanitized status codes.

Shopify markets and shipping zones will next be limited to destinations with current supplier evidence. Market-specific selling prices will use configurable country groups and per-selected-variant shipping quotes rather than the current representative-variant estimate.

## 7. Publish using the existing Pages setting

Keep **Settings → Pages → Deploy from a branch → main → / (root)**. GitHub Pages serves the generated `index.html` and `assets/`; it does not run Node, migrations, or server modules.

For a configured build, add the same `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` as repository **Actions variables**, not privileged secrets. CI uses those values to reproduce the committed bundle. With neither variable configured, CI verifies the setup-pending build.

```sh
npm run pages:build
npm run check
git add .
git commit -m "Update ecommerce foundation"
git push origin main
```

Review the staged diff before committing. Build output must be regenerated when source or public config changes. Never hand-edit `index.html` or `assets/`. Production builds use `.env.production`/`.env.production.local` as well as `.env.local` per Vite conventions; environment-specific files are all ignored. Use the intended project values for each build and match CI variables.

GitHub Pages may take a few minutes to refresh after a push. No server secrets, worker processes, or database migration execution belong in this publication flow.

## References

- [Supabase API key types](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase migrations](https://supabase.com/docs/guides/deployment/database-migrations)
- [Supabase Auth settings](https://supabase.com/docs/guides/auth/general-configuration)
- [Vite public environment handling](https://vite.dev/guide/env-and-mode)
- [GitHub Pages branch publication](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [Shopify Dev Dashboard apps](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard)
- [Shopify client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)
- [CJ freight calculation](https://developers.cjdropshipping.com/en/api/api2/api/logistic.html)
- [CJ country catalog](https://developers.cjdropshipping.com/en/api/api2/standard/ps-country.html)
- [CJ API point schedule](https://developers.cjdropshipping.com/en/api/api2/standard/points.html)

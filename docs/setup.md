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

Leave server-only fields empty when working only on the dashboard. Public configuration is intentionally visible in browser JavaScript. Never put privileged credentials in any `PUBLIC_` variable. The build exposes exactly the two named public variables and rejects privileged key formats in the public key field. `.env.example` must remain names with empty assignments.

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

## 5. Publish using the existing Pages setting

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

# Working in this repository

Read `README.md`, `docs/architecture.md`, and the relevant architecture issues linked there before substantial implementation. Issue #9 supersedes the parent's local database direction; the current project is sales-channel neutral. Keep this a small modular foundation.

- Supabase is the persistent state store. The Mac mini executes trusted work; GitHub Pages serves only the browser build from main/root.
- Domain code must not depend on CJ, Shopify, Supabase, or UI. Provider code and privileged persistence live under `src/server/`.
- Browser code gets only explicitly allowed public config, Supabase Auth, and RLS-protected reads. Never grant browser workflow writes as a shortcut for trusted business services.
- Preserve explicit product/variant external mappings, null unknown values, provenance, and raw history. Do not add automatic live publishing or supplier purchasing.
- Add new migrations for changes to an applied schema. Never commit secret-bearing `.env*` files. `.env.example` contains names with empty values only.
- Validate changes with `npm test` and `npm run typecheck`. If browser source/config changes, run `npm run pages:build` and commit generated root `index.html`/`assets/` together with source. `npm run check` verifies output freshness too.
- Tests use ephemeral PGlite; hosted Supabase/Auth integration requires a configured development project. Do not claim hosted verification based only on these tests.

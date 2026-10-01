# Discovery V2 progress

**Last updated:** 2026-09-30

**Detailed brief:** [Discovery V2 implementation specification](discovery-v2-implementation-spec.md)

**Current behavior:** [Product discovery and search](discovery.md)

This file tracks implementation state so proposed capabilities are not confused with deployed behavior.

## Implemented in the first V2 slice

- Generic discovery profiles with strong defaults and `pets` / `home-products` proof profiles.
- Runtime validation for profile weights, thresholds, expansion limits, strategy uniqueness, and cache TTL.
- Unicode-safe query normalization and original-phrase preservation.
- Controlled deterministic synonym expansion with safe singular/plural concept matching.
- Optional Ollama structured-output expansion behind a provider port, strict validation, and failure fallback.
- CJ-supported original, token, expansion, listing-activity, inventory, trending, and new-product strategies.
- Explicit API, pagination, candidate, enrichment, and page-size budgets.
- Controlled pagination, duplicate-ratio stopping, partial-strategy warnings, and failed-run status.
- Supplier-ID deduplication with complete occurrence provenance.
- Explainable `EXACT` / `STRONG` / `RELATED` / `WEAK` / `IRRELEVANT` relevance.
- Separate `PASS` / `REVIEW` / `FAIL` eligibility with explicit reasons.
- Reusable compliance and operational risk rules with severity.
- Central scoring version with component raw values, normalized values, weights, contributions, sources, timestamps, and explanations.
- Separate overall score, evidence coverage, and confidence.
- Six-hour persisted-run cache with an explicit `--refresh` override.
- Transactional persistence for runs, queries, candidates, occurrences, supplier observations, and private raw pages.
- RLS-protected normalized reads, no browser writes, and restricted append-only persistence boundaries.
- Trusted `cj:discover` CLI application entry point.
- Dashboard V2 shortlist with evidence, unknowns, risks, and safe supplier links.
- Separate Discovery and Imported products dashboard tabs with independent empty states and counts.
- Budgeted shortlist media enrichment that retains CJ's complete normalized image set.
- Automatic image carousels with previous/next controls and reduced-motion support.
- Hover/focus-only carousel overlays so product imagery stays unobstructed while scanning.
- Supplier cost, stock, listing activity, delivery, variant-enrichment, and shipping-status overview fields.
- Authenticated one-click CJ import through an internal-membership-gated Supabase Edge Function.
- Tests covering profiles, deterministic and optional model expansion, malformed/unavailable model output, relevance, exclusions, strategies, pagination, budgets, duplicates, partial failures, second-niche reuse, atomic persistence, privacy, and migration compatibility.

## Deployment step still required

Apply `supabase/migrations/20260930000300_product_image_galleries.sql` to hosted Supabase. Then collect gallery data with a fresh run:

```sh
npm run cj:discover -- "cat toy" --profile=pets --refresh
```

The configuration version is now `discovery-v2.1`, so the first command after deployment also bypasses older cached run keys without `--refresh`. Reimport an existing product to refresh its imported-product gallery if its historical raw snapshot did not contain `productImageSet`.

Set the Edge Function secret `CJ_API_KEY` and deploy both `import-cj-product` and `quote-cj-shipping`. Europe is the initial shipping market. Imported products can record current CJ estimates for NL, BE, DE, FR, ES, and IT; discovery results remain `Not checked` until variants are imported.

## Next discovery work

1. Run several real queries and inspect false positives, false negatives, provider result overlap, data coverage, and CJ field reliability.
2. Calibrate profile synonyms, exclusions, thresholds, weights, and risk severities from those results.
3. Add bounded variant-quality enrichment for the strongest shortlist, including actual variant count, stocked-variant coverage, variant price spread, and inventory concentration.
4. Add run-level dashboard filters and a run detail view before adding workflow writes.
5. Add explicit operator decisions and feedback history in a later review slice, then backtest score versions against those outcomes.

## Deliberately deferred

- scheduled or nightly runs;
- external market-demand, advertising, competitor, or review integrations;
- broader Europe shipping coverage and landed-cost economics;
- Shopify, bol.com, Etsy, or other publishing;
- product maintenance and replacement workflows;
- supplier purchasing, fulfillment, orders, or tracking;
- external orchestrator integration;
- sophisticated cross-supplier product matching.

The next implementation should continue through the application ports and provider adapters already introduced. It should not bypass the transactional repository, write from the browser, or turn supplier activity into a sales claim.

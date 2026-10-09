# Discovery V2 progress

**Last updated:** 2026-10-09

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
- Trusted `cj:discover` CLI and versioned `discovery:run --json` one-shot worker entry points.
- Reusable `executeDiscoveryRun(...)` application boundary for cache lookup, bounded supplier acquisition, and atomic persistence.
- Dashboard V2 shortlist with evidence, unknowns, risks, and safe supplier links.
- Separate Discovery and Imported products dashboard tabs with independent empty states and counts.
- Budgeted shortlist media enrichment that retains CJ's complete normalized image set.
- Automatic image carousels with previous/next controls and reduced-motion support.
- Hover/focus-only carousel overlays so product imagery stays unobstructed while scanning.
- Supplier cost, stock, listing activity, delivery, variant-enrichment, and shipping-status overview fields.
- Authenticated one-click CJ import through an internal-membership-gated Supabase Edge Function.
- Tests covering profiles, deterministic and optional model expansion, malformed/unavailable model output, relevance, exclusions, strategies, pagination, budgets, duplicates, partial failures, second-niche reuse, atomic persistence, privacy, and migration compatibility.

## Operational entry point

The product image, discovery, import, shipping, review, OAuth, and Shopify draft migrations and functions have been applied to the current ecommerce Supabase project. A trusted machine with `CJ_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` can run:

```sh
npm run --silent discovery:run -- "cat toy" --profile=pets --json
```

The command performs one bounded run, persists it, emits the `product-discovery-job.v1` JSON result, and exits. `--refresh` bypasses the six-hour cache. ORION scheduling, process timeouts, and retries remain outside this repository. Ollama remains disabled when its two optional environment variables are absent.

## Proposed operating cadence

Use a controlled pilot before making discovery a nightly high-volume job:

1. For the first four weeks, run discovery on Monday, Wednesday, and Friday at 02:00 Europe/Amsterdam.
2. Rotate two seed queries per run instead of repeating one category. Keep the default budgets and leave `--refresh` off unless a deliberately new observation is required.
3. Review `PASS`, `REVIEW`, false-positive, and missed-product outcomes the following morning and record changes needed in the profile rather than changing several weights at once.
4. After the rules are stable, reduce broad discovery to Tuesday and Saturday nights. Product maintenance will eventually run in smaller nightly batches and should take scheduling priority because live and approved products need fresher evidence than new-candidate searches.

ORION should own the clock, timeout, process supervision, and notification policy. This repository should continue to expose bounded one-shot commands that exit with a machine-readable result.

## Next discovery work

1. Run several real queries and inspect false positives, false negatives, provider result overlap, data coverage, and CJ field reliability.
2. Calibrate profile synonyms, exclusions, thresholds, weights, and risk severities from those results.
3. Add bounded variant-quality enrichment for the strongest shortlist, including actual variant count, stocked-variant coverage, variant price spread, and inventory concentration.
4. Add run-level dashboard filters and a run detail view before adding workflow writes.
5. Add explicit operator decisions and feedback history in a later review slice, then backtest score versions against those outcomes.

## Deliberately deferred

- scheduled or nightly runs;
- external market-demand, advertising, competitor, or review integrations;
- automated quote refresh and external market validation beyond the imported-product review estimate;
- live Shopify publication, Shopify market pricing, bol.com, Etsy, or other channel publishing;
- product maintenance and replacement workflows;
- supplier purchasing, fulfillment, orders, or tracking;
- external orchestrator integration;
- sophisticated cross-supplier product matching.

The next implementation should continue through the application ports and provider adapters already introduced. It should not bypass the transactional repository, write from the browser, or turn supplier activity into a sales claim.

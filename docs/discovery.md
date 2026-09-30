# Product discovery and search

Discovery is a staged evidence pipeline. A supplier listing count or a high internal score is not proof that a product will sell. The detailed direction and full definition of done remain in the [Product discovery V2 implementation specification](discovery-v2-implementation-spec.md).

## Commands

The legacy preview remains available during rollout:

```sh
npm run cj:search -- "cat toy"
```

It searches individual terms, ranks the in-memory results with the original V1 formula, prints ten rows, and writes nothing.

The durable V2 entry point is:

```sh
npm run cj:discover -- "cat toy" --profile=pets
```

It requires the Discovery V2 migration and trusted `CJ_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` values. The `--profile` option accepts `generic`, `pets`, or `home-products`. Profiles configure synonyms, exclusions, category hints, thresholds, enabled reusable risk rules, and scoring weights; the pipeline contains no pet-specific branches.

`OLLAMA_BASE_URL` and `OLLAMA_MODEL` optionally enable local-model query expansion. Both are server-only settings. Deterministic expansion always runs, model output is schema-validated and bounded, and an unavailable or malformed model produces a warning without stopping supplier discovery.

## Query planning and acquisition

V2 preserves the normalized original phrase as the first and strongest search. Unicode accents, case, punctuation, whitespace, stop words, and duplicate terms are normalized deterministically. Safe singular handling replaces the old generated plural forms.

The configured profile can produce a bounded set of synonym expansions. Search plans can then use these CJ-supported strategies:

- original phrase by relevance;
- original phrase by listing activity;
- original phrase by inventory;
- controlled expanded queries;
- original query tokens for recall;
- CJ's trending product flag;
- CJ's new-product flag.

CJ Product List V2 remains behind the supplier adapter. It supports cursor pages, page sizes up to 100, category/country/price/inventory filters, listing/price/creation/inventory sorting, and documented product flags. The normalized domain also records sale visibility, unverified inventory, certification, personalization, and product type when CJ supplies them.

The default run budget is:

| Budget | Default |
| --- | ---: |
| API requests | 12 |
| Pages per strategy | 2 |
| Raw product rows | 300 |
| Page size | 50 |
| Detail enrichments | 0 |

Completed runs are cached for six hours by default using supplier, normalized query, profile, configuration version, and scoring version. Repeating the same command reuses the fresh run without spending CJ requests. Pass `--refresh` to deliberately collect a new observation:

```sh
npm run cj:discover -- "cat toy" --profile=pets --refresh
```

The application stops when a budget is reached, a source is exhausted, or a later page contains at least 90% duplicates. A failed strategy becomes a sanitized run warning; successful strategies are retained. If no page succeeds, the run is marked failed.

Products are deduplicated by supplier product ID. Every occurrence retains strategy, query, query source, page, rank, sort, filters, source, and retrieval time. Repeated discovery is provenance, not independent consumer-demand evidence.

## Relevance and eligibility

Relevance compares original query concepts with normalized supplier title, category, and SKU facts plus controlled profile synonyms. It returns one of:

```text
EXACT → STRONG → RELATED → WEAK → IRRELEVANT
```

It also records matched concepts, missing concepts, synonym matches, profile exclusions, and human-readable reasons.

Eligibility is independent from scoring:

- `PASS` meets the current supplier-side gates;
- `REVIEW` has related relevance, missing core evidence, weak supplier activity, or a reviewable risk;
- `FAIL` has weak relevance, a profile exclusion, a blocking risk, a non-sellable/non-visible state, excessive known cost, or inadequate known inventory.

Failed candidates remain persisted for observability instead of disappearing silently.

## Versioned opportunity assessment

The current scoring version is `supplier-opportunity-v2.0`. Every component records its raw value, normalized value, weight, contribution, source, retrieval time, and explanation.

| Dimension | Weight | Meaning |
| --- | ---: | --- |
| Relevance | 25 | Original intent, direct concepts, controlled synonyms, and category consistency |
| Supplier activity | 15 | Log-scaled CJ listing activity; never labelled as sales |
| Inventory health | 15 | Verified inventory depth and verified share |
| Cost fit | 15 | Supplier cost midpoint against the configured research range |
| Freshness | 10 | Supplier listing age over a three-year scoring window |
| Fulfillment readiness | 10 | Supplier-reported delivery cycle |
| Creative asset readiness | 5 | Supplier image and video availability |
| Operational simplicity | 5 | Current customization complexity signal |

Missing evidence contributes no points. `coverage` is the percentage of configured weight with evidence. `confidence` further discounts coverage when inventory is mostly unverified. `score`, `confidence`, and `coverage` remain separate dashboard fields. Rule-based risks apply transparent penalties and explicit `INFO`, `REVIEW`, `HIGH_RISK`, or `BLOCK` severity.

Every assessment explicitly says that external consumer demand, destination shipping, retail pricing, advertising cost, and profitability remain unknown.

## Persistence and dashboard

One service-role-only PostgreSQL RPC atomically persists:

- `discovery_runs` with profile, versions, status, budgets, metrics, and warnings;
- `discovery_queries` with expansion source, confidence, and reason;
- `discovery_candidates` with eligibility, relevance, score, confidence, coverage, and the versioned assessment;
- `discovery_occurrences` with complete acquisition provenance;
- `supplier_product_observations` with timestamped supplier cost, activity, inventory, delivery, and visibility facts;
- `private.discovery_snapshots` with raw source pages.

Internal browser users can read normalized public records through RLS and cannot write them. Raw pages remain inaccessible to browser roles and append-only for the service role. Invalid persistence batches roll back completely.

The dashboard shows the most recent V2 shortlist with supplier image, original query, profile, eligibility, score, confidence, coverage, relevance, strategy count, structured positive evidence, review reasons, risks, unknowns, and the safe supplier link. The dashboard remains compatible while the additive migration is pending.

## Current limits and next work

CJ listing activity is not verified sales. CJ Trending is not proof of market demand. CJ inventory is not consumer popularity. External demand is not measured, and profitability is not proven.

This slice does not schedule recurring runs, request destination shipping quotes, calculate landed cost, scrape market sources, publish products, maintain listings, purchase inventory, fulfill orders, or integrate with the external orchestrator.

The next discovery work should use real persisted runs to calibrate thresholds and scoring, add bounded full-product enrichment for shortlisted candidates, and improve the dashboard's run-level filtering. Market validation and Netherlands shipping/economics remain later workflows with their own evidence sources.

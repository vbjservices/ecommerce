# Product discovery and search

Discovery is a staged evidence pipeline. A supplier listing count or a high internal score is not proof that a product will sell.

The detailed, approved direction for the next discovery iteration is preserved in the [Product discovery V2 implementation specification](discovery-v2-implementation-spec.md). This document describes current behavior and near-term sequencing; the V2 specification describes proposed behavior and its full definition of done.

## Current slice

The CJ adapter uses the official API V2 `product/listV2` endpoint for catalog search. It normalizes product ID, title, supplier SKU, category, USD cost range, listing count, warehouse inventory, verified inventory, creation time, delivery cycle, and basic media/fulfillment flags.

Run a trusted, read-only search with:

```sh
npm run cj:search -- "cat toy"
```

The command:

1. Searches each meaningful term separately to improve recall.
2. Merges results by CJ product ID.
3. Requires the original meaningful terms to match normalized title/category data.
4. Requires known listing count, cost, and total inventory before a result is eligible.
5. Produces an explainable score, evidence coverage, and risk reasons.
6. Does not import, approve, publish, or purchase anything.

CJ calls are centrally paced for entry-level account limits. Repeated scheduled searches should later be cached as durable discovery runs so the worker does not spend API points retrieving unchanged pages.

## Ranking model

The first-pass score uses only observable supplier facts:

| Component | Weight | Meaning |
| --- | ---: | --- |
| Query relevance | 25 | Meaningful search terms match title/category/SKU facts |
| Listing activity | 20 | Log-scaled CJ listing count; a demand proxy, not sales |
| Verified inventory | 15 | Log-scaled stock CJ marks as verified; unverified factory stock carries a visible risk |
| Cost fit | 15 | Supplier cost fits the configured research band |
| Freshness | 10 | More recently created supplier listings score higher |
| Fulfillment | 10 | Shorter reported supplier delivery cycles score higher |
| Media readiness | 5 | Image and video availability |

Missing facts reduce evidence coverage. Core missing facts block eligibility rather than silently becoming zero. Risk terms and operational complexity apply visible penalties and review labels. Weights and thresholds remain configuration, not hidden AI judgment.

## Recommended worker pipeline

1. **Acquire:** query configured terms, CJ categories, trending products, new products, and inventory-sorted pages on a schedule.
2. **Deduplicate:** use supplier product IDs first. Later add cross-supplier similarity without merging identities automatically.
3. **Gate:** require on-sale visibility, known cost, verified inventory, acceptable risk category, and minimum evidence coverage.
4. **Enrich the shortlist:** fetch full variants and stock, then obtain destination-specific shipping quotes for the Netherlands.
5. **Research externally:** collect trend history, ad activity, review quality, competitor prices, and saturation through separate source adapters.
6. **Score transparently:** store every component, source, retrieval time, coverage, and exclusion reason.
7. **Create candidates:** ingest only the strongest bounded shortlist for human review.

Supplier listing count must be labelled as listing activity. It is not order volume or revenue. Shipping and margin should remain unknown until the relevant quote and target selling price are available.

## Scraping policy and structure

CJ product facts should come from its API. HTML scraping is reserved for useful sources without a suitable API, subject to their access rules.

Each scraper belongs behind its own adapter and must:

- identify its source and collection time;
- rate-limit and cache requests;
- preserve restricted raw snapshots;
- detect layout/schema changes and fail visibly;
- distinguish missing facts from zero;
- avoid bypassing authentication, access controls, or anti-bot protections;
- never write directly to candidate scores or product tables.

The next persistence slice should add discovery runs and observations before scheduled scraping begins. That gives us cache keys, history, retry state, source health, and enough data to measure velocity instead of repeatedly collecting one current number.

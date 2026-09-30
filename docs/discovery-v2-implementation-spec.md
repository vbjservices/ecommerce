# Product discovery V2 implementation specification

**Status:** Proposed implementation brief  
**Scope:** Product discovery only  
**Source:** User-approved planning prompt preserved on 2026-09-30

This is the durable brief for the next substantial discovery iteration. It records desired behavior, architectural boundaries, staged implementation guidance, testing requirements, and the definition of done. It is not a claim that every capability below is already implemented. For current behavior, read [Product discovery and search](discovery.md). Before implementation, validate CJ-specific assumptions against the current official API and document any discrepancy.

---

Act as a senior TypeScript engineer, ecommerce product-discovery architect, search/ranking engineer, and software-platform architect working directly inside this repository.

Before making changes, inspect the repository carefully.

Understand:

- the current CJdropshipping integration
- supplier abstractions
- product discovery flow
- ranking/scoring logic
- Supabase/PostgreSQL usage
- dashboard/read models
- tests
- configuration
- documentation
- current architectural conventions

Do not replace working architecture unnecessarily.

Refactor or extend the existing implementation where appropriate.

# Project boundary

This repository is the standalone `ecommerce` repository.

It is NOT the main automation/orchestrator repository.

There is a separate orchestrator system elsewhere which currently coordinates other automation tasks such as:

- lead generation
- social-media/video generation
- video replenishment
- other automated workflows

Do NOT couple this ecommerce repository directly to that orchestrator.

Do NOT import code from that repository.

Do NOT assume both repositories will eventually be merged.

For now, ecommerce must remain an independent application/service with its own:

- domain logic
- persistence
- supplier integrations
- product discovery logic
- configuration
- tests
- execution entry points

The ecommerce system may later be invoked by an external orchestrator.

Therefore design clean external boundaries, but do not implement the orchestration integration now.

Future architecture may look conceptually like:

External Orchestrator
↓
Ecommerce public interface
↓
Ecommerce application
↓
Discovery engine
↓
Supplier adapters

The orchestrator should eventually be able to use ecommerce as a tool/service rather than needing to understand its internal implementation.

---

# Scope of this task

THIS TASK IS ONLY ABOUT PRODUCT DISCOVERY.

We are currently improving the system responsible for:

- searching for products
- collecting CJ product candidates
- evaluating candidate quality
- ranking promising candidates
- persisting discovery results
- displaying products for human review

Do NOT implement:

- product maintenance
- nightly ecommerce jobs
- automated recurring scans
- monitoring already-published products
- replacing declining products
- Shopify publishing
- bol.com publishing
- Etsy publishing
- order fulfillment
- automatic supplier purchasing
- store performance monitoring
- stock-maintenance automation
- external orchestrator integration
- product replacement workflows

Those will be separate future tasks.

---

# Long-term platform direction

This repository should eventually support a broader ecommerce automation platform.

Conceptually:

Supplier integrations
↓
Product discovery
↓
Market validation
↓
Human approval
↓
Sales-channel publishing
↓
Product maintenance
↓
Order fulfillment

However, do not implement those future layers prematurely.

Build the discovery foundation cleanly now.

---

# Current supplier

CJdropshipping is currently the first supplier.

CJ-specific behavior must remain behind supplier/provider adapters.

The discovery engine itself should operate on normalized internal product types.

Future suppliers should be able to plug into the same system without rewriting discovery.

Prefer:

CJ API
↓
CJ Adapter
↓
Normalized Supplier Product
↓
Generic Discovery Engine

Avoid leaking raw CJ response objects throughout the application.

---

# Sales-channel independence

Shopify will eventually be one publishing destination.

Other channels may later include:

- bol.com
- Etsy
- other ecommerce marketplaces

Do NOT model discovery around Shopify.

Discovery should not contain Shopify-specific concepts.

Publishing integrations belong to a separate future layer.

---

# Niche independence

Our current commercial use case is pet products.

However, the discovery engine must NOT become a pet-specific product-search system.

Pets are only the first niche.

Future niches may include:

- home
- kitchen
- beauty
- fitness
- hobbies
- outdoors
- accessories
- other ecommerce categories

Adding another niche should NOT require:

- duplicating the discovery pipeline
- copying supplier logic
- copying ranking code
- creating another search application
- duplicating scoring algorithms
- creating large `if niche === ...` blocks throughout the codebase

The architecture should be:

Generic Discovery Engine
+
Discovery Profile / Configuration
+
Composable Rules
+
Supplier Adapters

---

# Niche profiles

Introduce or improve a configuration concept such as:

```ts
DiscoveryProfile
```

or another name consistent with the repository.

A discovery profile may contain niche-specific configuration such as:

- category hints
- synonyms
- search vocabulary
- negative terms
- preferred characteristics
- compliance concerns
- enabled rules
- scoring overrides
- eligibility overrides

Conceptual example:

```ts
interface DiscoveryProfile {
  id: string;
  name: string;

  search?: {
    categoryHints?: string[];
    synonyms?: Record<string, string[]>;
    negativeTerms?: string[];
  };

  eligibility?: Partial<EligibilityConfig>;

  scoring?: Partial<DiscoveryScoreConfig>;

  riskRuleIds?: string[];
}
```

Do not blindly use this exact interface if a better domain model fits the existing architecture.

The important principle is configuration-driven behavior.

---

# Sensible defaults

Most niches should reuse the same behavior.

Create strong defaults such as:

```ts
DEFAULT_DISCOVERY_CONFIG
```

A niche profile should only override behavior that genuinely differs.

Avoid copying complete configuration objects for every niche.

---

# Composable business rules

Eligibility, risk, and scoring logic should be reusable.

Prefer abstractions such as:

```ts
RiskRule
EligibilityRule
ScoreComponent
DiscoveryStrategy
```

where appropriate.

For example, rules such as:

- branded-product risk
- battery risk
- low-stock risk
- extreme variant count
- customization complexity

may be shared across many niches.

Avoid duplicating implementations inside each profile.

---

# Avoid giant niche switches

Avoid architecture such as:

```ts
if (niche === "pets") {
  ...
}

if (niche === "beauty") {
  ...
}

if (niche === "home") {
  ...
}
```

throughout application logic.

Prefer composition/registration.

Do not over-engineer this into a massive plugin framework.

The goal is simple extensibility.

---

# Current discovery behavior

The existing implementation is approximately a first-pass CJ catalog ranker.

It currently does things such as:

- tokenize a search query
- remove a small set of stop words
- search CJ by terms
- retrieve a limited result set
- merge products by CJ product ID
- require query-term matching
- perform basic plural handling
- evaluate listing count
- evaluate inventory
- evaluate supplier price
- score freshness
- score fulfillment
- score media
- apply risks
- rank results

This is a useful foundation.

However, it currently answers something closer to:

> Which CJ listings match this phrase and pass basic supplier checks?

We want:

> Which CJ products are the most promising candidates for human review?

Do NOT interpret CJ platform signals as proof of consumer demand.

---

# Main discovery pipeline

The target architecture should conceptually resemble:

Search Request
↓
Discovery Profile Resolution
↓
Query Understanding
↓
Query Expansion
↓
Discovery Strategy Orchestrator
↓
Candidate Merger
↓
Relevance Assessment
↓
Cheap Eligibility Gates
↓
Supplier Enrichment
↓
Opportunity Assessment
↓
Confidence Assessment
↓
Ranking
↓
Persistence
↓
Dashboard Read Model

Adapt this to the existing codebase rather than forcing unnecessary abstractions.

---

# 1. Inspect actual CJ capabilities

Before implementation, inspect how the current CJ adapter works.

Verify against the current CJ API implementation which fields, filters, and sorting mechanisms are actually available.

Investigate supported capabilities such as:

- keyword search
- category filtering
- pagination
- price filtering
- listing count
- inventory
- verified inventory
- warehouse information
- creation time
- sorting
- trending flag
- new-product flag
- slow-moving flag
- video
- certifications
- customization indicators
- product type
- other relevant metadata

Do not invent fields.

If something useful is unavailable, document the limitation.

---

# 2. Multi-strategy candidate generation

Do not rely on one search method.

Introduce the concept of discovery strategies.

Potential strategies may include:

```text
ORIGINAL_QUERY
TOKEN_QUERY
EXPANDED_QUERY
CJ_TRENDING
CJ_NEW
CJ_LISTING_ACTIVITY
CJ_INVENTORY
CJ_VIDEO
```

Only implement strategies genuinely supported by CJ.

A strategy generates candidate products.

It does NOT prove that a product is good.

---

# 3. Preserve original query intent

If the user enters:

```text
cat toy
```

search the original phrase first.

Do not immediately destroy the user's intent by splitting everything into individual words.

The original phrase should carry the strongest relevance weight.

---

# 4. Better query normalization

Replace simplistic token processing with a reusable query-processing layer.

Support where appropriate:

- lowercase normalization
- Unicode normalization
- phrase preservation
- safe singular/plural normalization
- configurable stop words
- duplicate removal
- simple spelling normalization
- negative terms
- category hints

Avoid invalid naive plural generation.

Keep this logic deterministic and testable.

---

# 5. Controlled query expansion

Support controlled related searches.

Example:

Original:

```text
cat toy
```

Possible related queries:

```text
interactive cat toy
kitten toy
cat enrichment toy
automatic cat toy
cat puzzle toy
```

Do not generate unlimited queries.

Each expansion should retain metadata.

Conceptually:

```ts
interface QueryExpansion {
  query: string;
  source:
    | "ORIGINAL"
    | "RULE_BASED"
    | "SYNONYM"
    | "CATEGORY"
    | "LOCAL_MODEL";

  confidence?: number;
  reason?: string;
}
```

---

# 6. Optional local Ollama support

The wider infrastructure includes a Mac mini which already hosts an approximately 5B local Ollama model.

However, Ollama belongs to external/shared infrastructure.

This ecommerce repository must not assume it always exists.

Design an optional abstraction such as:

```ts
interface QueryExpansionProvider {
  expand(
    input: QueryExpansionInput
  ): Promise<QueryExpansion[]>;
}
```

Potential implementations:

```text
DeterministicQueryExpansionProvider
OllamaQueryExpansionProvider
```

The deterministic provider must always function.

The Ollama provider should be optional and configurable.

Do not start or manage Ollama from this repository.

Do not couple ecommerce to the Mac mini orchestrator.

Communicate with an Ollama-compatible endpoint only through a clean infrastructure adapter if configured.

---

# 7. Ollama failure must not break discovery

If local AI is:

- offline
- busy
- slow
- unavailable
- returns invalid JSON
- gives irrelevant expansions

the product search must still work.

Use:

```text
deterministic behavior
+
optional AI enrichment
```

not:

```text
AI dependency
```

---

# 8. Validate AI output

Do not trust local-model output directly.

Validate:

- schema
- query length
- maximum number of expansions
- duplicate expansions
- prohibited values
- relevance to original query
- category consistency

Reject unusable AI output.

Ollama must never directly execute supplier API calls.

---

# 9. Improved relevance

Replace strict literal-all-term matching with a better explainable relevance system.

Suggested levels:

```text
EXACT
STRONG
RELATED
WEAK
IRRELEVANT
```

Potential signals:

- exact phrase
- title token coverage
- normalized terms
- synonyms
- category match
- description match if available
- negative terms
- supplier-category consistency
- optional local-model classification

Example:

Search:

```text
cat toy
```

Relevant:

```text
Interactive Cat Ball
Automatic Kitten Teaser
Cat Enrichment Puzzle
Laser Toy for Cats
```

Irrelevant:

```text
Cat Print Hoodie
Cat Coffee Mug
Dog Chew Toy
```

Return structured reasons.

---

# 10. Optional semantic classification

The local Ollama model may optionally help with ambiguous cases.

Example:

Query:

```text
cat toy
```

Supplier title:

```text
Automatic Rechargeable Rolling Interactive Ball
```

Category:

```text
Pet Supplies > Cat Products
```

The local model may classify it as a strong match.

However, deterministic relevance remains part of the final result.

Do not make semantic relevance an unexplained model-only score.

---

# 11. Controlled pagination

The current first-page-only approach should be improved.

Support configurable pagination.

Do NOT blindly exhaust the entire CJ catalog.

Possible stop conditions:

- max pages
- max API requests
- max candidates
- repeated pages produce mostly duplicates
- relevance becomes too weak
- strategy-specific budget exhausted

Record:

```text
pagesFetched
productsFetched
uniqueProductsFound
duplicatesFound
apiRequestsUsed
stoppingReason
```

---

# 12. API-budget awareness

CJ API usage must be controlled.

Introduce a run budget concept.

Example:

```ts
interface DiscoveryBudget {
  maxApiRequests: number;
  maxSearchPages: number;
  maxRawCandidates: number;
  maxEnrichments: number;
}
```

Prefer:

broad inexpensive discovery
↓
deduplication
↓
relevance filtering
↓
deeper enrichment

Avoid:

many expansions
×
many pages
×
detail requests for every product

---

# 13. Candidate provenance

A product may be found through multiple strategies.

Example:

Product X:

- original query
- expanded query
- CJ Trending
- listing-count sort

The product itself should be deduplicated.

Its occurrences should be preserved.

Conceptual model:

```ts
interface DiscoveryCandidate {
  supplierProductId: string;
  occurrences: DiscoveryOccurrence[];
}
```

and:

```ts
interface DiscoveryOccurrence {
  strategy: string;
  query?: string;
  page?: number;
  rank?: number;
  sort?: string;
  filters?: Record<string, unknown>;
  retrievedAt: Date;
}
```

Do not count four occurrences as four independent pieces of consumer-demand evidence.

---

# 14. Eligibility separate from scoring

Candidate generation should be broad.

Eligibility should then classify products.

Use states such as:

```text
PASS
REVIEW
FAIL
```

Potential checks:

- adequate relevance
- valid supplier price
- valid product
- reasonable inventory
- product is sellable
- compliance status
- absolute price ceiling

Keep gate reasons explicit.

Do not silently remove failed candidates from debugging/observability.

---

# 15. Inventory quality

Where CJ data supports it, distinguish:

- total inventory
- verified inventory
- warehouse inventory
- variant inventory
- stocked variants

Create an assessment such as:

```text
HEALTHY
LOW
CONCENTRATED
UNVERIFIED
UNKNOWN
```

Do not assume a large aggregate number automatically means healthy stock.

---

# 16. Variant quality

Evaluate operational complexity where possible.

Potential signals:

- variant count
- stocked variants
- supplier-price spread
- extreme outlier variants
- customization
- overly complex variant structures

Do not automatically reject products with many variants.

Expose complexity.

---

# 17. Supplier activity is not demand

Use CJ signals accurately.

Potential supplier-platform signals:

- listing count
- CJ Trending
- creation date
- discovery position
- repeated discovery across strategies

These indicate activity inside the supplier ecosystem.

They do NOT equal consumer sales.

Do not call this:

```text
salesScore
```

Prefer:

```text
supplierActivityScore
```

Explicitly document:

```text
CJ listing count != verified sales
CJ Trending != proven consumer demand
CJ inventory != consumer popularity
```

---

# 18. Freshness

Evaluate product age/freshness where reliable.

Do not assume newest is automatically best.

Use configurable scoring logic rather than scattered hard-coded dates.

---

# 19. Creative readiness

CJ can provide some observable creative proxies.

Potential signals:

- images
- video
- usable media assets

Use naming such as:

```text
creativeAssetReadiness
```

Do not claim media availability proves advertising success.

Future ad/social analysis is outside this task.

---

# 20. Compliance and risk rules

Improve risk handling into configurable reusable rules.

Potential categories:

```text
BATTERY
ELECTRICAL
MEDICAL
SUPPLEMENT
COSMETIC
FOOD
BABY
PESTICIDE
BRANDED
LICENSED
CUSTOMIZED
UNKNOWN_MATERIAL
OTHER
```

Potential severities:

```text
INFO
REVIEW
HIGH_RISK
BLOCK
```

Rules should be reusable across niches.

Profiles may enable or configure rules without duplicating their implementation.

---

# 21. Separate score dimensions

Avoid one opaque "winning product score."

Create explicit dimensions.

Conceptually:

```ts
interface ProductOpportunityAssessment {
  relevance: AssessmentDimension;
  supplierActivity: AssessmentDimension;
  freshness: AssessmentDimension;
  inventoryHealth: AssessmentDimension;
  costFit: AssessmentDimension;
  fulfillmentReadiness: AssessmentDimension;
  creativeAssetReadiness: AssessmentDimension;
  operationalComplexity: AssessmentDimension;
  complianceRisk: AssessmentDimension;

  evidenceConfidence: number;
  overallScore: number;
}
```

Use the repository's existing style where possible.

---

# 22. Cost assessment

For this task, only calculate what supplier data actually supports.

Potential values:

```text
supplierPriceMin
supplierPriceMax
supplierPriceMidpoint
variantPriceSpread
weight
```

Do NOT fabricate:

- retail price
- ad spend
- profit
- return costs
- VAT assumptions
- shipping costs
- break-even CPA

Those belong to a later economics/validation phase.

---

# 23. Worldwide selling

The long-term ecommerce system may serve multiple markets.

Do NOT interpret generic supplier availability as worldwide shipping.

Do not perform expensive destination shipping validation during broad discovery unless an existing reliable capability already exists.

Keep supplier logistics metadata if useful.

Destination-specific validation belongs to a later workflow.

---

# 24. Confidence must be separate from score

A product with:

```text
score = 85
confidence = 40%
```

should not be treated the same as:

```text
score = 85
confidence = 95%
```

Confidence should consider factors such as:

- missing supplier data
- unverified inventory
- incomplete enrichment
- data freshness
- contradictory supplier metadata

Expose separately:

```text
score
confidence
coverage
```

Do not normalize missing evidence in a way that makes poorly observed candidates artificially strong.

---

# 25. Centralized and versioned scoring

Do not scatter weights and thresholds throughout the repository.

Create centralized configuration.

Example:

```text
DISCOVERY_SCORING_VERSION = "cj-discovery-v2"
```

Each score component should expose:

```text
name
rawValue
normalizedValue
weight
contribution
source
retrievedAt
explanation
```

---

# 26. Persist discovery runs

Discovery should not remain ephemeral.

Persist useful information in Supabase/PostgreSQL.

Inspect existing structures before adding new tables.

Potential concepts:

```text
discovery_runs
discovery_queries
discovery_occurrences
supplier_products
supplier_product_observations
product_assessments
assessment_components
risk_flags
```

Do not duplicate equivalent existing structures.

A run should contain useful metadata such as:

```text
id
profileId
originalQuery
startedAt
completedAt
status
expandedQueries
strategies
configurationVersion
scoringVersion
apiRequestsUsed
rawCandidateCount
uniqueCandidateCount
eligibleCandidateCount
errors
```

---

# 27. Timestamp supplier observations now

When supplier data is collected during discovery, persist timestamped observations.

For example:

```text
supplierProductId
observedAt
price
inventory
verifiedInventory
listingCount
deliveryCycle
saleStatus
```

Do this so future systems can use historical data.

However:

DO NOT implement maintenance now.

DO NOT implement trend monitoring now.

DO NOT calculate stock-growth trends now unless historical data already legitimately exists.

DO NOT implement product-replacement rules.

DO NOT create nightly ecommerce jobs.

We are only preserving data.

---

# 28. The ecommerce repo must expose clean entry points

Because an external orchestrator may eventually invoke this application, avoid architecture that requires reaching into internal modules.

Define clear application-level entry points.

Examples may include:

```ts
runProductDiscovery(...)
getDiscoveryRun(...)
listDiscoveryCandidates(...)
```

or equivalent use cases matching the current architecture.

Current interfaces may be:

- CLI
- server endpoint
- application service

Do not build a remote orchestration API merely because one may be useful later.

But keep internal boundaries clean so such an adapter can be added without rewriting discovery.

---

# 29. Do not couple to the external orchestrator

Do not add:

- orchestrator-specific environment variables
- direct imports from another repository
- shared file paths
- Mac-mini-specific filesystem assumptions
- video-pipeline dependencies
- lead-generation dependencies
- orchestrator database tables
- 01:30 scheduling
- cron integration with the orchestrator

The ecommerce repository should remain independently runnable and testable.

---

# 30. Future orchestration compatibility

Although direct integration is out of scope, ensure future integration could conceptually look like:

```text
Orchestrator
    ↓
invoke discovery
    ↓
Ecommerce application runs job
    ↓
persist result
    ↓
Orchestrator checks result/status
```

or:

```text
Orchestrator
    ↓
queue command
    ↓
Ecommerce worker
```

or:

```text
Orchestrator
    ↓
HTTP/internal API
    ↓
Ecommerce service
```

Do not choose or implement one now unless the existing repository already provides a natural mechanism.

The important principle is that the ecommerce domain remains autonomous.

---

# 31. Dashboard explanations

Each candidate should expose explainable evidence.

Example:

```text
WHY THIS PRODUCT?

Positive:
+ Strong relevance to "cat toy"
+ Also discovered via "interactive cat toy"
+ CJ Trending signal present
+ High verified inventory
+ Supplier price inside preferred range
+ Video available

Unknown:
? External consumer demand not measured
? Actual destination shipping not validated
? Profitability not calculated

Risk:
! Battery-powered product requires review
```

Generate these primarily from structured deterministic evidence.

Ollama may optionally turn structured reasons into natural language.

It must never invent reasons.

---

# 32. Dashboard read model

Prepare a generic discovery read model.

Potential fields:

```text
image
title
supplier
supplier cost
overall score
confidence
relevance
supplier activity
inventory health
freshness
creative readiness
risk
discovery sources
last checked
```

Expandable details may show:

- score components
- evidence
- unknown/missing evidence
- risks
- discovery occurrences
- supplier information

The read model must not contain pet-specific fields.

---

# 33. Caching

Use caching where it provides clear benefit.

Potential candidates:

- recent product detail
- recent inventory result
- query expansions
- repeated identical searches

Configure TTLs.

Avoid indefinite stale data.

---

# 34. Failure handling

Discovery should handle partial failures.

Examples:

- CJ timeout
- authentication problems
- rate limiting
- malformed supplier response
- missing price
- missing inventory
- failed product detail
- failed expansion provider
- Ollama unavailable
- one discovery strategy failing

Use run states such as:

```text
COMPLETED
COMPLETED_WITH_WARNINGS
FAILED
```

Optional components should not unnecessarily fail the whole run.

---

# 35. Supplier identity and deduplication

Currently CJ is the active supplier.

Deduplicate by supplier identity appropriately.

Preserve multiple discovery occurrences.

Do NOT yet build sophisticated cross-supplier duplicate matching.

However, avoid designing IDs in a way that assumes every product globally belongs to CJ.

Prefer something like:

```text
supplierId
supplierProductId
```

over a global domain model hardwired to CJ IDs.

---

# 36. Conventional TypeScript architecture

Follow the repository's current conventions first.

Where improvements are necessary, aim for clear separation between:

- domain
- application/use cases
- supplier adapters
- persistence/infrastructure
- configuration
- dashboard/read models

Avoid:

- giant service classes
- giant utility files
- deeply nested conditionals
- magic strings
- magic numbers
- duplicated transformations
- duplicated niche logic
- raw CJ responses leaking into domain logic
- business logic inside React components
- business logic inside CLI handlers/controllers

Prefer:

- explicit types
- small cohesive modules
- pure functions where appropriate
- dependency injection/composition
- reusable rules
- centralized configuration
- deterministic behavior
- meaningful domain names

---

# 37. Avoid premature abstraction

Do not turn this into an enterprise plugin framework.

We currently have:

- one active supplier
- one main niche
- one discovery workflow

Build enough abstraction to avoid obvious lock-in and duplication.

A useful design test:

> Could we add a second niche without copying the discovery engine?

and:

> Could we later add a second supplier without rewriting ranking logic?

If yes, the architecture is sufficiently extensible.

Do not create layers that serve no current or plausible near-term purpose.

---

# 38. Extensibility validation

Use a hypothetical second niche to validate the design.

For example:

```text
HOME_PRODUCTS
```

Do NOT implement a complete second niche.

Instead demonstrate through a small test/fixture/profile that:

```text
PETS
and
HOME_PRODUCTS
```

can both use the same discovery pipeline.

The central engine should not need modification.

---

# 39. Do not implement external market research yet

Do NOT add integrations for:

- Google Trends
- TikTok
- Meta Ads Library
- Amazon
- competitor stores
- social scraping
- review scraping
- ad-spy services

in this task.

Those belong to a future market-validation layer.

Design normalized extension points only where they provide immediate architectural value.

---

# 40. Keep this task deliberately narrow

Future tasks will separately cover:

## Market validation

- external search demand
- social trends
- ad activity
- competitor saturation
- review velocity

## Economics

- live shipping quotes
- VAT
- fees
- expected retail price
- gross margin
- return allowance
- break-even CPA

## Publishing

- Shopify
- bol.com
- Etsy

## Maintenance

- stock monitoring
- price monitoring
- supplier availability
- listing trends
- declining-product detection
- replacement candidates
- nightly maintenance

## Orchestration integration

- scheduling
- job queues
- night shift
- triggering ecommerce jobs from the main orchestrator
- monitoring ecommerce job completion

## Fulfillment

- incoming orders
- supplier purchase
- tracking
- fulfillment exceptions

Do not implement these now.

---

# 41. Testing requirements

Add meaningful automated tests.

At minimum cover:

- original query search
- token search
- controlled expansion
- deterministic expansion
- optional Ollama expansion
- Ollama unavailable
- malformed Ollama result
- relevance exact match
- synonym/related match
- irrelevant product rejection
- negative terms
- multiple discovery strategies
- duplicate merging
- provenance preservation
- pagination
- API-budget stopping
- missing price
- missing inventory
- unverified inventory
- risk rules
- eligibility PASS
- eligibility REVIEW
- eligibility FAIL
- deterministic scoring
- confidence calculation
- persistence
- cache behavior
- partial CJ failure
- generic niche configuration
- hypothetical second niche using the same pipeline

Use realistic fixtures rather than trivial mocks.

---

# 42. Documentation

Update discovery documentation.

Explain:

- repository responsibility
- independence from external orchestrator
- discovery architecture
- supplier normalization
- niche profiles
- query processing
- optional Ollama integration
- discovery strategies
- pagination
- API budgeting
- candidate provenance
- eligibility
- scoring
- confidence
- risks
- persistence
- supplier observations
- caching
- limitations

Clearly state:

```text
CJ listing activity is not verified sales.
CJ Trending is not proof of market demand.
CJ inventory is not consumer popularity.
External demand is not currently measured.
Profitability is not currently proven.
Historical observations are persisted for future use.
Product maintenance is not currently implemented.
The external orchestrator is not currently integrated.
```

---

# 43. Implementation process

Before writing code:

1. inspect existing discovery code
2. inspect the CJ adapter
3. inspect current domain types
4. inspect Supabase schema
5. inspect tests
6. inspect dashboard/read models
7. inspect CLI/API entry points
8. identify pet-specific assumptions
9. identify CJ-specific leakage into domain logic
10. identify duplicated logic
11. verify assumptions against actual CJ behavior

Then provide a concise implementation plan.

The plan should state:

- what existing code remains
- what should be refactored
- what new modules/interfaces are required
- database migrations required
- tests required
- current architectural problems found
- unsupported CJ assumptions
- what will be implemented now
- what is intentionally deferred

Then implement the highest-value coherent discovery V2 slice.

Do not perform a speculative whole-platform rewrite.

---

# 44. Definition of done

This iteration is complete when:

1. product discovery has materially better recall than the current literal first-page implementation

2. original user intent remains central

3. controlled query expansion exists

4. optional Ollama enrichment is supported but not required

5. the ecommerce repository remains independent from the external orchestrator

6. no orchestrator integration is implemented

7. multiple CJ discovery strategies can contribute candidates where supported

8. pagination is controlled

9. API usage is budget-aware

10. products are deduplicated while provenance is preserved

11. relevance is significantly stronger than literal token matching

12. eligibility and scoring are separate concepts

13. scoring is explainable and versioned

14. supplier activity is not mislabeled as demand

15. score, confidence, and coverage are separate

16. supplier data is normalized before reaching generic discovery logic

17. discovery runs are persisted

18. timestamped supplier observations are persisted

19. no maintenance workflow is implemented

20. no nightly ecommerce job is implemented

21. no Shopify publishing is implemented

22. no external market-research integration is implemented

23. core discovery logic contains no pet-specific assumptions

24. adding another niche does not require duplicating the pipeline

25. reusable rules are composed rather than copied

26. a hypothetical second niche can use the same engine

27. the discovery application exposes clean application-level entry points suitable for a future external caller

28. there are no direct dependencies on the external orchestrator repository

29. tests cover the major edge cases

30. documentation accurately describes what the system currently knows and what remains future work

The main architectural goal is:

> Build ecommerce as an independent, reusable product-discovery system today, while making it easy for an external orchestrator to invoke it later without coupling the two codebases.

If this specification conflicts with the existing repository or the actual CJ API, prefer the technically correct implementation and document the discrepancy rather than forcing the requested architecture.

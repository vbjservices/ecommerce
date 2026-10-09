# GitHub issue audit — 2026-10-09

This audit compares the ten open `vbjservices/ecommerce` issues with the repository implementation and its automated checks. It records close recommendations only; issue state was not changed during the audit.

## Ready to close

| Issue | Reason |
| --- | --- |
| [#2 Product Discovery, Normalization & Candidate Storage](https://github.com/vbjservices/ecommerce/issues/2) | Real CJ products, variants, inventory, raw snapshots, normalized IDs, provenance, timestamps, deduplication, candidate lifecycle, atomic persistence, and explicit failures are implemented and tested. |
| [#4 Candidate Review & Shopify Publishing](https://github.com/vbjservices/ecommerce/issues/4) | Review, rejection, notes, audit history, approval, encrypted Shopify OAuth, unpublished draft creation/update, durable external IDs, explicit variant mappings, visible failures, and idempotent retry behavior are implemented. |
| [#8 System, Database & Repository Conventions](https://github.com/vbjservices/ecommerce/issues/8) | The modular boundaries, internal domain model, PostgreSQL workflow state, explicit mappings, unknown-value handling, provenance/history, server-only secrets, configuration, and testing conventions are established in code and documentation. |
| [#9 Supabase Database, Authentication & Security Foundation](https://github.com/vbjservices/ecommerce/issues/9) | Supabase is the persistent backend; Auth, membership checks, RLS, least-privilege browser reads, private raw data, service-role boundaries, migrations, environment hygiene, and reproducible security tests are in place. |

## Keep open

| Issue | Remaining work |
| --- | --- |
| [#1 Parent platform issue](https://github.com/vbjservices/ecommerce/issues/1) | The main milestone now reaches supplier data through human-approved Shopify drafts, but maintenance, external research, orders, purchasing, fulfillment, and tracking remain. |
| [#3 Product Research, Enrichment & Scoring](https://github.com/vbjservices/ecommerce/issues/3) | Supplier-side explainable scoring and risks exist. Market-demand adapters, competitive evidence, market-specific opportunity scores, historical change comparison, and backtesting still do not. |
| [#5 Supplier Integration Layer](https://github.com/vbjservices/ecommerce/issues/5) | Catalog discovery/import is behind a supplier adapter, but destination freight still lives in a CJ-specific Edge Function and the common supplier contract has no shipping, order, payment, tracking, or webhook capabilities yet. |
| [#6 Order & Fulfillment Pipeline](https://github.com/vbjservices/ecommerce/issues/6) | Domain placeholders exist, but webhook ingestion, persisted orders, assisted supplier purchasing, tracking, and Shopify fulfillment are not implemented. |
| [#7 Synchronization, Monitoring & Background Jobs](https://github.com/vbjservices/ecommerce/issues/7) | A bounded one-shot discovery command exists. Recurring synchronization, queues, retry history, alerts, stale-data policies, and reconciliation jobs remain. |
| [#10 Product Maintenance](https://github.com/vbjservices/ecommerce/issues/10) | This is the intended next major workflow after discovery calibration. No dedicated maintenance run, change detection, health state, event history, or maintenance dashboard exists yet. |

## Recommended close order

Close #2, #4, #8, and #9 with a short completion comment that points to the relevant migrations, application boundaries, documentation, and passing test suite. Keep #1 open as the parent until the larger replacement milestone is complete.

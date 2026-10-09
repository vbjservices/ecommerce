# ORION discovery integration

ORION owns scheduling and process supervision. This repository owns supplier access, discovery rules, local-model validation, budgets, persistence, and all ecommerce data. No ecommerce code or database state needs to be copied into ORION.

## Mac setup

Clone or update this repository on the Mac and install its pinned dependencies. Keep these values in this repository's ignored `.env.local` file:

```ini
CJ_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=your-installed-model-name
```

The local model is optional. When configured, it may only propose bounded query expansions. Its response must match the repository schema, it has a 20-second timeout, and invalid or unavailable output falls back to deterministic expansion. It does not approve products, change thresholds, choose prices, or write directly to Supabase.

## Stable batch contract

ORION should create or select a `product-discovery-plan.v1` JSON file and call:

```sh
npm run --silent discovery:batch -- --plan /absolute/path/to/discovery-plan.json
```

Validate a plan without supplier, model, or database access:

```sh
npm run --silent discovery:batch -- --plan config/discovery-plan.example.json --validate
```

The command writes one JSON object to stdout and exits. Normal batch output uses `product-discovery-batch.v1`; each completed job embeds a `product-discovery-job.v1` result. Exit code `0` means every job executed or reused its cache. Exit code `1` means a plan/configuration error or at least one failed job. ORION may archive stdout, alert on nonzero exit, and retry later; persisted-run caching makes normal retries safe.

For the two-job pilot, give the process a 30-minute outer timeout. Supplier calls are internally serialized and individually time out, but ORION should still terminate and report a process that never exits.

Plans contain one to four jobs. Jobs run sequentially so one scheduled process cannot create uncontrolled supplier concurrency. Example:

```json
{
  "schema": "product-discovery-plan.v1",
  "planId": "pets-pilot",
  "jobs": [
    { "query": "interactive cat toy", "profileId": "pets" },
    { "query": "slow feeder", "profileId": "pets" }
  ]
}
```

Each query is arbitrary and therefore category selection is dynamic. The profile is an explicit, version-controlled rule set; current choices are `generic`, `pets`, and `home-products`. An optional `filters` object can narrow a job by CJ category ID, warehouse country, cost range, minimum inventory, verified stock, product flag, free shipping, certification, or customization. Unknown fields and duplicate jobs are rejected.

ORION should pass seed intent and scheduling only. It should not construct supplier requests, alter scores, pass secrets on the command line, write ecommerce tables, or parse CJ payloads.

## Bounded workload

One job is limited to:

| Limit | Maximum |
| --- | ---: |
| Budgeted supplier operations, including media | 32 |
| Raw supplier rows across all strategies | 300 |
| Pages per strategy | 2 |
| Rows per page | 50 |
| Shortlist media enrichments | 20 |
| Local-model expansions | 4 by the current profiles |

The stored unique-candidate count can be lower than 300 because the same supplier product may appear through several strategies. A recommended two-job night can inspect at most 600 raw rows and use at most 64 budgeted CJ operations. A plan is hard-limited to four jobs, or 1,200 raw rows and 128 operations. CJ token authentication can add one provider request when a process does not already hold a token. Fresh equivalent runs are reused for six hours unless a job explicitly contains `"refresh": true`.

## Pilot cadence

For four weeks, schedule one two-job plan on Monday, Wednesday, and Friday at 02:00 Europe/Amsterdam. Rotate seed queries and review false positives, missed products, evidence coverage, and supplier-field quality. Once thresholds are stable, move broad discovery to Tuesday and Saturday. Later product maintenance should receive the earlier nightly slot and discovery should run afterward.

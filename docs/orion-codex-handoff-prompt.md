# Codex handoff prompt for the ORION repository

Copy the prompt below into a Codex session opened in the ORION repository on the Mac mini.

```text
You are working inside my ORION orchestrator repository on a Mac mini.

Your task is to integrate ORION with my separate ecommerce repository as a scheduler and process supervisor only. Complete the integration using the existing ORION conventions. Do not copy ecommerce business logic into ORION and do not couple the repositories at source-code level.

Architecture boundary

- ORION owns the schedule, process lifecycle, outer timeout, structured run logging, and morning/night-shift reporting.
- The ecommerce repository owns CJ and future supplier adapters, discovery queries and profiles, risk/eligibility/scoring rules, Ollama response validation, API budgets, Supabase persistence, dashboard data, Shopify integration, and later product maintenance.
- Ollama is a local service available on the Mac. ORION does not generate product decisions itself. The ecommerce worker calls Ollama for bounded query expansion when OLLAMA_BASE_URL and OLLAMA_MODEL are configured in the ecommerce environment.
- Supabase, CJ, Shopify, and ecommerce secrets remain in the ecommerce repository's ignored environment file or its existing secret store. Never copy secret values into ORION configuration, command arguments, logs, or source files.
- ORION must not query or write the ecommerce Supabase database directly.
- ORION must not parse CJ payloads, calculate product scores, approve products, publish Shopify products, or create supplier orders.

First inspect both repositories

1. Read all applicable AGENTS.md and repository instructions in ORION before editing.
2. Inspect ORION's existing scheduler, task registry, resource locking, subprocess runner, timeout handling, structured logging, and night-shift reporting. Reuse those mechanisms rather than creating a parallel scheduler.
3. Locate the ecommerce repository through an existing ORION path/config convention. Prefer an ECOMMERCE_REPO_PATH setting if a new setting is needed. Do not assume a machine-specific absolute path in business logic.
4. In the ecommerce repository, read these files before designing the integration:
   - README.md
   - docs/orion-integration.md
   - docs/discovery.md
   - docs/discovery-v2-progress.md
   - config/discovery-plan.example.json
   - package.json
   - src/server/discovery/discovery-plan.ts
   - src/server/run-discovery-plan-cli.ts
5. Treat the ecommerce repository documentation and versioned command schemas as authoritative. If ORION assumptions conflict with them, adapt ORION rather than duplicating the ecommerce implementation.

Existing ecommerce command contract

From the ecommerce repository working directory, validate a plan with:

npm run --silent discovery:batch -- --plan config/discovery-plan.example.json --validate

Run a real plan with:

npm run --silent discovery:batch -- --plan /absolute/path/to/discovery-plan.json

The plan schema is product-discovery-plan.v1. Normal output is one product-discovery-batch.v1 JSON object on stdout. Completed jobs contain product-discovery-job.v1 results. Exit code 0 means all jobs executed or reused cache. Exit code 1 means invalid setup/plan or at least one failed job.

The ecommerce repository deliberately limits each plan to four sequential jobs. The pilot must use two jobs. Each job is capped at 300 raw supplier rows, 32 budgeted supplier operations, two pages per strategy, 50 rows per page, 20 media enrichments, and four current local-model expansions. Equivalent completed runs are cached for six hours unless refresh is explicitly requested.

Profiles are rule presets, not allowed product categories. Current profiles are generic, pets, and home-products. A job query can describe any category, and optional filters can provide a CJ category ID, warehouse country, cost range, minimum inventory, verified-stock requirement, product flag, free-shipping marker, certification requirement, or customization requirement. New category-specific profiles must be added and tested in the ecommerce repository after evidence from real runs; never create shadow profiles in ORION.

Implement in ORION

1. Add one ecommerce discovery task using ORION's existing task/scheduler abstraction.
2. Run it from the ecommerce repository working directory without shell-built command interpolation. Pass the executable and arguments as structured subprocess arguments if ORION supports that.
3. Use the IANA timezone Europe/Amsterdam so daylight-saving changes do not shift the intended local schedule.
4. Pilot schedule: Monday, Wednesday, and Friday at 02:00 Europe/Amsterdam for four weeks.
5. Point each scheduled execution at a two-job product-discovery-plan.v1 file owned alongside the ecommerce configuration. ORION may select among explicitly configured plan files for rotation, but it must not invent supplier filters or scoring rules.
6. Apply a 30-minute outer timeout to the two-job process. On timeout, terminate the full subprocess tree using ORION's existing safe process-control mechanism.
7. If ORION has resource locks, use the existing Ollama/model resource lock so discovery does not compete with another local-model-heavy task. Do not add a second Ollama server.
8. Capture stdout and stderr separately. Parse stdout as one JSON object and verify product-discovery-batch.v1 before marking the task successful.
9. Record only operational fields needed for the night-shift report: planId, status, start/end/duration, job counts, candidate count, observation count, API operations used, cached versus supplier runs, warning count, exit code, and sanitized error. Never log environment values or raw supplier payloads.
10. During the pilot, do not silently retry a failed supplier run repeatedly. Report the failure in the morning summary. A later retry policy can be added after we know the real CJ failure modes; ecommerce caching already makes a deliberate retry safe.
11. Keep the task independently startable and stoppable using existing ORION controls.
12. Add focused tests for schedule registration, working directory/argument construction, timeout propagation, JSON-schema/status handling, secret redaction, and resource-lock behavior. Do not test ecommerce scoring inside ORION.
13. Update ORION's local documentation with the ecommerce repo path setting, plan path setting, schedule, timeout, command contract, and troubleshooting location.

Validation sequence

1. Run the ecommerce plan validation command. It must succeed without supplier or database calls.
2. Run the relevant ORION unit/integration tests.
3. Exercise the ORION task runner with a validation-only command or fixture result to prove working directory, timeout, output parsing, and reporting without starting an uncontrolled live search.
4. Verify the real ecommerce environment contains the required variable names without printing their values: CJ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OLLAMA_BASE_URL, and OLLAMA_MODEL.
5. Verify the configured Ollama model exists using ORION's existing local-model health mechanism if one exists.
6. Show the final schedule, command arguments, selected plan file, timeout, resource lock, tests, and operational report shape.

Next steps after the scheduler is working

- Run the controlled two-query pilot and review results in the ecommerce dashboard.
- Record false positives, missed products, unknown evidence, provider overlap, and CJ field reliability.
- Make profile synonyms, exclusions, thresholds, weights, and risk changes only in the ecommerce repository, with tests and version changes.
- Add operator feedback and run-level filters in the ecommerce repository.
- Enrich shortlisted variants and shipping evidence.
- Add independent normalized external market-research adapters.
- Keep Ollama limited to sourced summarization and bounded query expansion.
- Build product maintenance as a separate ecommerce command later; ORION will schedule it in the same way and give it priority over broad discovery.

Acceptance criteria

- ORION can invoke one bounded ecommerce discovery plan on schedule.
- No ecommerce application code or secrets are copied into ORION.
- The ecommerce process uses its own Supabase database and supplier integrations.
- Output is schema-checked and appears in ORION's normal task/night-shift reporting.
- Timeout and local-model resource locking use existing ORION infrastructure.
- The task can be started, stopped, and diagnosed without editing ecommerce business logic.
- Tests and documentation pass, and unrelated ORION workflows remain unchanged.
```

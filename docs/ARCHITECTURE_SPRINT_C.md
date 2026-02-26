# Sprint C: Scoring Pipeline Split (Heuristics + AI + Evidence + Metrics)

## Scope
Split scoring into deterministic and AI stages without breaking existing API responses.

## What Changed
- Added heuristic engine:
  - `worker/src/domains/scoring/heuristics.js`
- Expanded scoring orchestrator:
  - `worker/src/domains/scoring/index.js`
  - stage flow: `heuristic -> ai_extract (optional) -> ai_reason -> evidence_upsert (optional)`
- Added scoring run persistence migration:
  - `worker/migrations/009_scoring_runs.sql`

## Worker Integration
Scoring routes now use the shared pipeline helper:
- `/jobs/:job_key/manual-jd`
- `/jobs/:job_key/rescore`
- `/jobs/:job_key/auto-pilot`
- `/score-pending`
- ingest auto-score path inside `ingestRawUrls_`

### Heuristic Short-Circuit
- If Stage 1 fails, AI scoring is skipped.
- Job transition uses:
  - `status = REJECTED`
  - `system_status = REJECTED_HEURISTIC`

## Metrics Persistence
For each scored job run, a row is written to `scoring_runs` (if migration is applied), including:
- `final_status`
- `heuristic_reasons_json`
- `stage_metrics_json` (latency + token counters)
- `ai_model`, `ai_tokens_*`, `total_latency_ms`

If the table is not present yet, scoring continues normally (no runtime break).

## Compatibility
- Existing response payloads remain backward-compatible.
- No route removals.
- Existing `job_evidence` behavior remains unchanged.

## Validation
- `node --check worker/src/domains/scoring/heuristics.js`
- `node --check worker/src/domains/scoring/index.js`
- `node --check worker/src/worker.js`

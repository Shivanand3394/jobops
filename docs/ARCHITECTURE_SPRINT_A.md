# Sprint A: Domain Decoupling (No Behavior Change)

## Goal
Move JobOps from a single-runtime file shape to a domain-first layout without changing request/response behavior.

## What Was Added
- New orchestrator entrypoint:
  - `worker/src/index.js`
- New domain modules:
  - `worker/src/domains/ingest/index.js`
  - `worker/src/domains/scoring/index.js`
  - `worker/src/domains/resume/index.js`
  - `worker/src/domains/tracking/index.js`
  - `worker/src/domains/contacts/index.js`
  - `worker/src/domains/contacts/adapter.js` (Sprint F: persistence wiring)
  - `worker/src/domains/index.js`
- New shared contract:
  - `worker/src/shared/contracts/candidate_ingest.js`

## Entry Point
- Wrangler `main` changed from `src/worker.js` to `src/index.js`.
- `src/index.js` delegates runtime directly to the existing worker export, so live behavior is unchanged.

## Candidate Ingest Envelope (Layer 1 Contract)
```json
{
  "source": "GMAIL | WHATSAPP | RSS | MANUAL",
  "raw_payload": {},
  "canonical_job": {
    "title": "",
    "company": "",
    "description": "",
    "external_id": "",
    "job_url": "",
    "source_domain": ""
  },
  "ingest_timestamp": 0
}
```

## Why This Sprint Is Safe
- Existing routes remain in `worker/src/worker.js`.
- Existing auth, D1, AI logic unchanged.
- New modules are additive scaffolding for later extraction in Sprints B-F.

## Validation
- `node --check worker/src/index.js`
- `node --check worker/src/worker.js`
- `node --check worker/src/domains/**/*.js` (run per file)
- `node --check worker/src/shared/contracts/candidate_ingest.js`

## Next Sprint Hook
- Sprint B can move Gmail/RSS/manual adapters to consume and emit the shared ingest envelope consistently before scoring.

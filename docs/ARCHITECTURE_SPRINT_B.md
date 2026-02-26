# Sprint B: Ingest Unification (Adapters + Factory + Source Diagnostics)

## Scope
Incremental ingest-layer refactor only. No endpoint contract break.

## Commit 1: Source Adapters
Added source-specific adapters:
- `worker/src/domains/ingest/adapters/gmail.js`
- `worker/src/domains/ingest/adapters/rss.js`
- `worker/src/domains/ingest/adapters/manual.js`
- shared helper: `worker/src/domains/ingest/adapters/common.js`

Each adapter maps source payloads to canonical job candidates.

## Commit 2: Ingest Factory
`worker/src/domains/ingest/index.js` now exposes:
- `processIngest(payload, source)`

Factory responsibilities:
- choose adapter by source,
- produce canonical envelopes,
- validate envelope minimum contract,
- return normalized `ingest_input` (`raw_urls`, `email_text`, `email_html`, `email_subject`, `email_from`).

Wiring updates:
- `/ingest` route uses `processIngest(..., "MANUAL")`
- Gmail poll ingest callback uses `processIngest(..., "GMAIL")`
- RSS poll/diagnostics ingest callbacks use `processIngest(..., "RSS")`

## Commit 3: Source Diagnostics
`worker/src/domains/ingest/index.js` now exposes:
- `sourceHealthCheck(processed, opts)`

Worker uses diagnostics logging helper:
- `logIngestSourceHealthIfNeeded_(...)`
- emits `INGEST_SOURCE_HEALTH` events when source status is `degraded` or `failing`.

Diagnostics fields:
- `source`, `status`, `reasons`
- `total`, `valid`, `invalid`, `valid_ratio`, `min_valid_ratio`
- route context (`/ingest`, `/gmail/poll`, `/rss/poll`, `/rss/diagnostics`)

## Validation
- `node --check worker/src/domains/ingest/index.js`
- `node --check worker/src/worker.js`


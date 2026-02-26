# Deployment Sanity Checklist (Cloudflare)

## 1) Worker Deployability (/worker)

Required in [worker/wrangler.jsonc](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc):
- `main`: `src/worker.js`
- D1 binding: `DB`
- vars: `ALLOW_ORIGIN` (default can be `*` for debug)

Required Worker secrets/vars in Cloudflare:
- `UI_KEY` (UI auth)
- `API_KEY` (admin/api auth)
- `ALLOW_ORIGIN` (production: `https://getjobs.shivanand-shah94.workers.dev`)
- AI binding:
  - preferred binding name: `AI`
  - or set `AI_BINDING` to another binding name

Deploy commands:
```bash
cd worker
wrangler d1 migrations apply jobops-db --remote
wrangler deploy
```

## 2) D1 schema checks
Baseline migration file: [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql)
- tables expected: `jobs`, `targets`, `events`
- `targets.reject_keywords_json` exists in baseline
- checklist columns (`applied_note`, `follow_up_at`, `referral_status`) are not in baseline; worker now guards checklist routes and returns clear 400 if missing.

## 3) Pages Deployability (/ui)
Cloudflare Pages settings:
- Framework preset: `None`
- Build command: empty
- Output directory: `ui`
- Production branch: `main`

Static files must exist:
- `ui/index.html`
- `ui/app.js`
- `ui/styles.css`

## 4) CORS & auth runtime validation
- Worker preflight: `OPTIONS` handled globally.
- Headers returned include:
  - `Access-Control-Allow-Origin`
  - `Access-Control-Allow-Methods: POST,GET,OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type,x-ui-key,x-api-key`
- Production should pin `ALLOW_ORIGIN` to Pages domain (avoid `*`).

## 5) Quick post-deploy checks
1. `GET /health` -> `ok=true`
2. `POST /ingest` with UI key works.
3. `POST /score-pending` works with UI key and API key.
4. Targets list/save works with UI key.
5. Checklist route behavior:
   - if columns present -> normal success.
   - if columns missing -> clear `400 Checklist fields not enabled in DB schema`.

## 6) Pages deploy triage
If UI not deploying, follow [docs/PAGES_NOT_DEPLOYING_TRIAGE.md](/c:/Users/dell/Documents/GitHub/jobops/docs/PAGES_NOT_DEPLOYING_TRIAGE.md).

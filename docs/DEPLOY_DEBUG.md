# Deploy Debug (Worker + Pages)

## 1) Worker dashboard checks (Cloudflare Workers)

1. Confirm service and branch target.
- Worker name: `get-job`
- Latest deployment revision matches expected commit window.

2. Confirm bindings.
- D1 binding exists with variable name `DB`.
- Workers AI binding exists as `AI`, or `AI_BINDING` points to a valid binding name.

3. Confirm secrets/vars.
- `UI_KEY` set
- `API_KEY` set
- `ALLOW_ORIGIN` is either `*` (debug) or exact UI origin in production

4. Verify runtime quickly.
- `GET /health` returns 200
- UI-key request to `/jobs` returns 200
- `/score-pending` works with UI or API key

## 2) Pages dashboard checks (Cloudflare Pages)

1. Git integration
- Repo connected: `Shivanand3394/jobops`
- Production branch: `main`

2. Build configuration
- Framework preset: `None`
- Build command: empty
- Output directory: `ui`

3. Artifact checks
- `ui/index.html` present
- `ui/app.js` present
- `ui/styles.css` present

4. Deployment logs to inspect
- "Output directory not found"
- "No index.html"
- repo access token/webhook errors
- canceled/queued builds stuck without start

## 3) Common root conflicts

1. Wrong output path
- Using repo root `.` instead of `ui` causes missing app artifact issues.

2. Wrong branch
- Deploying preview branch while expecting production `main`.

3. CORS mismatch after successful deploy
- Pages up but Worker rejects origin because `ALLOW_ORIGIN` not matching UI domain.

## 4) Fast recovery actions

1. Retry latest Pages deploy from dashboard.
2. Trigger empty commit to main:
```bash
git commit --allow-empty -m "chore: trigger pages deploy"
git push origin main
```
3. Recheck Worker env vars/secrets if UI shows Unauthorized/CORS errors.

## 5) Local reproduction checks

UI is static; no npm is required.

Option A:
```bash
cd ui
python -m http.server 8788
```

Option B:
```bash
wrangler pages dev ui
```

Then in browser UI Settings:
- API base URL -> worker domain
- UI key -> valid `UI_KEY`

## 6) Minimal validation after deploy

1. Load UI home and verify Jobs list fetch succeeds.
2. Ingest one URL and confirm deterministic summary (`inserted/updated/ignored/link_only`).
3. Open job detail, run `Rescore this job`, verify non-401 response.

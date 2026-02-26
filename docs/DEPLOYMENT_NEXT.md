# Deployment Next (Worker + Pages)

## 1) Worker Deploy Checklist

## Required bindings
- `DB` (D1 binding name must be exactly `DB`)
- `AI` binding recommended for Workers AI
- Alternative: set `AI_BINDING` var to the actual binding name used in your Worker

## Required secrets (names only)
- `UI_KEY`
- `API_KEY`
- `GMAIL_CLIENT_SECRET`
- `TOKEN_ENC_KEY`

## Required vars
- `ALLOW_ORIGIN`
- `GMAIL_CLIENT_ID`
- `GMAIL_QUERY`
- `GMAIL_MAX_PER_RUN`

## Required schedule
- Cron trigger for Gmail polling (current repo: `*/15 * * * *`)

## Verify before deploy
```powershell
cd worker
wrangler whoami
wrangler d1 list
wrangler secret list
Get-Content .\wrangler.jsonc
wrangler deploy --dry-run
```

## Deploy
```powershell
cd worker
wrangler d1 migrations apply jobops-db --remote
wrangler deploy
```

## Post-deploy sanity
- `GET /health` returns `ok=true`
- `GET /jobs?limit=1` with `x-ui-key` returns 200
- `GET /gmail/auth` with `x-ui-key` returns 302
- `POST /gmail/poll` with `x-api-key` returns 200

## 2) Pages Deploy Checklist

## Required Cloudflare Pages settings
- Production branch: `main`
- Root directory: repo root
- Build command: empty (or no-op)
- Output directory: `ui`
- Framework preset: `None`

## Artifact checks in repo
- `ui/index.html`
- `ui/app.js`
- `ui/styles.css`

## Runtime UI note
- UI uses runtime Settings modal (`ui/app.js`) for:
  - Worker base URL
  - `x-ui-key`
- These are stored in browser localStorage; Pages env vars are not required for this static UI.

## 3) “Pages Not Deploying for Hours” Triage
1. Confirm repo + branch mapping still points to `Shivanand3394/jobops` `main`.
2. Confirm output directory is `ui` (not `.`).
3. Check build logs for:
   - `Output directory not found`
   - `No index.html`
   - Git integration/webhook/auth failures
4. Retry latest deploy from Pages dashboard.
5. If still stuck, trigger empty commit to `main`:
```bash
git commit --allow-empty -m "chore: trigger pages redeploy"
git push origin main
```

## 4) Windows Wrangler Permission Error Workaround
Symptom example: permission failure on `C:\Users\dell\Application Data`.

Likely causes
- Shell running with a mismatched user/profile context
- Locked or inaccessible Wrangler config/cache path
- Stale auth/session state

Safe remediation steps
1. Open a fresh PowerShell session as the same Windows user that owns the repo profile.
2. Verify auth and account context:
```powershell
wrangler whoami
```
3. Retry the failing Wrangler command from `worker/`.
4. If still failing, re-auth Wrangler and retry:
```powershell
wrangler logout
wrangler login
```
5. Ensure `%USERPROFILE%` resolves to your active user profile in that shell.

If unresolved, use `wrangler tail` during deploy attempts to separate local permission failures from remote Worker errors.

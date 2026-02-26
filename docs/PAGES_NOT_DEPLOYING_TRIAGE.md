# Pages Not Deploying - Triage

## 1) Confirm repo + branch wiring
- Repo: `Shivanand3394/jobops`
- Production branch: `main`
- Latest commit visible in GitHub and Cloudflare Pages dashboard

## 2) Confirm build settings (static UI)
- Framework preset: `None`
- Build command: empty
- Output directory: `ui`

## 3) Confirm artifact presence in repo
- `ui/index.html`
- `ui/app.js`
- `ui/styles.css`
- Relative references in `index.html` are correct

## 4) Check build logs for deterministic failures
- `Output directory not found`
- `No index.html`
- accidental build command failures
- repository integration/token failures

## 5) Check GitHub integration + webhooks
- Verify Pages Git integration is healthy
- Validate webhook deliveries are 2xx
- Reconnect integration if token was revoked/rotated

## 6) Force redeploy safely
1. Retry deployment in Pages dashboard
2. Push empty commit:
```bash
git commit --allow-empty -m "chore: trigger pages redeploy"
git push origin main
```

## 7) Runtime sanity after successful deploy
- Open `https://getjobs.shivanand-shah94.workers.dev`
- Verify Jobs and Targets tabs render
- Verify API requests include `x-ui-key`
- If API calls fail, validate Worker CORS (`ALLOW_ORIGIN`) and Worker secrets (`UI_KEY`/`API_KEY`)

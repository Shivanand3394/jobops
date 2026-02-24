# Pages Not Deploying — Triage

## 1) Check branch / repo connection
- Confirm Pages project is connected to `Shivanand3394/jobops`.
- Confirm production branch is `main`.
- Confirm recent commits exist in GitHub and are visible to Pages.

## 2) Check build settings (root dir, output dir)
- Static UI should deploy from `ui` directory.
- Build command should be empty/none for this static setup.
- Output directory should point to `ui`.

## 3) Check build logs for output dir errors
- Look for:
  - "Output directory not found"
  - "No index.html"
  - build command failures (if command mistakenly configured)

## 4) Check GitHub integration/webhooks
- In Pages -> Settings -> Git integration, verify repo auth is still valid.
- Check webhook/delivery logs for 4xx/5xx failures.
- Reconnect integration if tokens were rotated/revoked.

## 5) Force redeploy options
- Retry deploy from Cloudflare dashboard.
- Push empty commit:
  - `git commit --allow-empty -m "chore: trigger pages redeploy"`
  - `git push origin main`

## 6) File checklist for `/ui`
- `ui/index.html` exists
- `ui/app.js` exists
- `ui/styles.css` exists
- No broken relative references in `index.html`
- Assets committed to `main` (not only local)

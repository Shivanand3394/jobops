# Cloudflare Pages Deployment (UI)

Use these exact settings for this repo.

## Project settings
- Repository: `Shivanand3394/jobops`
- Production branch: `main`
- Root directory: repository root (do not set `ui` as root)
- Framework preset: `None`
- Build command: empty (or no-op)
- Output directory: `ui`

## Required UI artifacts
Must exist in repo at deploy time:
- [`ui/index.html`](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html)
- [`ui/app.js`](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js)
- [`ui/styles.css`](/c:/Users/dell/Documents/GitHub/jobops/ui/styles.css)

## Runtime behavior note
This UI reads API base URL + UI key from local browser storage via the Settings modal.

- API base default in code:
  - [`ui/app.js`](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js:1)
- User-configured values:
  - `jobops_api_base`
  - `jobops_ui_key`

Pages env vars are not required for current runtime unless you add a build step or templating.

## Post-deploy sanity checks
1. Open UI URL:
   - `https://getjobs.shivanand-shah94.workers.dev`
2. Open Settings in UI and verify:
   - API base points to Worker domain
   - UI key is set
3. Confirm UI loads jobs list successfully.
4. If UI calls fail, check Worker `ALLOW_ORIGIN` and key secrets.

## Common failures
- `Output directory not found`
  - Fix output directory = `ui`.
- `No index.html`
  - Ensure `ui/index.html` exists in branch `main`.
- Deployed but blank/unauthorized UI
  - Set UI key in Settings modal and verify Worker `UI_KEY`.

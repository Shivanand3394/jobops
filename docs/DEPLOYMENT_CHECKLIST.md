# Deployment Sanity Checklist (Cloudflare)

## Workers Builds
- Project root dir: `worker`
- Entry file: `worker/src/worker.js`
- Required bindings:
  - D1 binding: `DB`
  - Workers AI binding: `AI` (or set `AI_BINDING` and ensure referenced binding exists)
- Required secrets:
  - `UI_KEY`
  - `API_KEY`
- Vars:
  - `ALLOW_ORIGIN` (production should be `https://getjobs.shivanand-shah94.workers.dev`; `*` only for debug)
  - `AI_BINDING` (optional)

### Verify deployed version matches latest commit
- Cloudflare dashboard: Worker -> Deployments -> compare latest deployment time/hash with Git commit.
- CLI spot-check:
  - `git rev-parse --short HEAD`
  - Ensure Worker deployment corresponds to that revision in build/deploy logs.

## D1
- Ensure DB exists and ID matches [worker/wrangler.jsonc](/c:/Users/dell/Documents/GitHub/jobops/worker/wrangler.jsonc).
- Apply migrations:
  - local: `wrangler d1 migrations apply jobops-db --local`
  - remote: `wrangler d1 migrations apply jobops-db --remote`
- Verify tables: `jobs`, `targets`, `events` from [worker/migrations/001_init.sql](/c:/Users/dell/Documents/GitHub/jobops/worker/migrations/001_init.sql).

## Pages
- Build source: repo root, static content directory `ui`
- Framework preset: `None`
- Build command: none (static site)
- Output directory: `ui`
- Production branch: `main`
- Confirm build output:
  - `ui/index.html` exists
  - `ui/app.js` and `ui/styles.css` exist
  - settings match [ui/README_DEPLOY.md](/c:/Users/dell/Documents/GitHub/jobops/ui/README_DEPLOY.md)

## Webhooks / Integration Checks
- In Cloudflare Pages project, confirm GitHub integration is healthy.
- In GitHub repo settings -> Webhooks (if visible), verify deliveries are succeeding.
- In Cloudflare build logs, confirm new push triggers build event.

## Force Redeploy options
1. Use Cloudflare Pages `Retry deployment` on latest failed/successful build.
2. Push empty commit:
   - `git commit --allow-empty -m "chore: trigger pages redeploy"`
   - `git push origin main`
3. For Worker, run `wrangler deploy` manually if build pipeline is delayed.

## Common reasons UI doesn’t deploy
- Wrong output directory (not `ui`)
- Build command set for static site and failing
- Branch mismatch (not building `main`)
- GitHub webhook/integration token issue
- Missing `ui/index.html`
- Repo connection accidentally moved/disconnected

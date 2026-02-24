# UI Deploy (Cloudflare Pages)

Use these exact settings for this repo layout:

- Project type: `Pages`
- Framework preset: `None`
- Production branch: `main`
- Build command: leave empty
- Build output directory: `ui`

Repo paths:
- [ui/index.html](/c:/Users/dell/Documents/GitHub/jobops/ui/index.html)
- [ui/app.js](/c:/Users/dell/Documents/GitHub/jobops/ui/app.js)
- [ui/styles.css](/c:/Users/dell/Documents/GitHub/jobops/ui/styles.css)

Notes:
- This UI is static and does not require a build step.
- Routing is single-page without History API paths, so `_redirects` is not required.
- If deploys do not trigger, use checklist in [docs/PAGES_NOT_DEPLOYING_TRIAGE.md](/c:/Users/dell/Documents/GitHub/jobops/docs/PAGES_NOT_DEPLOYING_TRIAGE.md).

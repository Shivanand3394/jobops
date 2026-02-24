# Branch Protection for `main`

Apply this in GitHub: `Settings` -> `Branches` -> `Add branch protection rule`.

Rule target:
- Branch name pattern: `main`

Required settings:
- Require a pull request before merging
- Require approvals: `1`
- Dismiss stale pull request approvals when new commits are pushed (recommended)
- Require conversation resolution before merging
- Require status checks to pass before merging
- Require branches to be up to date before merging (recommended)
- Do not allow bypassing the above settings (recommended for admins)
- Allow force pushes: **disabled**
- Allow deletions: **disabled**

Optional hardening:
- Restrict who can push to matching branches (maintainers only)
- Require signed commits (if your team uses commit signing)

Expected workflow after enabling:
1. Work on feature branch.
2. Open PR to `main`.
3. CI checks must pass.
4. At least 1 reviewer approves.
5. Merge PR (no direct push to `main`).

# Smoke Pack Artifacts

`scripts/smoke_pack.mjs` writes the latest scripted Sprint E smoke run report here by default:

- `docs/artifacts/smoke_pack_latest.json`

The report includes step-by-step status, response snapshots, and a pass/fail summary so runs can be reviewed without rerunning immediately.

CI workflow `.github/workflows/smoke-pack.yml` also uploads this file as a run artifact (`smoke-pack-<run_id>`).

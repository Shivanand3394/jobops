#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://get-job.shivanand-shah94.workers.dev}"
UI_KEY="${UI_KEY:-}"

if [[ -z "$UI_KEY" ]]; then
  echo "UI_KEY is required (x-ui-key for /jobs)."
  exit 1
fi

health_code="$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/health")"
if [[ "$health_code" != "200" ]]; then
  echo "FAIL: /health returned HTTP $health_code"
  exit 1
fi
echo "PASS: /health returned 200"

jobs_code="$(curl -sS -o /dev/null -w "%{http_code}" -H "x-ui-key: $UI_KEY" "$BASE_URL/jobs?limit=1")"
if [[ "$jobs_code" != "200" ]]; then
  echo "FAIL: /jobs?limit=1 returned HTTP $jobs_code"
  exit 1
fi
echo "PASS: /jobs?limit=1 returned 200"

echo "Smoke checks passed."

# Recovery + Tuning Checklist (Latest)

Generated: 2026-02-26T10:46:42.8484642Z

## Recovery Run Summary
- Backfill missing: picked=6, processed=6, inserted_or_updated=6, link_only=3
- Rescore existing JD: picked=12, updated=0
- Archived evidence rebuild loop: attempted=5,succeeded=5,failed=0,rows_created=0,has_more=True | attempted=1,succeeded=1,failed=0,rows_created=0,has_more=False

## Coverage Snapshot
- Archived total: 17
- Archived with evidence: 11
- Archived analyzed jobs: 11

Top missing must-have requirements:
- digital marketing (7)
- growth (7)
- partnership-led marketing (7)
- performance metrics (7)
- strategic marketing (7)
- SEM/SEO (6)

## Scoring Efficiency Snapshot (14d)
- Total runs: 62
- Heuristic reject rate: 6.45%
- Avg total latency: 1823.02 ms
- Avg AI latency: 1823.02 ms
- AI tokens total (window): 67546

## Recommended Tuning Actions
1. Increase heuristic gate slightly to cut AI spend on weak matches:
   - Raise min_target_signal from 8 to 10-12 and compare reject rate delta over 3 days.
2. Reduce manual-link noise from LinkedIn blocked URLs:
   - Keep strict_linkedin policy and route these directly to manual JD workflow; avoid automatic retries.
3. Close archived evidence coverage gap:
   - Prioritize archived jobs that have JD text but no evidence rows; skip jobs with permanently blocked/no JD sources.
4. Profile vocabulary optimization:
   - Add measurable examples for the top 3 repeated gaps in profile summary/bullets and regenerate packs for archived near-miss jobs.
5. Track change impact:
   - Re-run /admin/scoring-runs/report after tuning and compare reject rate, avg latency, and token total against this snapshot.

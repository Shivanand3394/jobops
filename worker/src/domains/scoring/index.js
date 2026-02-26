import { evaluateScoringHeuristics_ } from "./heuristics.js";

export const SCORING_PIPELINE_STAGES = Object.freeze([
  "heuristic",
  "ai_extract",
  "ai_reason",
  "evidence_upsert",
]);

function nowMs_() {
  return Date.now();
}

function clampInt_(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

function initStageMetric_(stage) {
  const ts = nowMs_();
  return {
    stage,
    status: "skipped",
    started_at: ts,
    finished_at: ts,
    latency_ms: 0,
    error: null,
    tokens_in: 0,
    tokens_out: 0,
    tokens_total: 0,
  };
}

function stageDone_(metric, status, startedAt, error = null, usage = null) {
  const end = nowMs_();
  const usageObj = usage && typeof usage === "object" ? usage : {};
  return {
    ...metric,
    status,
    started_at: startedAt,
    finished_at: end,
    latency_ms: Math.max(0, end - startedAt),
    error: error ? String(error).slice(0, 400) : null,
    tokens_in: clampInt_(usageObj.input_tokens || usageObj.tokens_in || 0, 0, 5_000_000),
    tokens_out: clampInt_(usageObj.output_tokens || usageObj.tokens_out || 0, 0, 5_000_000),
    tokens_total: clampInt_(usageObj.total_tokens || usageObj.tokens_total || 0, 0, 5_000_000),
  };
}

export function buildScoringRunMeta_(input = {}) {
  return {
    job_key: String(input.job_key || "").trim(),
    source: String(input.source || "").trim().toUpperCase() || "UNKNOWN",
    started_at: Number.isFinite(Number(input.started_at)) ? Number(input.started_at) : nowMs_(),
    finished_at: Number.isFinite(Number(input.finished_at)) ? Number(input.finished_at) : null,
    ok: Boolean(input.ok),
    final_status: String(input.final_status || "COMPLETED").trim().toUpperCase(),
    short_circuit: Boolean(input.short_circuit),
    heuristic_reasons: Array.isArray(input.heuristic_reasons) ? input.heuristic_reasons : [],
    note: String(input.note || "").trim().slice(0, 500),
    stages: input.stages && typeof input.stages === "object" ? input.stages : {},
  };
}

export async function runScoringPipeline_(input = {}) {
  const startedAt = nowMs_();
  const stages = Object.fromEntries(SCORING_PIPELINE_STAGES.map((s) => [s, initStageMetric_(s)]));

  const heuristicStarted = nowMs_();
  const heuristic = evaluateScoringHeuristics_(
    {
      role_title: input.role_title,
      location: input.location,
      seniority: input.seniority,
      jd_clean: input.jd_clean,
    },
    {
      targets: Array.isArray(input.targets) ? input.targets : [],
      min_jd_chars: input.min_jd_chars,
      min_target_signal: input.min_target_signal,
      blocked_keywords: input.blocked_keywords,
    }
  );
  stages.heuristic = stageDone_(stages.heuristic, heuristic.passed ? "ok" : "rejected", heuristicStarted);

  if (!heuristic.passed) {
    const finishedAt = nowMs_();
    return {
      ok: true,
      final_status: "REJECTED_HEURISTIC",
      short_circuit: true,
      heuristic,
      extracted: null,
      scoring: null,
      evidence: null,
      stages,
      started_at: startedAt,
      finished_at: finishedAt,
      total_latency_ms: Math.max(0, finishedAt - startedAt),
    };
  }

  let extracted = null;
  if (typeof input.onAiExtract === "function") {
    const extractStarted = nowMs_();
    try {
      const extractResult = await input.onAiExtract();
      extracted = extractResult?.data ?? extractResult ?? null;
      stages.ai_extract = stageDone_(
        stages.ai_extract,
        "ok",
        extractStarted,
        null,
        extractResult?.usage || extractResult?.meta || null
      );
    } catch (err) {
      stages.ai_extract = stageDone_(stages.ai_extract, "failed", extractStarted, err?.message || err);
      throw err;
    }
  }

  if (typeof input.onAiReason !== "function") {
    throw new Error("runScoringPipeline_ requires onAiReason callback");
  }

  let scoring = null;
  const reasonStarted = nowMs_();
  try {
    const reasonResult = await input.onAiReason({ heuristic, extracted });
    scoring = reasonResult?.data ?? reasonResult ?? null;
    stages.ai_reason = stageDone_(
      stages.ai_reason,
      "ok",
      reasonStarted,
      null,
      reasonResult?.usage || reasonResult?.meta || scoring?._meta || null
    );
  } catch (err) {
    stages.ai_reason = stageDone_(stages.ai_reason, "failed", reasonStarted, err?.message || err);
    throw err;
  }

  let evidence = null;
  if (typeof input.onEvidenceUpsert === "function") {
    const evidenceStarted = nowMs_();
    try {
      const evidenceResult = await input.onEvidenceUpsert({ heuristic, extracted, scoring });
      evidence = evidenceResult?.data ?? evidenceResult ?? null;
      stages.evidence_upsert = stageDone_(stages.evidence_upsert, "ok", evidenceStarted);
    } catch (err) {
      stages.evidence_upsert = stageDone_(stages.evidence_upsert, "failed", evidenceStarted, err?.message || err);
      throw err;
    }
  }

  const finishedAt = nowMs_();
  return {
    ok: true,
    final_status: "COMPLETED",
    short_circuit: false,
    heuristic,
    extracted,
    scoring,
    evidence,
    stages,
    started_at: startedAt,
    finished_at: finishedAt,
    total_latency_ms: Math.max(0, finishedAt - startedAt),
  };
}

export { evaluateScoringHeuristics_ } from "./heuristics.js";

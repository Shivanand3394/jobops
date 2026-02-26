#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "https://get-job.shivanand-shah94.workers.dev";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUT_JSON = "docs/artifacts/release_verify_latest.json";
const DEFAULT_OUT_MD = "docs/artifacts/release_verify_latest.md";
const DEFAULT_SMOKE_OUT = "docs/artifacts/smoke_pack_latest.json";

function asString(value, maxLen = 4000) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toBoolEnv(value, fallback = false) {
  const raw = asString(value, 50).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeErr(err) {
  return asString(err?.message || err || "unknown_error", 2000);
}

const cfg = {
  baseUrl: asString(process.env.BASE_URL || DEFAULT_BASE_URL, 2000).replace(/\/+$/g, ""),
  uiKey: asString(process.env.UI_KEY, 500),
  apiKey: asString(process.env.API_KEY, 500),
  timeoutMs: clampInt(process.env.VERIFY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 120_000),
  outJsonRaw: asString(process.env.RELEASE_VERIFY_OUT_FILE || DEFAULT_OUT_JSON, 2000),
  outMarkdownRaw: asString(process.env.RELEASE_VERIFY_OUT_MD || DEFAULT_OUT_MD, 2000),
  releaseId: asString(process.env.RELEASE_ID, 200),
  pagesUrl: asString(process.env.PAGES_URL, 2000),
  expectedWorkerVersion: asString(process.env.EXPECT_WORKER_VERSION, 120),
  runSmoke: toBoolEnv(process.env.RELEASE_VERIFY_RUN_SMOKE, true),
  requireSmokePass: toBoolEnv(process.env.RELEASE_VERIFY_REQUIRE_SMOKE_PASS, true),
  smokeOutRaw: asString(process.env.SMOKE_OUT_FILE || DEFAULT_SMOKE_OUT, 2000),
  profileId: asString(process.env.PROFILE_ID || "primary", 80),
  allowConnectorSkip: toBoolEnv(process.env.RELEASE_VERIFY_ALLOW_CONNECTOR_SKIP, true),
};

const outJsonPath = resolve(process.cwd(), cfg.outJsonRaw);
const outMdPath = resolve(process.cwd(), cfg.outMarkdownRaw);
const smokeOutPath = resolve(process.cwd(), cfg.smokeOutRaw);

const run = {
  started_at: new Date().toISOString(),
  base_url: cfg.baseUrl,
  release_id: cfg.releaseId || null,
  pages_url: cfg.pagesUrl || null,
  expected_worker_version: cfg.expectedWorkerVersion || null,
  script: "scripts/release_verify.mjs",
  config: {
    timeout_ms: cfg.timeoutMs,
    run_smoke: cfg.runSmoke,
    require_smoke_pass: cfg.requireSmokePass,
    profile_id: cfg.profileId,
    allow_connector_skip: cfg.allowConnectorSkip,
    smoke_out_file: cfg.smokeOutRaw,
  },
  steps: [],
  smoke: null,
  result: "RUNNING",
  summary: null,
  error: null,
};

function recordStep(step) {
  run.steps.push(step);
  const marker = step.ok ? (step.soft ? "WARN" : "PASS") : "FAIL";
  const status = step.http_status === null ? "n/a" : String(step.http_status);
  console.log(`[${marker}] ${step.name} status=${status} duration_ms=${step.duration_ms}`);
}

async function runStep({
  name,
  method,
  path,
  auth = "none",
  body = null,
  expectedStatus = [200],
  validate = null,
}) {
  const started = Date.now();
  const url = `${cfg.baseUrl}${path}`;
  const headers = {};
  if (auth === "ui") headers["x-ui-key"] = cfg.uiKey;
  if (auth === "api") headers["x-api-key"] = cfg.apiKey;
  if (body !== null) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let response = null;
  let text = "";
  let json = null;
  let contentType = "";
  let requestError = "";
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    contentType = asString(response.headers.get("content-type"), 200).toLowerCase();
    text = await response.text();
    json = parseJsonSafe(text);
  } catch (err) {
    requestError = normalizeErr(err);
  } finally {
    clearTimeout(timeout);
  }

  const step = {
    name,
    method,
    path,
    auth,
    expected_status: expectedStatus,
    request_body: body,
    http_status: response ? response.status : null,
    duration_ms: Date.now() - started,
    ok: false,
    soft: false,
    note: null,
    error: null,
    response_content_type: contentType || null,
    response_json: json,
    response_text: json ? null : asString(text, 3000),
  };

  if (requestError) {
    step.error = requestError;
    recordStep(step);
    throw new Error(`${name}: ${requestError}`);
  }

  if (!expectedStatus.includes(response.status)) {
    step.error = `Expected status ${expectedStatus.join(",")} but received ${response.status}`;
    recordStep(step);
    throw new Error(`${name}: ${step.error}`);
  }

  if (typeof validate === "function") {
    const verdict = validate({ status: response.status, json, text, contentType });
    if (verdict === true) {
      step.ok = true;
      recordStep(step);
      return { status: response.status, json, text };
    }
    if (verdict && typeof verdict === "object" && verdict.soft === true) {
      step.ok = true;
      step.soft = true;
      step.note = asString(verdict.note || "soft-validated", 600);
      recordStep(step);
      return { status: response.status, json, text };
    }
    step.error = asString(verdict || "validation_failed", 1000);
    recordStep(step);
    throw new Error(`${name}: ${step.error}`);
  }

  step.ok = true;
  recordStep(step);
  return { status: response.status, json, text };
}

function writeOutputs() {
  run.ended_at = new Date().toISOString();
  const passed = run.steps.filter((s) => s.ok && !s.soft).length;
  const warned = run.steps.filter((s) => s.ok && s.soft).length;
  const failed = run.steps.filter((s) => !s.ok).length;
  run.summary = {
    total_steps: run.steps.length,
    passed_steps: passed,
    warned_steps: warned,
    failed_steps: failed,
    success: run.result === "PASS",
  };

  mkdirSync(dirname(outJsonPath), { recursive: true });
  writeFileSync(outJsonPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(outMdPath, `${renderMarkdown(run)}\n`, "utf8");
  console.log(`Saved release verification JSON: ${outJsonPath}`);
  console.log(`Saved release verification Markdown: ${outMdPath}`);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Release Verification (Latest)");
  lines.push("");
  lines.push(`Generated: ${report.ended_at || new Date().toISOString()}`);
  lines.push("");
  lines.push(`Result: **${report.result}**`);
  if (report.release_id) lines.push(`Release ID: \`${report.release_id}\``);
  if (report.pages_url) lines.push(`Pages URL: ${report.pages_url}`);
  if (report.base_url) lines.push(`Worker Base URL: ${report.base_url}`);
  if (report.expected_worker_version) lines.push(`Expected Worker Version: \`${report.expected_worker_version}\``);
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  lines.push("| Step | Status | HTTP | Note |");
  lines.push("|---|---|---:|---|");
  for (const step of report.steps || []) {
    const status = step.ok ? (step.soft ? "WARN" : "PASS") : "FAIL";
    const note = asString(step.error || step.note || "", 200).replace(/\|/g, "\\|");
    lines.push(`| ${step.name} | ${status} | ${step.http_status ?? "n/a"} | ${note} |`);
  }
  lines.push("");
  if (report.smoke) {
    lines.push("## Smoke Pack");
    lines.push("");
    lines.push(`- Invoked: ${report.smoke.invoked ? "yes" : "no"}`);
    lines.push(`- Exit code: ${report.smoke.exit_code ?? "n/a"}`);
    lines.push(`- Result: ${asString(report.smoke.result || "unknown", 80)}`);
    if (report.smoke.summary) {
      lines.push(`- Steps: ${Number(report.smoke.summary.passed_steps || 0)}/${Number(report.smoke.summary.total_steps || 0)} passed`);
    }
    if (report.smoke.note) lines.push(`- Note: ${asString(report.smoke.note, 300)}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function runSmokePackStep() {
  const started = Date.now();
  const env = {
    ...process.env,
    BASE_URL: cfg.baseUrl,
    UI_KEY: cfg.uiKey,
    API_KEY: cfg.apiKey,
    PROFILE_ID: cfg.profileId,
    SMOKE_OUT_FILE: cfg.smokeOutRaw,
  };
  const proc = spawnSync(process.execPath, [resolve(process.cwd(), "scripts/smoke_pack.mjs")], {
    env,
    encoding: "utf8",
  });

  const smokeInfo = {
    invoked: true,
    duration_ms: Date.now() - started,
    exit_code: Number.isFinite(Number(proc.status)) ? Number(proc.status) : null,
    signal: proc.signal || null,
    stdout_tail: asString(proc.stdout || "", 3000),
    stderr_tail: asString(proc.stderr || "", 3000),
    out_file: cfg.smokeOutRaw,
    result: "UNKNOWN",
    summary: null,
    note: null,
  };

  if (!existsSync(smokeOutPath)) {
    smokeInfo.result = "MISSING_ARTIFACT";
    smokeInfo.note = "Smoke pack did not produce artifact file.";
    run.smoke = smokeInfo;
    if (cfg.requireSmokePass) throw new Error("Smoke pack artifact missing.");
    return;
  }

  const smokeJson = parseJsonSafe(readFileSync(smokeOutPath, "utf8"));
  smokeInfo.result = asString(smokeJson?.result || "UNKNOWN", 80);
  smokeInfo.summary = smokeJson?.summary || null;
  run.smoke = smokeInfo;

  const smokePass = proc.status === 0 && smokeInfo.result === "PASS";
  if (!smokePass && cfg.requireSmokePass) {
    throw new Error(`Smoke pack failed (exit=${proc.status ?? "n/a"}, result=${smokeInfo.result}).`);
  }
}

async function main() {
  const missing = [];
  if (!cfg.uiKey) missing.push("UI_KEY");
  if (!cfg.apiKey) missing.push("API_KEY");
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const health = await runStep({
    name: "release.health",
    method: "GET",
    path: "/health",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const workerVersion = asString(json?.worker_version, 120);
      if (cfg.expectedWorkerVersion && workerVersion !== cfg.expectedWorkerVersion) {
        return `Expected worker_version=${cfg.expectedWorkerVersion}, got ${workerVersion || "EMPTY"}`;
      }
      return true;
    },
  });

  run.detected_worker_version = asString(health?.json?.worker_version, 120) || null;

  await runStep({
    name: "release.jobs.limit1",
    method: "GET",
    path: "/jobs?limit=1&offset=0",
    auth: "ui",
    validate: ({ json }) => (Array.isArray(json?.data) ? true : "Expected data[]"),
  });

  await runStep({
    name: "release.dashboard.triage",
    method: "GET",
    path: "/dashboard/triage?stale_days=3&limit=20&gold_limit=3",
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const pulse = json?.data?.pulse;
      return pulse && typeof pulse === "object" ? true : "Missing pulse data";
    },
  });

  await runStep({
    name: "release.gmail.poll",
    method: "POST",
    path: "/gmail/poll",
    auth: "api",
    body: {},
    expectedStatus: [200, 400],
    validate: ({ status, json, text }) => {
      if (status === 200 && json?.ok === true) return true;
      if (!cfg.allowConnectorSkip) return asString(json?.error || text, 300) || "gmail.poll failed";
      return {
        soft: true,
        note: `Skipped connector strictness: ${asString(json?.error || text, 200) || "gmail poll not ready"}`,
      };
    },
  });

  await runStep({
    name: "release.rss.diagnostics",
    method: "POST",
    path: "/rss/diagnostics",
    auth: "api",
    body: { max_per_run: 10, sample_limit: 5 },
    expectedStatus: [200, 400],
    validate: ({ status, json, text }) => {
      if (status === 200 && json?.ok === true) return true;
      if (!cfg.allowConnectorSkip) return asString(json?.error || text, 300) || "rss.diagnostics failed";
      return {
        soft: true,
        note: `Skipped connector strictness: ${asString(json?.error || text, 200) || "rss diagnostics not ready"}`,
      };
    },
  });

  await runStep({
    name: "release.admin.scoring_runs.report",
    method: "GET",
    path: "/admin/scoring-runs/report?window_days=14&trend_days=14&stage_sample_limit=500",
    auth: "api",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const report = json?.data;
      if (!report || typeof report !== "object") return "Missing report payload";
      if (!report.totals || typeof report.totals !== "object") return "Missing totals block";
      if (!report.funnel || typeof report.funnel !== "object") return "Missing funnel block";
      return true;
    },
  });

  if (cfg.runSmoke) {
    await runSmokePackStep();
  } else {
    run.smoke = {
      invoked: false,
      result: "SKIPPED",
      note: "RELEASE_VERIFY_RUN_SMOKE=0",
    };
  }
}

main()
  .then(() => {
    run.result = "PASS";
    writeOutputs();
  })
  .catch((err) => {
    run.result = "FAIL";
    run.error = normalizeErr(err);
    writeOutputs();
    process.exitCode = 1;
  });

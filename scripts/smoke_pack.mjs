#!/usr/bin/env node
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "https://get-job.shivanand-shah94.workers.dev";
const DEFAULT_OUTPUT_FILE = "docs/artifacts/smoke_pack_latest.json";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_PROFILE_ID = "primary";

function asString(value, maxLen = 4000) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shorten(value, maxLen = 6000) {
  const s = asString(value, maxLen + 10);
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function failValidation(message) {
  return asString(message || "validation failed", 500);
}

const cfg = {
  baseUrl: asString(process.env.BASE_URL || DEFAULT_BASE_URL, 2000).replace(/\/+$/g, ""),
  uiKey: asString(process.env.UI_KEY, 500),
  apiKey: asString(process.env.API_KEY, 500),
  jobKey: asString(process.env.JOB_KEY, 200),
  profileId: asString(process.env.PROFILE_ID || DEFAULT_PROFILE_ID, 80),
  timeoutMs: clampInt(process.env.SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 180_000),
  outFileRaw: asString(process.env.SMOKE_OUT_FILE || DEFAULT_OUTPUT_FILE, 2000),
};

const outFile = resolve(process.cwd(), cfg.outFileRaw);
const runLog = {
  run_id: crypto.randomUUID(),
  started_at: new Date().toISOString(),
  base_url: cfg.baseUrl,
  script: "scripts/smoke_pack.mjs",
  config: {
    timeout_ms: cfg.timeoutMs,
    profile_id: cfg.profileId,
    job_key_input: cfg.jobKey || null,
    output_file: cfg.outFileRaw,
  },
  steps: [],
  result: "RUNNING",
  summary: null,
  error: null,
};

function printStep(step) {
  const marker = step.ok ? "PASS" : "FAIL";
  const status = step.http_status === null ? "n/a" : String(step.http_status);
  console.log(`[${marker}] ${step.name} status=${status} duration_ms=${step.duration_ms}`);
}

function pushStep(step) {
  runLog.steps.push(step);
  printStep(step);
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
  let response;
  let text = "";
  let json = null;
  let failure = "";

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await response.text();
    json = parseJsonSafe(text);
  } catch (err) {
    failure = asString(err?.message || err || "request failed", 2000);
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - started;
  const step = {
    name,
    method,
    path,
    auth,
    request_body: body,
    expected_status: expectedStatus,
    http_status: response ? response.status : null,
    duration_ms: durationMs,
    ok: false,
    error: null,
    response_json: json,
    response_text: json ? null : shorten(text),
  };

  if (failure) {
    step.error = failure;
    pushStep(step);
    throw new Error(`${name}: ${failure}`);
  }

  if (!expectedStatus.includes(response.status)) {
    step.error = failValidation(
      `Expected status ${expectedStatus.join(",")} but received ${response.status}`
    );
    pushStep(step);
    throw new Error(`${name}: ${step.error}`);
  }

  if (typeof validate === "function") {
    const verdict = validate({ status: response.status, json, text });
    if (verdict !== true) {
      step.error = failValidation(verdict);
      pushStep(step);
      throw new Error(`${name}: ${step.error}`);
    }
  }

  step.ok = true;
  pushStep(step);
  return { status: response.status, json, text };
}

function buildReviewPayload(packPayload) {
  const tailoring = (packPayload?.pack_json?.tailoring && typeof packPayload.pack_json.tailoring === "object")
    ? packPayload.pack_json.tailoring
    : {};
  const summaryDefault =
    "I help teams ship measurable outcomes by connecting user insights, execution planning, and delivery follow-through.";
  const coverLetterDefault =
    "Thanks for considering my profile. I am interested in this role and would value a short conversation.";
  const bulletsDefault = [
    "Led cross-functional delivery for high-impact initiatives across product, design, and engineering.",
    "Turned ambiguous business goals into scoped plans with clear milestones and measurable outcomes.",
    "Used data and stakeholder feedback loops to improve execution quality and decision speed.",
  ];

  const summary = asString(tailoring.summary || summaryDefault, 1800);
  const coverLetter = asString(tailoring.cover_letter || coverLetterDefault, 2500);
  let bullets = Array.isArray(tailoring.bullets)
    ? tailoring.bullets.map((x) => asString(x, 500)).filter(Boolean)
    : [];
  if (!bullets.length) bullets = bulletsDefault;

  return {
    summary,
    cover_letter: coverLetter,
    bullets: bullets.slice(0, 8),
  };
}

async function main() {
  const missing = [];
  if (!cfg.uiKey) missing.push("UI_KEY");
  if (!cfg.apiKey) missing.push("API_KEY");
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const health = await runStep({
    name: "health",
    method: "GET",
    path: "/health",
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  const jobs = await runStep({
    name: "jobs.list.limit1",
    method: "GET",
    path: "/jobs?limit=1&offset=0",
    auth: "ui",
    validate: ({ json }) => (Array.isArray(json?.data) ? true : "Expected data[] array"),
  });

  const selectedJobKey = cfg.jobKey || asString(jobs?.json?.data?.[0]?.job_key, 200);
  if (!selectedJobKey) {
    throw new Error("No job_key available. Set JOB_KEY or ingest at least one job before running the wizard smoke path.");
  }
  runLog.config.job_key_resolved = selectedJobKey;

  await runStep({
    name: "gmail.poll",
    method: "POST",
    path: "/gmail/poll",
    auth: "api",
    body: {},
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  await runStep({
    name: "rss.diagnostics",
    method: "POST",
    path: "/rss/diagnostics",
    auth: "api",
    body: { max_per_run: 10, sample_limit: 5 },
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  await runStep({
    name: "wizard.profile.upsert",
    method: "POST",
    path: "/resume/profiles",
    auth: "ui",
    body: {
      id: cfg.profileId,
      name: "Smoke Profile",
      profile_json: {
        basics: { name: "Smoke User" },
        summary: "Execution-focused operator with product and delivery ownership experience.",
        experience: [],
        skills: [],
      },
    },
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  const encodedJobKey = encodeURIComponent(selectedJobKey);
  await runStep({
    name: "wizard.generate",
    method: "POST",
    path: `/jobs/${encodedJobKey}/generate-application-pack`,
    auth: "ui",
    body: {
      profile_id: cfg.profileId,
      force: false,
      renderer: "reactive_resume",
      evidence_first: true,
      evidence_limit: 8,
    },
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      return asString(json?.data?.draft_id).length > 0 ? true : "Missing draft_id";
    },
  });

  const packBefore = await runStep({
    name: "wizard.pack.fetch.before",
    method: "GET",
    path: `/jobs/${encodedJobKey}/application-pack?profile_id=${encodeURIComponent(cfg.profileId)}`,
    auth: "ui",
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  const reviewPayload = buildReviewPayload(packBefore?.json?.data || {});

  await runStep({
    name: "wizard.review",
    method: "POST",
    path: `/jobs/${encodedJobKey}/application-pack/review`,
    auth: "ui",
    body: {
      profile_id: cfg.profileId,
      summary: reviewPayload.summary,
      bullets: reviewPayload.bullets,
      cover_letter: reviewPayload.cover_letter,
    },
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  await runStep({
    name: "wizard.approve",
    method: "POST",
    path: `/jobs/${encodedJobKey}/approve-pack`,
    auth: "ui",
    body: {
      profile_id: cfg.profileId,
      summary: reviewPayload.summary,
      bullets: reviewPayload.bullets,
      cover_letter: reviewPayload.cover_letter,
    },
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const status = asString(json?.data?.status, 100).toUpperCase();
      return status === "READY_TO_APPLY"
        ? true
        : `Expected READY_TO_APPLY from approve-pack, got "${status || "EMPTY"}"`;
    },
  });

  await runStep({
    name: "wizard.pack.fetch.after",
    method: "GET",
    path: `/jobs/${encodedJobKey}/application-pack?profile_id=${encodeURIComponent(cfg.profileId)}`,
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const status = asString(json?.data?.status, 100).toUpperCase();
      return status === "READY_TO_APPLY"
        ? true
        : `Expected READY_TO_APPLY in final pack, got "${status || "EMPTY"}"`;
    },
  });

  if (health?.json?.ok !== true) {
    throw new Error("Health endpoint returned unexpected payload.");
  }
}

function finalize(result, err) {
  const passed = runLog.steps.filter((x) => x.ok).length;
  const failed = runLog.steps.length - passed;
  runLog.result = result;
  runLog.error = err ? asString(err?.message || err, 4000) : null;
  runLog.ended_at = new Date().toISOString();
  runLog.summary = {
    total_steps: runLog.steps.length,
    passed_steps: passed,
    failed_steps: failed,
    success: result === "PASS",
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(runLog, null, 2)}\n`, "utf8");
  console.log(`Saved smoke pack report: ${outFile}`);
}

main()
  .then(() => {
    finalize("PASS", null);
  })
  .catch((err) => {
    finalize("FAIL", err);
    process.exitCode = 1;
  });

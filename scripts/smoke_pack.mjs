#!/usr/bin/env node
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "https://get-job.shivanand-shah94.workers.dev";
const DEFAULT_OUTPUT_FILE = "docs/artifacts/smoke_pack_latest.json";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_PROFILE_ID = "primary";
const DEFAULT_WHATSAPP_WEBHOOK_PATH = "/ingest/whatsapp/vonage";
const SMOKE_MANUAL_JD_FALLBACK = `
Business Program Manager - Platform Operations
Company: Smoke Systems
Location: Remote

We are hiring a Business Program Manager to lead cross-functional delivery, KPI tracking, and stakeholder communication across product, operations, and engineering teams.

Must have:
- Program management experience owning delivery plans and roadmap milestones.
- Cross-functional collaboration with product, engineering, design, and operations.
- Strong SQL skills for reporting and analytics.
- KPI tracking and executive-ready status communication.
- Stakeholder management across multiple workstreams.

Nice to have:
- Process optimization and workflow automation.
- Experience with business strategy and operational planning.

The role requires clear written communication, execution ownership, and measurable outcomes.
`;

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

function normalizeWhitespace(value) {
  return asString(value, 20_000).replace(/\s+/g, " ").trim();
}

function toBoolEnv(value, fallback = false) {
  const raw = asString(value, 50).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

const cfg = {
  baseUrl: asString(process.env.BASE_URL || DEFAULT_BASE_URL, 2000).replace(/\/+$/g, ""),
  uiKey: asString(process.env.UI_KEY, 500),
  apiKey: asString(process.env.API_KEY, 500),
  jobKey: asString(process.env.JOB_KEY, 200),
  profileId: asString(process.env.PROFILE_ID || DEFAULT_PROFILE_ID, 80),
  requireOutreach: toBoolEnv(process.env.SMOKE_REQUIRE_OUTREACH, false),
  timeoutMs: clampInt(process.env.SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 180_000),
  outFileRaw: asString(process.env.SMOKE_OUT_FILE || DEFAULT_OUTPUT_FILE, 2000),
  whatsappWebhookPath: asString(process.env.WHATSAPP_WEBHOOK_PATH || DEFAULT_WHATSAPP_WEBHOOK_PATH, 300) || DEFAULT_WHATSAPP_WEBHOOK_PATH,
  whatsappWebhookKey: asString(process.env.WHATSAPP_VONAGE_KEY || process.env.WHATSAPP_WEBHOOK_KEY, 500),
  whatsappSignatureSecret: asString(process.env.WHATSAPP_VONAGE_SIGNATURE_SECRET, 1000),
  whatsappJwt: asString(process.env.WHATSAPP_VONAGE_JWT, 8000),
  whatsappSender: asString(process.env.WHATSAPP_TEST_SENDER || "+14155550100", 120),
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
    require_outreach: cfg.requireOutreach,
    whatsapp_sim_enabled: Boolean(cfg.whatsappWebhookKey),
    whatsapp_webhook_path: cfg.whatsappWebhookPath,
  },
  steps: [],
  result: "RUNNING",
  summary: null,
  error: null,
};

const secondaryProfileId = `${cfg.profileId}-alt`.slice(0, 80) || "primary-alt";

function printStep(step) {
  const marker = step.ok ? "PASS" : "FAIL";
  const status = step.http_status === null ? "n/a" : String(step.http_status);
  console.log(`[${marker}] ${step.name} status=${status} duration_ms=${step.duration_ms}`);
}

function pushStep(step) {
  runLog.steps.push(step);
  printStep(step);
}

function pushSkippedStep(name, reason) {
  pushStep({
    name,
    method: "SKIP",
    path: "-",
    auth: "none",
    request_body: null,
    expected_status: [],
    http_status: null,
    duration_ms: 0,
    ok: true,
    error: null,
    response_json: { skipped: true, reason: asString(reason || "Skipped", 500) },
    response_text: null,
  });
}

function isExpectedWebhookAuthFailure_(status, json, text) {
  if (status === 401) {
    const err = asString(json?.error || text, 500).toLowerCase();
    if (err.includes("authorization bearer token")) return true;
    if (err.includes("invalid vonage signature token")) return true;
    return false;
  }
  if (status === 403) {
    const err = asString(json?.error || text, 500).toLowerCase();
    return err.includes("forbidden sender");
  }
  return false;
}

function toBase64Url(input) {
  const s = Buffer.from(String(input ?? ""), "utf8").toString("base64");
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildVonageHs256Jwt(secret, rawBody) {
  const now = Math.floor(Date.now() / 1000);
  const safeSecret = asString(secret, 2000);
  if (!safeSecret) return "";
  const payloadHash = crypto.createHash("sha256").update(String(rawBody || ""), "utf8").digest("hex");
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "jobops-smoke-pack",
    sub: "whatsapp-vonage-sim",
    iat: now,
    exp: now + 300,
    payload_hash: payloadHash,
  };
  const headerPart = toBase64Url(JSON.stringify(header));
  const payloadPart = toBase64Url(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const sig = crypto
    .createHmac("sha256", safeSecret)
    .update(signingInput, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${signingInput}.${sig}`;
}

async function runStep({
  name,
  method,
  path,
  auth = "none",
  body = null,
  extraHeaders = null,
  expectedStatus = [200],
  validate = null,
}) {
  const started = Date.now();
  const url = `${cfg.baseUrl}${path}`;
  const headers = {};

  if (auth === "ui") headers["x-ui-key"] = cfg.uiKey;
  if (auth === "api") headers["x-api-key"] = cfg.apiKey;
  if (body !== null) headers["content-type"] = "application/json";
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [k, v] of Object.entries(extraHeaders)) {
      const key = asString(k, 200);
      const value = asString(v, 8000);
      if (!key || !value) continue;
      headers[key] = value;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let response;
  let text = "";
  let json = null;
  let contentType = "";
  let failure = "";

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    contentType = asString(response.headers.get("content-type"), 400).toLowerCase();
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
    response_content_type: contentType || null,
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
    const verdict = validate({ status: response.status, json, text, contentType });
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

  const summarySeed = asString(tailoring.summary || summaryDefault, 1500);
  const summary = asString(
    `${summarySeed} Focus areas: program management, cross-functional delivery, SQL, KPI tracking, stakeholder management.`,
    1800
  );
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

  if (!cfg.whatsappWebhookKey) {
    const reason = "Set WHATSAPP_VONAGE_KEY (or WHATSAPP_WEBHOOK_KEY) to enable this step.";
    pushSkippedStep("whatsapp.vonage.sim", reason);
    pushSkippedStep("whatsapp.vonage.media.sim", reason);
  } else {
    const webhookPath = `${cfg.whatsappWebhookPath}?key=${encodeURIComponent(cfg.whatsappWebhookKey)}`;

    const webhookBody = {
      from: cfg.whatsappSender,
      text: `Smoke test lead ${cfg.baseUrl}/health`,
      message_uuid: `smoke-wa-${Date.now()}`,
    };
    const webhookRaw = JSON.stringify(webhookBody);
    const signedJwt = cfg.whatsappJwt || buildVonageHs256Jwt(cfg.whatsappSignatureSecret, webhookRaw);
    const webhookStep = await runStep({
      name: "whatsapp.vonage.sim",
      method: "POST",
      path: webhookPath,
      auth: "none",
      body: webhookBody,
      extraHeaders: signedJwt ? { authorization: `Bearer ${signedJwt}` } : null,
      expectedStatus: [200, 401, 403],
      validate: ({ status, json, text }) => {
        if (status === 200) {
          if (json?.ok !== true) return "Expected { ok: true }";
          const provider = asString(json?.data?.provider, 40).toLowerCase();
          return provider === "vonage"
            ? true
            : `Expected provider=vonage, got "${provider || "EMPTY"}"`;
        }
        if (isExpectedWebhookAuthFailure_(status, json, text)) return true;
        return `Unexpected webhook auth failure (${status}): ${asString(json?.error || text, 200)}`;
      },
    });
    runLog.config.whatsapp_sim_http_status = webhookStep.status;

    const mediaBody = {
      from: cfg.whatsappSender,
      message_uuid: `smoke-wa-media-${Date.now()}`,
      message_type: "document",
      file: {
        url: "https://example.com/mock-jd.pdf",
        mime_type: "application/pdf",
        name: "mock-jd.pdf",
        caption: "Attached job description document for smoke validation",
      },
    };
    const mediaRaw = JSON.stringify(mediaBody);
    const mediaJwt = cfg.whatsappJwt || buildVonageHs256Jwt(cfg.whatsappSignatureSecret, mediaRaw);
    const mediaStep = await runStep({
      name: "whatsapp.vonage.media.sim",
      method: "POST",
      path: webhookPath,
      auth: "none",
      body: mediaBody,
      extraHeaders: mediaJwt ? { authorization: `Bearer ${mediaJwt}` } : null,
      expectedStatus: [200, 401, 403],
      validate: ({ status, json, text }) => {
        if (status === 200) {
          if (json?.ok !== true) return "Expected { ok: true }";
          const provider = asString(json?.data?.provider, 40).toLowerCase();
          if (provider !== "vonage") return `Expected provider=vonage, got "${provider || "EMPTY"}"`;
          if (json?.data?.media_detected !== true) return "Expected media_detected=true";
          if (json?.data?.media_queued_for_extraction !== true) return "Expected media_queued_for_extraction=true";
          const mediaType = asString(json?.data?.media?.type, 40).toLowerCase();
          if (mediaType && mediaType !== "document") return `Expected media.type=document, got "${mediaType}"`;
          const extractionStatus = asString(json?.data?.extraction?.status, 80).toLowerCase();
          if (!["queued", "queued_unconfigured"].includes(extractionStatus)) {
            return `Unexpected extraction.status "${extractionStatus || "EMPTY"}"`;
          }
          return true;
        }
        if (isExpectedWebhookAuthFailure_(status, json, text)) return true;
        return `Unexpected webhook auth failure (${status}): ${asString(json?.error || text, 200)}`;
      },
    });
    runLog.config.whatsapp_media_sim_http_status = mediaStep.status;
  }

  const jobs = await runStep({
    name: "jobs.list.limit1",
    method: "GET",
    path: "/jobs?limit=1&offset=0",
    auth: "ui",
    validate: ({ json }) => (Array.isArray(json?.data) ? true : "Expected data[] array"),
  });

  await runStep({
    name: "dashboard.triage",
    method: "GET",
    path: "/dashboard/triage?stale_days=3&limit=20&gold_limit=3",
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const all = Array.isArray(json?.data?.queues?.all) ? json.data.queues.all : null;
      const pulse = (json?.data?.pulse && typeof json.data.pulse === "object") ? json.data.pulse : null;
      if (!all) return "Expected queues.all array";
      if (!pulse) return "Expected pulse object";
      return true;
    },
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

  const scoringReport = await runStep({
    name: "admin.scoring_runs.report",
    method: "GET",
    path: "/admin/scoring-runs/report?window_days=14&trend_days=14&stage_sample_limit=500",
    auth: "api",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const report = (json?.data && typeof json.data === "object") ? json.data : null;
      if (!report) return "Missing report payload.";
      const funnel = (report.funnel && typeof report.funnel === "object") ? report.funnel : null;
      if (!funnel) return "Missing funnel block in scoring report.";
      const media = (funnel.whatsapp_media_funnel && typeof funnel.whatsapp_media_funnel === "object")
        ? funnel.whatsapp_media_funnel
        : null;
      if (!media) return "Missing funnel.whatsapp_media_funnel block.";
      const events = (media.events && typeof media.events === "object") ? media.events : null;
      const jobs = (media.jobs && typeof media.jobs === "object") ? media.jobs : null;
      const conversion = (media.conversion && typeof media.conversion === "object") ? media.conversion : null;
      if (!events) return "Missing whatsapp_media_funnel.events object.";
      if (!jobs) return "Missing whatsapp_media_funnel.jobs object.";
      if (!conversion) return "Missing whatsapp_media_funnel.conversion object.";
      const expectedEventKeys = ["queued", "extract_ingested", "extract_empty", "extract_failed", "missing_url"];
      for (const k of expectedEventKeys) {
        if (!Number.isFinite(Number(events[k]))) return `whatsapp_media_funnel.events.${k} must be numeric`;
      }
      const expectedJobKeys = ["media_jobs_total", "link_only_jobs", "scored_jobs", "ready_to_apply_jobs"];
      for (const k of expectedJobKeys) {
        if (!Number.isFinite(Number(jobs[k]))) return `whatsapp_media_funnel.jobs.${k} must be numeric`;
      }
      const expectedConversionKeys = ["media_jobs_scored_percent", "media_jobs_ready_to_apply_percent"];
      for (const k of expectedConversionKeys) {
        if (!Number.isFinite(Number(conversion[k]))) return `whatsapp_media_funnel.conversion.${k} must be numeric`;
      }
      return true;
    },
  });
  const mediaFunnel = scoringReport?.json?.data?.funnel?.whatsapp_media_funnel || {};
  runLog.config.whatsapp_media_funnel_snapshot = {
    source_filter: mediaFunnel?.source_filter || null,
    filtered_out_by_source: Boolean(mediaFunnel?.filtered_out_by_source),
    events: mediaFunnel?.events || {},
    jobs: mediaFunnel?.jobs || {},
    conversion: mediaFunnel?.conversion || {},
  };

  await runStep({
    name: "wizard.profile.upsert",
    method: "POST",
    path: "/resume/profiles",
    auth: "ui",
    body: {
      id: cfg.profileId,
      name: "Smoke Profile",
      profile_json: {
        basics: { name: "Smoke User", email: "smoke.user@example.com", location: "Remote" },
        summary: "Execution-focused operator with product and delivery ownership experience across cross-functional programs.",
        experience: [
          {
            company: "Smoke Co",
            role: "Program Manager",
            date_range: "2022 - Present",
            bullets: [
              "Led cross-functional delivery programs with KPI tracking and stakeholder alignment.",
              "Built SQL-backed reporting loops to improve execution visibility and decision quality.",
            ],
          },
        ],
        skills: ["Program Management", "Cross-functional Collaboration", "SQL", "KPI Tracking", "Operations"],
      },
    },
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  await runStep({
    name: "wizard.profile.upsert.alt",
    method: "POST",
    path: "/resume/profiles",
    auth: "ui",
    body: {
      id: secondaryProfileId,
      name: "Smoke Profile Alt",
      profile_json: {
        basics: { name: "Smoke User Alt", email: "smoke.user.alt@example.com", location: "Remote" },
        summary: "Alternate profile for per-job preference verification.",
        experience: [
          {
            company: "Alt Smoke Co",
            role: "Business Program Manager",
            date_range: "2021 - Present",
            bullets: [
              "Owned roadmap execution for program increments spanning product, ops, and engineering teams.",
              "Established SLA and weekly KPI review cadence to improve delivery consistency.",
            ],
          },
        ],
        skills: ["Business Program Management", "Roadmap", "Delivery", "KPI", "Stakeholder Management"],
      },
    },
    validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
  });

  const encodedJobKey = encodeURIComponent(selectedJobKey);
  await runStep({
    name: "wizard.profile.preference.set",
    method: "POST",
    path: `/jobs/${encodedJobKey}/profile-preference`,
    auth: "ui",
    body: {
      profile_id: secondaryProfileId,
    },
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const saved = asString(json?.data?.profile_id, 120);
      const effective = asString(json?.data?.effective_profile_id, 120);
      if (saved !== secondaryProfileId) return `Expected saved profile_id "${secondaryProfileId}", got "${saved || "EMPTY"}"`;
      return effective === secondaryProfileId
        ? true
        : `Expected effective profile "${secondaryProfileId}", got "${effective || "EMPTY"}"`;
    },
  });

  const prefRead = await runStep({
    name: "wizard.profile.preference.get",
    method: "GET",
    path: `/jobs/${encodedJobKey}/profile-preference`,
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const effective = asString(json?.data?.effective_profile_id, 120);
      return effective === secondaryProfileId
        ? true
        : `Expected effective profile "${secondaryProfileId}", got "${effective || "EMPTY"}"`;
    },
  });
  const effectiveProfileId = asString(prefRead?.json?.data?.effective_profile_id || secondaryProfileId, 120);
  runLog.config.profile_id_effective = effectiveProfileId;

  await runStep({
    name: "wizard.generate",
    method: "POST",
    path: `/jobs/${encodedJobKey}/generate-application-pack`,
    auth: "ui",
    body: {
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
    path: `/jobs/${encodedJobKey}/application-pack`,
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const profileId = asString(json?.data?.profile_id, 120);
      return profileId === effectiveProfileId
        ? true
        : `Expected pack profile_id "${effectiveProfileId}", got "${profileId || "EMPTY"}"`;
    },
  });

  const reviewPayload = buildReviewPayload(packBefore?.json?.data || {});

  await runStep({
    name: "wizard.review",
    method: "POST",
    path: `/jobs/${encodedJobKey}/application-pack/review`,
    auth: "ui",
    body: {
      profile_id: effectiveProfileId,
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
      profile_id: effectiveProfileId,
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
    path: `/jobs/${encodedJobKey}/application-pack`,
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const status = asString(json?.data?.status, 100).toUpperCase();
      if (status !== "READY_TO_APPLY") {
        return `Expected READY_TO_APPLY in final pack, got "${status || "EMPTY"}"`;
      }
      const profileId = asString(json?.data?.profile_id, 120);
      return profileId === effectiveProfileId
        ? true
        : `Expected final pack profile_id "${effectiveProfileId}", got "${profileId || "EMPTY"}"`;
    },
  });

  const evidenceRebuildInitial = await runStep({
    name: "wizard.evidence.rebuild",
    method: "POST",
    path: `/jobs/${encodedJobKey}/evidence/rebuild`,
    auth: "ui",
    expectedStatus: [200, 400],
    validate: ({ json }) => {
      if (json?.ok !== true) {
        const err = asString(json?.error, 300).toLowerCase();
        if (err.includes("no extracted requirements available")) return true;
        return "Expected { ok: true }";
      }
      const count = Number(json?.data?.requirement_count || 0);
      return count > 0
        ? true
        : "Expected requirement_count > 0 after evidence rebuild.";
    },
  });
  if (evidenceRebuildInitial.status === 400) {
    await runStep({
      name: "wizard.rescore.for.evidence",
      method: "POST",
      path: `/jobs/${encodedJobKey}/rescore`,
      auth: "ui",
      body: {},
      validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
    });

    const evidenceRebuildAfterRescore = await runStep({
      name: "wizard.evidence.rebuild.after_rescore",
      method: "POST",
      path: `/jobs/${encodedJobKey}/evidence/rebuild`,
      auth: "ui",
      expectedStatus: [200, 400],
      validate: ({ json }) => {
        if (json?.ok !== true) {
          const err = asString(json?.error, 300).toLowerCase();
          if (err.includes("no extracted requirements available")) return true;
          return "Expected { ok: true }";
        }
        const count = Number(json?.data?.requirement_count || 0);
        return count > 0
          ? true
          : "Expected requirement_count > 0 after rescore rebuild.";
      },
    });

    if (evidenceRebuildAfterRescore.status === 400) {
      await runStep({
        name: "wizard.manual_jd.seed",
        method: "POST",
        path: `/jobs/${encodedJobKey}/manual-jd`,
        auth: "ui",
        body: {
          jd_text_clean: SMOKE_MANUAL_JD_FALLBACK,
        },
        validate: ({ json }) => (json?.ok === true ? true : "Expected { ok: true }"),
      });

      await runStep({
        name: "wizard.evidence.rebuild.after_manual_jd",
        method: "POST",
        path: `/jobs/${encodedJobKey}/evidence/rebuild`,
        auth: "ui",
        validate: ({ json }) => {
          if (json?.ok !== true) return "Expected { ok: true }";
          const count = Number(json?.data?.requirement_count || 0);
          return count > 0
            ? true
            : "Expected requirement_count > 0 after manual-jd rebuild.";
        },
      });
    }
  }

  let matchedEvidenceNeedle = "";
  const evidenceStep = await runStep({
    name: "wizard.evidence.fetch",
    method: "GET",
    path: `/jobs/${encodedJobKey}/evidence?limit=60`,
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      const rows = Array.isArray(json?.data) ? json.data : [];
      if (!rows.length) return "Expected evidence rows for selected job.";
      const matched = rows.filter((row) => row?.matched === true || Number(row?.matched) === 1);
      if (!matched.length) return "Expected at least one matched evidence row.";
      const rawNeedle = normalizeWhitespace(
        matched
          .map((row) => asString(row?.evidence_text || row?.requirement_text, 300))
          .find(Boolean)
      );
      const needle = rawNeedle.toLowerCase().split(" ").filter(Boolean).slice(0, 8).join(" ");
      if (needle.length < 12) return "Matched evidence text too short for resume verification.";
      matchedEvidenceNeedle = needle;
      return true;
    },
  });
  runLog.config.resume_html_evidence_rows = Array.isArray(evidenceStep?.json?.data) ? evidenceStep.json.data.length : 0;
  runLog.config.resume_html_evidence_needle = matchedEvidenceNeedle || null;
  const expectedResumeEmail = effectiveProfileId === secondaryProfileId
    ? "smoke.user.alt@example.com"
    : "smoke.user@example.com";
  runLog.config.resume_html_expected_email = expectedResumeEmail;

  await runStep({
    name: "wizard.resume.html",
    method: "GET",
    path: `/jobs/${encodedJobKey}/resume/html?profile_id=${encodeURIComponent(effectiveProfileId)}&evidence_limit=12`,
    auth: "ui",
    validate: ({ text, contentType }) => {
      const ct = asString(contentType, 200).toLowerCase();
      if (!ct.includes("text/html")) return `Expected content-type text/html, got "${ct || "EMPTY"}"`;
      const rawHtml = asString(text, 200_000);
      if (rawHtml.length < 1800) return `Resume HTML unexpectedly short (${rawHtml.length} chars).`;
      const html = normalizeWhitespace(rawHtml).toLowerCase();
      if (!html.includes("<html")) return "Expected HTML document response.";
      if (!/summary/i.test(rawHtml)) return "Missing 'Summary' section in resume HTML.";
      if (!/experience/i.test(rawHtml)) return "Missing 'Experience' section in resume HTML.";
      if (!/generated by jobops html_simple renderer\./i.test(rawHtml)) {
        return "Missing html_simple renderer provenance marker.";
      }
      if (!/print-color-adjust\s*:\s*exact/i.test(rawHtml)) {
        return "Missing print color-adjust CSS guardrail.";
      }
      if (!/@media\s+print/i.test(rawHtml)) return "Missing @media print CSS block.";
      if (/<script\b/i.test(rawHtml)) return "Resume HTML should be zero-dependency (no script tags).";
      if (!html.includes(expectedResumeEmail.toLowerCase())) {
        return `Expected profile email "${expectedResumeEmail}" in resume HTML.`;
      }
      if (!/targeted impact/i.test(text)) return "Missing 'Targeted Impact' section in resume HTML.";
      if (!matchedEvidenceNeedle) return "Missing matched evidence verification needle.";
      if (!html.includes(matchedEvidenceNeedle)) {
        return `Expected matched evidence snippet in resume HTML: "${matchedEvidenceNeedle}"`;
      }
      return true;
    },
  });

  const outreachContacts = await runStep({
    name: "outreach.contacts.list",
    method: "GET",
    path: `/jobs/${encodedJobKey}/contacts`,
    auth: "ui",
    validate: ({ json }) => {
      if (json?.ok !== true) return "Expected { ok: true }";
      return Array.isArray(json?.data)
        ? true
        : "Expected contacts data[] array";
    },
  });

  const outreachList = Array.isArray(outreachContacts?.json?.data) ? outreachContacts.json.data : [];
  const outreachContactId = asString(outreachList?.[0]?.id, 200);
  if (!outreachContactId) {
    const msg = "Outreach contacts list is empty for selected JOB_KEY.";
    runLog.config.outreach_contact_id = null;
    runLog.config.outreach_skipped = true;
    if (cfg.requireOutreach) {
      throw new Error(`${msg} Set JOB_KEY to a contact-backed job or SMOKE_REQUIRE_OUTREACH=0.`);
    }
    pushSkippedStep("outreach.draft.linkedin", `${msg} Skipped (SMOKE_REQUIRE_OUTREACH=0).`);
    pushSkippedStep("outreach.status.sent", `${msg} Skipped (SMOKE_REQUIRE_OUTREACH=0).`);
    pushSkippedStep("outreach.status.replied", `${msg} Skipped (SMOKE_REQUIRE_OUTREACH=0).`);
    pushSkippedStep("outreach.contacts.verify.replied", `${msg} Skipped (SMOKE_REQUIRE_OUTREACH=0).`);
  } else {
    runLog.config.outreach_contact_id = outreachContactId;

    const outreachLinkedin = await runStep({
      name: "outreach.draft.linkedin",
      method: "POST",
      path: `/jobs/${encodedJobKey}/contacts/${encodeURIComponent(outreachContactId)}/draft`,
      auth: "ui",
      body: {
        profile_id: effectiveProfileId,
        channel: "LINKEDIN",
        use_ai: true,
      },
      validate: ({ json }) => {
        if (json?.ok !== true) return "Expected { ok: true }";
        const draft = asString(json?.data?.draft, 6000);
        const len = draft.length;
        if (len < 180) return `LinkedIn draft too short (${len}).`;
        if (len > 900) return `LinkedIn draft too long (${len}).`;
        const tpStatus = asString(json?.data?.touchpoint?.status, 50).toUpperCase();
        if (tpStatus !== "DRAFT") return `Expected touchpoint status DRAFT, got "${tpStatus || "EMPTY"}"`;
        const tpChannel = asString(json?.data?.touchpoint?.channel, 50).toUpperCase();
        if (tpChannel !== "LINKEDIN") return `Expected touchpoint channel LINKEDIN, got "${tpChannel || "EMPTY"}"`;
        return true;
      },
    });
    runLog.config.outreach_linkedin_draft_len = asString(outreachLinkedin?.json?.data?.draft, 6000).length;

    await runStep({
      name: "outreach.status.sent",
      method: "POST",
      path: `/jobs/${encodedJobKey}/contacts/${encodeURIComponent(outreachContactId)}/touchpoint-status`,
      auth: "ui",
      body: {
        channel: "LINKEDIN",
        status: "SENT",
      },
      validate: ({ json }) => {
        if (json?.ok !== true) return "Expected { ok: true }";
        const status = asString(json?.data?.status, 50).toUpperCase();
        return status === "SENT"
          ? true
          : `Expected SENT from touchpoint-status, got "${status || "EMPTY"}"`;
      },
    });

    await runStep({
      name: "outreach.status.replied",
      method: "POST",
      path: `/jobs/${encodedJobKey}/contacts/${encodeURIComponent(outreachContactId)}/touchpoint-status`,
      auth: "ui",
      body: {
        channel: "LINKEDIN",
        status: "REPLIED",
      },
      validate: ({ json }) => {
        if (json?.ok !== true) return "Expected { ok: true }";
        const status = asString(json?.data?.status, 50).toUpperCase();
        return status === "REPLIED"
          ? true
          : `Expected REPLIED from touchpoint-status, got "${status || "EMPTY"}"`;
      },
    });

    await runStep({
      name: "outreach.contacts.verify.replied",
      method: "GET",
      path: `/jobs/${encodedJobKey}/contacts`,
      auth: "ui",
      validate: ({ json }) => {
        if (json?.ok !== true) return "Expected { ok: true }";
        const list = Array.isArray(json?.data) ? json.data : [];
        const row = list.find((x) => asString(x?.id, 200) === outreachContactId);
        if (!row) return "Selected contact missing from contacts list.";
        const statuses = (row?.channel_statuses && typeof row.channel_statuses === "object")
          ? row.channel_statuses
          : {};
        const linkedInStatus = asString(statuses?.LINKEDIN || row?.status, 50).toUpperCase();
        return linkedInStatus === "REPLIED"
          ? true
          : `Expected LinkedIn status REPLIED, got "${linkedInStatus || "EMPTY"}"`;
      },
    });
  }

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

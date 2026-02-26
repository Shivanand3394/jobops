// worker_jobops_v2_ui_plus_clean.js
import { buildGmailAuthUrl_, handleGmailOAuthCallback_, pollGmailAndIngest_ } from "./gmail.js";
import {
  RR_EXPORT_CONTRACT_ID,
  RR_EXPORT_SCHEMA_VERSION,
  ensurePrimaryProfile_,
  ensureReactiveResumeExportContract_,
  generateApplicationPack_,
  persistResumeDraft_,
} from "./resume_pack.js";
import { diagnoseRssFeedsAndIngest_, pollRssFeedsAndIngest_ } from "./rss.js";
import {
  processIngest as processDomainIngest_,
  sourceHealthCheck as checkIngestSourceHealth_,
} from "./domains/ingest/index.js";
import {
  runScoringPipeline_ as runDomainScoringPipeline_,
} from "./domains/scoring/index.js";
import {
  draftOutreachMessage_,
  hasContactsStorage_,
  normalizeOutreachChannel_,
  upsertPotentialContactsForJob_,
} from "./domains/contacts/index.js";
import { generateProfessionalHtml } from "./domains/resume/index.js";

// JobOps V2 â€” consolidated Worker (Option D + UI Plus)
// Features:
// - D1-backed Jobs + Targets + Events
// - URL normalization + JD resolution (fetch + email fallback)
// - AI extraction + scoring (Workers AI)
// - Batch scoring (/score-pending)
// - Single job rescore (/jobs/:job_key/rescore)
// - Android-friendly UI endpoints (/jobs, /targets, checklist, resume-payload)
//
// Auth model:
// - Public: GET /health
// - UI: x-ui-key header must match env.UI_KEY for UI endpoints
// - Admin/API: x-api-key header must match env.API_KEY for admin+AI endpoints
//
// Required env:
// - UI_KEY (secret) for UI endpoints
// - API_KEY (secret) for admin/API endpoints
// - DB (D1 binding)
// - AI binding named AI (or set AI_BINDING to your binding name)
// Optional env:
// - ALLOW_ORIGIN = "*" OR exact origin like "https://getjobs....workers.dev"

const SYNONYM_MAP = Object.freeze({
  // --- LEADERSHIP & STRATEGY ---
  Leadership: Object.freeze([
    "managed", "led", "mentored", "supervising", "directed",
    "steered", "spearheaded", "orchestrated", "head of", "people management",
  ]),
  "Business Strategy": Object.freeze([
    "strategic planning", "roadmap", "go-to-market", "gtm",
    "growth strategy", "market positioning", "p&l management", "business development",
  ]),
  "Cross-functional Collaboration": Object.freeze([
    "partnered with", "stakeholder management", "aligned",
    "bridged", "inter-departmental", "matrix organization", "collaborated",
  ]),

  // --- PRODUCT & OPERATIONS ---
  "Project Management": Object.freeze([
    "agile", "scrum", "sdlc", "waterfall", "kanban",
    "delivery", "milestones", "resource allocation", "sprint planning",
  ]),
  "Process Optimization": Object.freeze([
    "streamlined", "six sigma", "lean", "efficiency",
    "workflow automation", "operational excellence", "standardization",
  ]),

  // --- TECHNICAL CLUSTERS (2026 Meta) ---
  "AI Integration": Object.freeze([
    "llm", "gpt", "claude", "prompt engineering", "retrieval-augmented generation",
    "rag", "model fine-tuning", "vector database",
  ]),
  "Cloud Infrastructure": Object.freeze([
    "aws", "azure", "gcp", "serverless", "kubernetes",
    "docker", "terraform", "iac", "microservices",
  ]),
  "Data Analysis": Object.freeze([
    "sql", "tableau", "power bi", "forecasting",
    "kpi tracking", "data-driven insights", "predictive modeling",
  ]),
});

export default {
  async fetch(request, env, ctx) {
    // Always handle CORS preflight first
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders_(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // ----------------------------
      // Public route
      // ----------------------------
      if (path === "/health" && request.method === "GET") {
        return json_({
          ok: true,
          ts: Date.now(),
          worker_version: String(env.WORKER_VERSION || "dev").trim() || "dev",
        }, env, 200);
      }

      // ----------------------------
      // Route groups & auth
      // ----------------------------
      const routeMode = routeModeFor_(path);

      const isUiRoute =
        path === "/ingest" ||
        path === "/jobs" ||
        path === "/metrics" ||
        path === "/dashboard/triage" ||
        path.startsWith("/jobs/") ||
        path === "/targets" ||
        path.startsWith("/targets/") ||
        path.startsWith("/resume/");

      const authErr = requireAuth_(request, env, routeMode);
      if (authErr) return authErr;

      // DB required for most routes except /health and pure AI extraction/scoring
      const needsDB =
        isUiRoute ||
        path === "/score-pending" ||
        path === "/admin/scoring-runs/report" ||
        path === "/resolve-jd" ||
        path.startsWith("/ingest/whatsapp/") ||
        path.startsWith("/gmail/") ||
        path.startsWith("/rss/"); // gmail/rss bridge requires D1 state

      if (needsDB && !env.DB) {
        return json_({ ok: false, error: "Missing D1 binding env.DB (bind your D1 as DB)" }, env, 500);
      }

      // AI required for extract/score and rescore endpoints
      const needsAI =
        path === "/extract-jd" ||
        path === "/score-jd" ||
        path === "/score-pending" ||
        path === "/jobs/evidence/rebuild-archived" ||
        path === "/jobs/recover/missing-fields" ||
        path === "/jobs/recover/rescore-existing-jd" ||
        (path.startsWith("/jobs/") && path.endsWith("/rescore")) ||
        (path.startsWith("/jobs/") && path.endsWith("/auto-pilot"));

      const ai = needsAI ? getAi_(env) : null;
      if (needsAI && !ai) {
        return json_({ ok: false, error: "Missing Workers AI binding (env.AI or AI_BINDING)" }, env, 500);
      }

      // ----------------------------
      // UI: Root (optional simple landing)
      // ----------------------------
      if (path === "/" && request.method === "GET") {
        return new Response("JobOps API (UI authenticated). Use /jobs", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders_(env) },
        });
      }

      // ============================
      // UI: Gmail OAuth connect
      // ============================
      if (path === "/gmail/auth" && request.method === "GET") {
        const redirectUri = `${url.origin}/gmail/callback`;
        const state = crypto.randomUUID();
        const authUrl = buildGmailAuthUrl_(env, { redirectUri, state });

        return new Response(null, {
          status: 302,
          headers: {
            Location: authUrl,
            "Set-Cookie": `jobops_gmail_oauth_state=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
            ...corsHeaders_(env),
          },
        });
      }

      if (path === "/gmail/callback" && request.method === "GET") {
        const code = String(url.searchParams.get("code") || "").trim();
        const state = String(url.searchParams.get("state") || "").trim();
        const cookieState = getCookie_(request, "jobops_gmail_oauth_state");
        const uiAuthorized = isUiAuth_(request, env);
        if (!uiAuthorized && (!state || state !== cookieState)) {
          return json_({ ok: false, error: "Unauthorized" }, env, 401);
        }

        if (!code) return json_({ ok: false, error: "Missing code" }, env, 400);
        const redirectUri = `${url.origin}/gmail/callback`;
        await handleGmailOAuthCallback_(env, { code, redirectUri });

        return new Response(
          "<!doctype html><html><body><h3>Gmail connected.</h3><p>You can close this tab.</p></body></html>",
          {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Set-Cookie": "jobops_gmail_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
              ...corsHeaders_(env),
            },
          }
        );
      }

      // ============================
      // ADMIN/CRON: Gmail poll
      // ============================
      if (path === "/gmail/poll" && request.method === "POST") {
        const isCron = isCronRequest_(request);
        const apiAuthorized = isApiAuth_(request, env);
        if (!isCron && !apiAuthorized) {
          const providedApiKey = String(request.headers.get("x-api-key") || "").trim();
          const hint = looksLikeGoogleClientSecret_(providedApiKey)
            ? "Unauthorized. Use API_KEY (Worker secret), not OAuth client secret."
            : "Unauthorized";
          return json_({ ok: false, error: hint }, env, 401);
        }
        const body = await request.json().catch(() => ({}));
        const query = typeof body.query === "string" ? body.query : "";
        const maxPerRunRaw = body.max_per_run ?? body.maxPerRun;
        const maxJobsPerEmailRaw = body.max_jobs_per_email ?? body.maxJobsPerEmail;
        const maxJobsPerPollRaw = body.max_jobs_per_poll ?? body.maxJobsPerPoll;
        const maxPerRun = Number.isFinite(Number(maxPerRunRaw)) ? Number(maxPerRunRaw) : undefined;
        const maxJobsPerEmail = Number.isFinite(Number(maxJobsPerEmailRaw)) ? Number(maxJobsPerEmailRaw) : undefined;
        const maxJobsPerPoll = Number.isFinite(Number(maxJobsPerPollRaw)) ? Number(maxJobsPerPollRaw) : undefined;
        const data = await runGmailPoll_(env, { query, maxPerRun, maxJobsPerEmail, maxJobsPerPoll });
        await logEvent_(env, "GMAIL_POLL", null, { source: isCron ? "cron" : "api", ...data, ts: Date.now() });
        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // ADMIN/CRON: RSS poll
      // ============================
      if (path === "/rss/poll" && request.method === "POST") {
        const isCron = isCronRequest_(request);
        const apiAuthorized = isApiAuth_(request, env);
        if (!isCron && !apiAuthorized) {
          return json_({ ok: false, error: "Unauthorized" }, env, 401);
        }
        const body = await request.json().catch(() => ({}));
        const maxPerRunRaw = body.max_per_run ?? body.maxPerRun;
        const feeds = Array.isArray(body.feed_urls)
          ? body.feed_urls.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const allowKeywords = Array.isArray(body.allow_keywords)
          ? body.allow_keywords
          : (typeof body.allow_keywords === "string" ? body.allow_keywords : undefined);
        const blockKeywords = Array.isArray(body.block_keywords)
          ? body.block_keywords
          : (typeof body.block_keywords === "string" ? body.block_keywords : undefined);
        const maxPerRun = Number.isFinite(Number(maxPerRunRaw)) ? Number(maxPerRunRaw) : undefined;
        const data = await runRssPoll_(env, { maxPerRun, feeds, allowKeywords, blockKeywords });
        await logEvent_(env, "RSS_POLL", null, { source: isCron ? "cron" : "api", ...data, ts: Date.now() });
        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // ADMIN: RSS diagnostics
      // ============================
      if (path === "/rss/diagnostics" && request.method === "POST") {
        const apiAuthorized = isApiAuth_(request, env);
        if (!apiAuthorized) {
          return json_({ ok: false, error: "Unauthorized" }, env, 401);
        }

        const body = await request.json().catch(() => ({}));
        const maxPerRunRaw = body.max_per_run ?? body.maxPerRun;
        const sampleLimitRaw = body.sample_limit ?? body.sampleLimit;
        const feeds = Array.isArray(body.feed_urls)
          ? body.feed_urls.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const allowKeywords = Array.isArray(body.allow_keywords)
          ? body.allow_keywords
          : (typeof body.allow_keywords === "string" ? body.allow_keywords : undefined);
        const blockKeywords = Array.isArray(body.block_keywords)
          ? body.block_keywords
          : (typeof body.block_keywords === "string" ? body.block_keywords : undefined);
        const maxPerRun = Number.isFinite(Number(maxPerRunRaw)) ? Number(maxPerRunRaw) : undefined;
        const sampleLimit = Number.isFinite(Number(sampleLimitRaw)) ? Number(sampleLimitRaw) : undefined;
        const data = await runRssDiagnostics_(env, {
          maxPerRun,
          sampleLimit,
          feeds,
          allowKeywords,
          blockKeywords,
        });

        await logEvent_(env, "RSS_DIAGNOSTICS", null, {
          source: "api",
          run_id: data?.run_id || null,
          ts: Date.now(),
          feeds_total: numOr_(data?.feeds_total, 0),
          feeds_processed: numOr_(data?.feeds_processed, 0),
          feeds_failed: numOr_(data?.feeds_failed, 0),
          items_listed: numOr_(data?.items_listed, 0),
          items_filtered_allow: numOr_(data?.items_filtered_allow, 0),
          items_filtered_block: numOr_(data?.items_filtered_block, 0),
          processed: numOr_(data?.processed, 0),
          urls_found_total: numOr_(data?.urls_found_total, 0),
          urls_unique_total: numOr_(data?.urls_unique_total, 0),
          urls_job_domains_total: numOr_(data?.urls_job_domains_total, 0),
          ignored_domains_count: numOr_(data?.ignored_domains_count, 0),
          inserted_or_updated: numOr_(data?.inserted_or_updated, 0),
          inserted_count: numOr_(data?.inserted_count, 0),
          updated_count: numOr_(data?.updated_count, 0),
          ignored: numOr_(data?.ignored, 0),
          link_only: numOr_(data?.link_only, 0),
          reason_buckets: data?.reason_buckets || {},
          source_summary: Array.isArray(data?.source_summary) ? data.source_summary : [],
        });

        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // UI: JOBS list (with search)
      // ============================
      if (path === "/jobs" && request.method === "GET") {
        const status = (url.searchParams.get("status") || "").trim().toUpperCase();
        const q = (url.searchParams.get("q") || "").trim();
        const limit = clampInt_(url.searchParams.get("limit") || 50, 1, 200);
        const offset = clampInt_(url.searchParams.get("offset") || 0, 0, 100000);

        const where = [];
        const args = [];

        if (status) {
          where.push("status = ?");
          args.push(status);
        }

        if (q) {
          where.push("(company LIKE ? OR role_title LIKE ? OR location LIKE ?)");
          const like = `%${q}%`;
          args.push(like, like, like);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const sql = `
          SELECT
            job_key, company, role_title, location, seniority,
            final_score, status, job_url, source_domain,
            system_status, fetch_debug_json, updated_at, created_at
          FROM jobs
          ${whereSql}
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?;
        `.trim();

        args.push(limit, offset);

        const res = await env.DB.prepare(sql).bind(...args).all();
        const touchpointByJobKey = await loadLatestTouchpointsByJobKey_(
          env,
          (res.results || []).map((r) => String(r?.job_key || "").trim())
        );
        const nowMs = Date.now();
        const rows = (res.results || []).map((row) => {
          const fetchDebug = safeJsonParse_(row.fetch_debug_json) || {};
          row.fetch_debug = fetchDebug;
          row.ingest_channel = normalizeIngestChannel_(fetchDebug.ingest_channel) || null;
          row.jd_confidence = String(fetchDebug.jd_confidence || "").trim().toLowerCase() || null;
          applyLatestTouchpointToJobRow_(
            row,
            touchpointByJobKey[String(row.job_key || "").trim()] || null,
            nowMs
          );
          const display = computeDisplayFields_(row);
          return { ...row, ...display };
        });
        return json_({ ok: true, data: rows }, env, 200);
      }

      // ============================
      // UI: Dashboard metrics
      // ============================
      if (path === "/metrics" && request.method === "GET") {
        const data = await loadUiMetrics_(env);
        return json_({ ok: true, data }, env, 200);
      }

      if (path === "/dashboard/triage" && request.method === "GET") {
        const staleDays = clampInt_(url.searchParams.get("stale_days") || 3, 1, 21);
        const limit = clampInt_(url.searchParams.get("limit") || 80, 5, 200);
        const goldLimit = clampInt_(url.searchParams.get("gold_limit") || 3, 1, 10);

        const data = await buildDashboardTriageReport_(env, {
          stale_days: staleDays,
          limit,
          gold_limit: goldLimit,
        });
        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // UI: JOB detail
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/contacts") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const job = await env.DB.prepare(`
          SELECT job_key, company
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        const contactsView = await listContactsForJobOutreach_(env, {
          job_key: jobKey,
          company: String(job.company || "").trim(),
        });

        return json_({
          ok: true,
          data: contactsView.contacts,
          meta: {
            job_key: jobKey,
            count: contactsView.contacts.length,
            contacts_storage_enabled: contactsView.enabled,
            contacts_storage_error: contactsView.error || null,
          },
        }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/profile-preference") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const job = await env.DB.prepare(`
          SELECT job_key
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(jobKey).first();
        if (!job?.job_key) return json_({ ok: false, error: "Not found" }, env, 404);

        const pref = await getJobProfilePreference_(env, jobKey);
        const resolved = await resolvePreferredProfileForJob_(env, { jobKey });

        return json_({
          ok: true,
          data: {
            job_key: jobKey,
            profile_id: String(pref.profile_id || "").trim(),
            updated_at: numOrNull_(pref.updated_at),
            enabled: Boolean(pref.enabled),
            effective_profile_id: String(resolved.profile_id || "").trim() || "primary",
            effective_source: String(resolved.source || "").trim() || "primary_fallback",
          },
        }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/profile-preference") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const job = await env.DB.prepare(`
          SELECT job_key
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(jobKey).first();
        if (!job?.job_key) return json_({ ok: false, error: "Not found" }, env, 404);

        const body = await request.json().catch(() => ({}));
        const profileIdIn = String(body.profile_id || body.profileId || "").trim();

        if (profileIdIn) {
          const profileExists = await env.DB.prepare(`
            SELECT id
            FROM resume_profiles
            WHERE id = ?
            LIMIT 1;
          `.trim()).bind(profileIdIn).first();
          if (!profileExists?.id) {
            return json_({ ok: false, error: "profile_id_not_found" }, env, 400);
          }
        }

        const write = await setJobProfilePreference_(env, {
          jobKey,
          profileId: profileIdIn,
        });
        if (!write.ok) {
          return json_({ ok: false, error: write.error || "Failed to update profile preference" }, env, 400);
        }

        const resolved = await resolvePreferredProfileForJob_(env, { jobKey });
        await logEvent_(env, write.cleared ? "JOB_PROFILE_PREFERENCE_CLEARED" : "JOB_PROFILE_PREFERENCE_SET", jobKey, {
          profile_id: write.profile_id || null,
          effective_profile_id: resolved.profile_id || "primary",
          effective_source: resolved.source || "primary_fallback",
          ts: Date.now(),
        });

        return json_({
          ok: true,
          data: {
            job_key: jobKey,
            profile_id: String(write.profile_id || "").trim(),
            updated_at: numOrNull_(write.updated_at),
            cleared: Boolean(write.cleared),
            enabled: Boolean(write.enabled),
            effective_profile_id: String(resolved.profile_id || "").trim() || "primary",
            effective_source: String(resolved.source || "").trim() || "primary_fallback",
          },
        }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/resume/html") && request.method === "GET") {
        const parts = path.split("/");
        const jobKey = decodeURIComponent(parts[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const job = await env.DB.prepare(`
          SELECT *
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        const profileResolved = await resolvePreferredProfileForJob_(env, {
          jobKey,
          profileIdIn: String(url.searchParams.get("profile_id") || "").trim(),
        });
        const profile = profileResolved.profile || await ensurePrimaryProfile_(env);
        const evidenceLimit = clampInt_(url.searchParams.get("evidence_limit") || 12, 1, 30);
        const matchedEvidence = await loadMatchedEvidenceForPack_(env, jobKey, evidenceLimit);
        const html = generateProfessionalHtml(profile, job, matchedEvidence);

        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders_(env),
          },
        });
      }

      if (
        path.startsWith("/jobs/") &&
        request.method === "GET" &&
        !path.startsWith("/jobs/evidence/") &&
        !path.endsWith("/status") &&
        !path.endsWith("/rescore") &&
        !path.endsWith("/checklist") &&
        !path.endsWith("/evidence") &&
        !path.endsWith("/resume-payload") &&
        !path.endsWith("/profile-preference") &&
        !path.endsWith("/application-pack") &&
        !path.includes("/application-pack/")
      ) {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const row = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);

        decorateJobRow_(row);
        const touchpointByJobKey = await loadLatestTouchpointsByJobKey_(env, [jobKey]);
        applyLatestTouchpointToJobRow_(row, touchpointByJobKey[jobKey] || null, Date.now());
        return json_({ ok: true, data: row }, env, 200);
      }

      // ============================
      // UI: Job evidence
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/evidence") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const limit = clampInt_(url.searchParams.get("limit") || 300, 1, 1000);

        const hasEvidenceTable = await hasJobEvidenceTable_(env);
        if (!hasEvidenceTable) {
          return json_({ ok: false, error: "Evidence schema not enabled in DB" }, env, 400);
        }

        const res = await env.DB.prepare(`
          SELECT
            id,
            job_key,
            requirement_text,
            requirement_type,
            evidence_text,
            evidence_source,
            confidence_score,
            matched,
            notes,
            created_at,
            updated_at
          FROM job_evidence
          WHERE job_key = ?
          ORDER BY
            CASE requirement_type
              WHEN 'must' THEN 1
              WHEN 'nice' THEN 2
              WHEN 'constraint' THEN 3
              WHEN 'reject' THEN 4
              ELSE 9
            END ASC,
            matched DESC,
            confidence_score DESC,
            updated_at DESC
          LIMIT ?;
        `.trim()).bind(jobKey, limit).all();

        const rows = (res.results || []).map((r) => ({
          ...r,
          matched: toBool_(r.matched, false),
          confidence_score: clampInt_(r.confidence_score, 0, 100),
        }));
        if (!rows.length) {
          return json_({ ok: false, error: "Evidence not found" }, env, 404);
        }

        return json_({
          ok: true,
          data: rows,
          meta: {
            job_key: jobKey,
            count: rows.length,
            matched_count: rows.filter((x) => x.matched).length,
            unmatched_count: rows.filter((x) => !x.matched).length,
          },
        }, env, 200);
      }

      // ============================
      // UI: Rebuild job evidence
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/evidence/rebuild") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const hasEvidenceTable = await hasJobEvidenceTable_(env);
        if (!hasEvidenceTable) {
          return json_({ ok: false, error: "Evidence schema not enabled in DB" }, env, 400);
        }

        const job = await env.DB.prepare(`
          SELECT
            job_key,
            jd_text_clean,
            must_have_keywords_json,
            nice_to_have_keywords_json,
            reject_keywords_json
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        const now = Date.now();
        const extractedJd = {
          must_have_keywords: safeJsonParseArray_(job.must_have_keywords_json),
          nice_to_have_keywords: safeJsonParseArray_(job.nice_to_have_keywords_json),
          reject_keywords: safeJsonParseArray_(job.reject_keywords_json),
          constraints: [],
          jd_text: String(job.jd_text_clean || "").trim(),
        };

        const totalRequirements =
          extractedJd.must_have_keywords.length +
          extractedJd.nice_to_have_keywords.length +
          extractedJd.reject_keywords.length;
        if (!totalRequirements) {
          return json_({ ok: false, error: "No extracted requirements available. Rescore first." }, env, 400);
        }

        try {
          const resumeTailoring = await loadLatestResumeTailoringForEvidence_(env, jobKey);
          const evidenceRows = buildEvidenceRows_({
            jobKey,
            extractedJd,
            resumeJson: resumeTailoring,
            now,
          });
          const result = await upsertJobEvidence_(env, jobKey, evidenceRows);
          await logEvent_(env, "EVIDENCE_REBUILT", jobKey, {
            ...result,
            requirement_count: evidenceRows.length,
            ts: now,
          });
          return json_({
            ok: true,
            data: {
              job_key: jobKey,
              ...result,
              requirement_count: evidenceRows.length,
            },
          }, env, 200);
        } catch (e) {
          await logEvent_(env, "EVIDENCE_UPSERT_FAILED", jobKey, {
            route: "evidence-rebuild",
            error: String(e?.message || e || "unknown").slice(0, 300),
            ts: now,
          });
          return json_({
            ok: false,
            error: "Evidence rebuild failed",
            detail: String(e?.message || e || "unknown"),
          }, env, 500);
        }
      }

      // ============================
      // API: Bulk rebuild evidence for ARCHIVED jobs (one-time maintenance)
      // ============================
      if (path === "/jobs/evidence/rebuild-archived" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const modeRaw = String(body.mode || "retry_failed").trim().toLowerCase();
        const mode = (modeRaw === "all_archived" || modeRaw === "retry_failed") ? modeRaw : "retry_failed";
        const limit = clampInt_(body.limit || 3, 1, 10);
        const delayMs = clampInt_(body.delay_ms || 2000, 0, 2000);
        const force = toBool_(body.force, false);
        const profileId = String(body.profile_id || "primary").trim() || "primary";
        const profileOnly = body.profile_only === undefined ? true : toBool_(body.profile_only, true);
        const maxTokens = clampInt_(body.max_tokens || 500, 128, 700);
        const cursorJobKey = String(body.cursor_job_key || "").trim();

        const data = await bulkRebuildArchivedEvidence_(env, ai, {
          mode,
          limit,
          delayMs,
          force,
          profileId,
          profileOnly,
          maxTokens,
          cursorJobKey,
        });
        await logEvent_(env, "EVIDENCE_BULK_REBUILD_ARCHIVED", null, {
          ...data,
          mode,
          cursor_job_key: cursorJobKey || null,
          max_tokens: maxTokens,
          delay_ms: delayMs,
          ts: Date.now(),
        });
        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // API: Evidence gap report (read-only)
      // ============================
      if (path === "/jobs/evidence/gap-report" && request.method === "GET") {
        const status = String(url.searchParams.get("status") || "ARCHIVED").trim().toUpperCase() || "ARCHIVED";
        const top = clampInt_(url.searchParams.get("top") || 5, 1, 20);
        const minMissed = clampInt_(url.searchParams.get("min_missed") || 1, 1, 1000);
        const profileId = String(url.searchParams.get("profile_id") || "primary").trim() || "primary";

        const report = await getEvidenceGapReport_(env, { status, top, minMissed, profileId });
        return json_({ ok: true, data: report }, env, 200);
      }

      // ============================
      // API: Scoring efficiency report (read-only)
      // ============================
      if (path === "/admin/scoring-runs/report" && request.method === "GET") {
        const windowDays = clampInt_(url.searchParams.get("window_days") || 14, 1, 180);
        const trendDays = clampInt_(url.searchParams.get("trend_days") || Math.min(windowDays, 30), 1, 180);
        const stageSampleLimit = clampInt_(url.searchParams.get("stage_sample_limit") || 1500, 50, 5000);
        const source = String(url.searchParams.get("source") || "").trim().toLowerCase();

        const report = await buildScoringRunsEfficiencyReport_(env, {
          window_days: windowDays,
          trend_days: trendDays,
          stage_sample_limit: stageSampleLimit,
          source,
        });

        return json_({ ok: true, data: report }, env, 200);
      }

      // ============================
      // UI: Update job status
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/status") && request.method === "POST") {
        const parts = path.split("/");
        const jobKey = decodeURIComponent(parts[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const status = String(body.status || "").trim().toUpperCase();
        const allowed = new Set(["NEW","LINK_ONLY","SCORED","SHORTLISTED","READY_TO_APPLY","APPLIED","REJECTED","ARCHIVED"]);
        if (!allowed.has(status)) {
          return json_({ ok: false, error: "Invalid status", allowed: Array.from(allowed) }, env, 400);
        }

        const now = Date.now();
        const appliedAt = status === "APPLIED" ? now : null;
        const rejectedAt = status === "REJECTED" ? now : null;
        const archivedAt = status === "ARCHIVED" ? now : null;

        const r = await env.DB.prepare(`
          UPDATE jobs
          SET
            status = ?,
            updated_at = ?,
            applied_at = COALESCE(?, applied_at),
            rejected_at = COALESCE(?, rejected_at),
            archived_at = COALESCE(?, archived_at)
          WHERE job_key = ?;
        `.trim()).bind(status, now, appliedAt, rejectedAt, archivedAt, jobKey).run();

        if (!r.success || r.changes === 0) return json_({ ok: false, error: "Not found" }, env, 404);

        await logEvent_(env, "STATUS_CHANGED", jobKey, { status, ts: now });
        return json_({ ok: true, data: { job_key: jobKey, status, updated_at: now } }, env, 200);
      }

      // ============================
      // UI: Backfill incomplete jobs
      // ============================
      if (path === "/jobs/backfill-missing" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const limit = clampInt_(body.limit || 30, 1, 200);
        const data = await runBackfillMissing_(env, limit);

        await logEvent_(env, "BACKFILL_MISSING", null, {
          picked: data?.picked || 0,
          processed: data?.processed || 0,
          skipped_no_url: data?.skipped_no_url || 0,
          inserted_or_updated: data?.inserted_or_updated || 0,
          inserted_count: data?.inserted_count || 0,
          updated_count: data?.updated_count || 0,
          ignored: data?.ignored || 0,
          link_only: data?.link_only || 0,
          ts: Date.now(),
        });

        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // UI: Cleanup noisy/invalid tracked URLs
      // ============================
      if (path === "/jobs/cleanup-urls" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const limit = clampInt_(body.limit || 200, 1, 1000);
        const archiveInvalid = body.archive_invalid !== false;
        const archiveDuplicates = body.archive_duplicates !== false;

        const data = await runCleanupTrackedUrls_(env, {
          limit,
          archiveInvalid,
          archiveDuplicates,
        });

        await logEvent_(env, "CLEANUP_TRACKED_URLS", null, {
          scanned: data?.scanned || 0,
          canonicalized: data?.canonicalized || 0,
          archived_invalid: data?.archived_invalid || 0,
          archived_duplicates: data?.archived_duplicates || 0,
          unchanged: data?.unchanged || 0,
          errors: data?.errors || 0,
          ts: Date.now(),
        });

        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // UI: Canonicalize noisy/missing role titles
      // ============================
      if (path === "/jobs/canonicalize-titles" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const limit = clampInt_(body.limit || 200, 1, 1000);
        const onlyMissing = body.only_missing !== false;
        const dryRun = body.dry_run === true;

        const data = await runCanonicalizeTitles_(env, {
          limit,
          onlyMissing,
          dryRun,
        });

        await logEvent_(env, "CANONICALIZE_TITLES", null, {
          limit,
          only_missing: onlyMissing,
          dry_run: dryRun,
          scanned: data?.scanned || 0,
          updated: data?.updated || 0,
          skipped: data?.skipped || 0,
          errors: data?.errors || 0,
          ts: Date.now(),
        });

        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // UI: Recovery - rescore existing JD only (no fetch)
      // ============================
      if (path === "/jobs/recover/rescore-existing-jd" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const batch = await runScorePending_(env, ai, body, {
          defaultStatuses: ["NEW", "SCORED", "LINK_ONLY"],
          allowedStatuses: ["NEW", "SCORED", "LINK_ONLY"],
          requireJd: true,
        });
        if (!batch.ok) return json_({ ok: false, error: batch.error }, env, batch.status || 400);

        await logEvent_(env, "RESCORE_EXISTING_JD", null, {
          limit: batch.limit,
          status: batch.statuses.join(","),
          updated: batch.data.updated,
          picked: batch.data.picked,
          ts: Date.now(),
        });
        return json_({ ok: true, data: batch.data }, env, 200);
      }

      // ============================
      // UI: Recovery - fill missing role/company from existing JD
      // ============================
      if (path === "/jobs/recover/missing-fields" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const limit = clampInt_(body.limit || 30, 1, 200);
        const data = await runRecoverMissingFields_(env, ai, limit);

        await logEvent_(env, "RECOVER_MISSING_FIELDS", null, {
          limit,
          picked: data?.picked || 0,
          updated: data?.updated || 0,
          skipped: data?.skipped || 0,
          errors: data?.errors || 0,
          ts: Date.now(),
        });
        return json_({ ok: true, data }, env, 200);
      }

      // ============================
      // UI: Recovery - retry fetch for missing JD only
      // ============================
      if (path === "/jobs/recover/retry-fetch-missing-jd" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const limit = clampInt_(body.limit || 30, 1, 200);

        const rows = await env.DB.prepare(`
          SELECT job_key, job_url
          FROM jobs
          WHERE
            status IN ('NEW', 'LINK_ONLY')
            AND COALESCE(TRIM(jd_text_clean), '') = ''
            AND COALESCE(TRIM(job_url), '') != ''
          ORDER BY updated_at ASC
          LIMIT ?;
        `.trim()).bind(limit).all();

        const pickedRows = Array.isArray(rows?.results) ? rows.results : [];
        const rawUrls = pickedRows
          .map((r) => String(r?.job_url || "").trim())
          .filter(Boolean);

        if (!rawUrls.length) {
          return json_({
            ok: true,
            data: {
              picked: pickedRows.length,
              processed: 0,
              inserted_or_updated: 0,
              inserted_count: 0,
              updated_count: 0,
              ignored: 0,
              link_only: 0,
              results: [],
            }
          }, env, 200);
        }

        const recoverConcurrency = clampInt_(env.RECOVER_CONCURRENCY || 3, 1, 6);
        const ingestData = await runIngestBatchConcurrent_(env, {
          rawUrls,
          emailText: "",
          emailHtml: "",
          emailSubject: "",
          emailFrom: "",
          ingestChannel: "recover",
          concurrency: recoverConcurrency,
        });

        await logEvent_(env, "RETRY_FETCH_MISSING_JD", null, {
          limit,
          picked: pickedRows.length,
          processed: rawUrls.length,
          inserted_or_updated: ingestData?.inserted_or_updated || 0,
          inserted_count: ingestData?.inserted_count || 0,
          updated_count: ingestData?.updated_count || 0,
          ignored: ingestData?.ignored || 0,
          link_only: ingestData?.link_only || 0,
          ts: Date.now(),
        });

        return json_({
          ok: true,
          data: {
            picked: pickedRows.length,
            processed: rawUrls.length,
            inserted_or_updated: ingestData?.inserted_or_updated || 0,
            inserted_count: ingestData?.inserted_count || 0,
            updated_count: ingestData?.updated_count || 0,
            ignored: ingestData?.ignored || 0,
            link_only: ingestData?.link_only || 0,
            results: Array.isArray(ingestData?.results) ? ingestData.results : [],
          }
        }, env, 200);
      }

      // ============================
      // UI: Manual JD submit + rescore
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/manual-jd") && request.method === "POST") {
        const parts = path.split("/");
        const jobKey = decodeURIComponent(parts[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const existing = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!existing) return json_({ ok: false, error: "Not found" }, env, 404);

        const body = await request.json().catch(() => ({}));
        const jdText = cleanJdText_(String(body.jd_text_clean || ""));
        if (jdText.length < 200) {
          return json_({ ok: false, error: "jd_text_clean must be at least 200 chars" }, env, 400);
        }

        const now = Date.now();
        await env.DB.prepare(`
          UPDATE jobs
          SET jd_text_clean = ?, jd_source = 'manual', fetch_status = 'ok', fetch_debug_json = '{}', updated_at = ?
          WHERE job_key = ?;
        `.trim()).bind(jdText.slice(0, 12000), now, jobKey).run();

        const aiForManual = ai || getAi_(env);
        if (!aiForManual) {
          const transition = applyStatusTransition_(existing, "manual_saved_no_ai");
          await env.DB.prepare(`
            UPDATE jobs
            SET system_status = ?, next_status = ?, updated_at = ?
            WHERE job_key = ?;
          `.trim()).bind(transition.system_status, transition.next_status, now, jobKey).run();

          return json_({
            ok: true,
            data: {
              job_key: jobKey,
              status: String(existing.status || "LINK_ONLY"),
              final_score: existing.final_score ?? null,
              primary_target_id: existing.primary_target_id || null,
              saved_only: true,
              message: "Manual JD saved, but AI binding is unavailable. Configure AI and rescore.",
            }
          }, env, 200);
        }

        const extracted = sanitizeExtracted_(
          await extractJdWithModel_(aiForManual, jdText),
          jdText,
          {
            job_url: existing?.job_url,
            source_domain: existing?.source_domain,
            email_subject: "",
          }
        );
        const targets = await loadTargets_(env);
        if (!targets.length) return json_({ ok: false, error: "No targets configured" }, env, 400);
        const cfg = await loadSysCfg_(env);

        const roleTitle = String(extracted?.role_title || existing.role_title || "").trim();
        const company = String(extracted?.company || existing.company || "").trim();
        const location = String(extracted?.location || existing.location || "").trim();
        const seniority = String(extracted?.seniority || existing.seniority || "").trim();

        const pipelineResult = await runScoringPipelineForJob_(env, {
          source: "manual-jd",
          job_key: jobKey,
          existing_job: existing,
          ai: aiForManual,
          targets,
          cfg,
          jd_clean: jdText,
          company,
          role_title: roleTitle,
          location,
          seniority,
        });
        const finalScore = pipelineResult.final_score;
        const transition = pipelineResult.transition;

        await env.DB.prepare(`
          UPDATE jobs
          SET
            company = COALESCE(?, company),
            role_title = COALESCE(?, role_title),
            location = COALESCE(?, location),
            work_mode = COALESCE(?, work_mode),
            seniority = COALESCE(?, seniority),
            experience_years_min = COALESCE(?, experience_years_min),
            experience_years_max = COALESCE(?, experience_years_max),
            skills_json = ?,
            must_have_keywords_json = ?,
            nice_to_have_keywords_json = ?,
            reject_keywords_json = ?,
            primary_target_id = ?,
            score_must = ?,
            score_nice = ?,
            final_score = ?,
            reject_triggered = ?,
            reject_reasons_json = ?,
            reject_evidence = ?,
            reason_top_matches = ?,
            next_status = ?,
            system_status = ?,
            status = ?,
            last_scored_at = ?,
            updated_at = ?
          WHERE job_key = ?;
        `.trim()).bind(
          extracted?.company ?? null,
          extracted?.role_title ?? null,
          extracted?.location ?? null,
          extracted?.work_mode ?? null,
          extracted?.seniority ?? null,
          numOrNull_(extracted?.experience_years_min),
          numOrNull_(extracted?.experience_years_max),
          JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
          JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
          pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
          clampInt_(pipelineResult.score_must, 0, 100),
          clampInt_(pipelineResult.score_nice, 0, 100),
          finalScore,
          pipelineResult.reject_triggered ? 1 : 0,
          JSON.stringify(pipelineResult.reject_reasons || []),
          String(pipelineResult.reject_evidence || "").slice(0, 220),
          String(pipelineResult.reason_top_matches || "").slice(0, 1000),
          transition.next_status,
          transition.system_status,
          transition.status,
          now,
          now,
          jobKey
        ).run();

        try {
          const resumeTailoring = await loadLatestResumeTailoringForEvidence_(env, jobKey);
          const evidenceRows = buildEvidenceRows_({
            jobKey,
            extractedJd: {
              must_have_keywords: Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : [],
              nice_to_have_keywords: Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : [],
              reject_keywords: Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : [],
              constraints: [],
              jd_text: jdText,
            },
            resumeJson: resumeTailoring,
            now,
          });
          await upsertJobEvidence_(env, jobKey, evidenceRows);
        } catch (e) {
          await logEvent_(env, "EVIDENCE_UPSERT_FAILED", jobKey, {
            route: "manual-jd",
            error: String(e?.message || e || "unknown").slice(0, 300),
            ts: Date.now(),
          });
        }

        await logEvent_(env, "MANUAL_JD_RESCORED", jobKey, { status: transition.status, final_score: finalScore, ts: now });
        return json_({
          ok: true,
          data: {
            job_key: jobKey,
            status: transition.status,
            final_score: finalScore,
            primary_target_id: pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
            potential_contacts: Array.isArray(pipelineResult.potential_contacts) ? pipelineResult.potential_contacts : [],
          }
        }, env, 200);
      }

      // ============================
      // UI: Single job rescore
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/rescore") && request.method === "POST") {
        const parts = path.split("/");
        const jobKey = decodeURIComponent(parts[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const job = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        const targets = await loadTargets_(env);

        // Need jd_text_clean or role_title to score
        const jdClean = String(job.jd_text_clean || "").trim();
        let roleTitle = String(job.role_title || "").trim();
        let location = String(job.location || "").trim();
        let seniority = String(job.seniority || "").trim();
        let company = String(job.company || "").trim();
        let extracted = null;
        if (!jdClean && !roleTitle) {
          return json_({ ok: false, error: "Job missing jd_text_clean and role_title" }, env, 400);
        }
        if (jdClean.length >= 200) {
          extracted = await extractJdWithModel_(ai, jdClean)
            .then((x) => sanitizeExtracted_(x, jdClean, {
              job_url: job?.job_url,
              source_domain: job?.source_domain,
              email_subject: "",
            }))
            .catch(() => null);
          if (extracted) {
            roleTitle = String(extracted.role_title || roleTitle || "").trim();
            location = String(extracted.location || location || "").trim();
            seniority = String(extracted.seniority || seniority || "").trim();
            company = String(extracted.company || company || "").trim();
          }
        }
        if (!targets.length) return json_({ ok: false, error: "No targets configured" }, env, 400);

        const cfg = await loadSysCfg_(env);
        const pipelineResult = await runScoringPipelineForJob_(env, {
          source: "rescore",
          job_key: jobKey,
          existing_job: job,
          ai,
          targets,
          cfg,
          jd_clean: jdClean,
          company,
          role_title: roleTitle,
          location,
          seniority,
        });
        const finalScore = pipelineResult.final_score;
        const transition = pipelineResult.transition;

        const now = Date.now();
        await env.DB.prepare(`
          UPDATE jobs SET
            company = COALESCE(?, company),
            role_title = COALESCE(?, role_title),
            location = COALESCE(?, location),
            work_mode = COALESCE(?, work_mode),
            seniority = COALESCE(?, seniority),
            experience_years_min = COALESCE(?, experience_years_min),
            experience_years_max = COALESCE(?, experience_years_max),
            skills_json = CASE WHEN ? != '[]' THEN ? ELSE skills_json END,
            must_have_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE must_have_keywords_json END,
            nice_to_have_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE nice_to_have_keywords_json END,
            reject_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE reject_keywords_json END,
            primary_target_id = ?,
            score_must = ?,
            score_nice = ?,
            final_score = ?,
            reject_triggered = ?,
            reject_reasons_json = ?,
            reject_evidence = ?,
            reason_top_matches = ?,
            next_status = ?,
            system_status = ?,
            status = ?,
            updated_at = ?,
            last_scored_at = ?
          WHERE job_key = ?;
        `.trim()).bind(
          extracted?.company ?? null,
          extracted?.role_title ?? null,
          extracted?.location ?? null,
          extracted?.work_mode ?? null,
          extracted?.seniority ?? null,
          numOrNull_(extracted?.experience_years_min),
          numOrNull_(extracted?.experience_years_max),
          JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
          JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
          JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
          JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
          pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
          clampInt_(pipelineResult.score_must, 0, 100),
          clampInt_(pipelineResult.score_nice, 0, 100),
          finalScore,
          pipelineResult.reject_triggered ? 1 : 0,
          JSON.stringify(pipelineResult.reject_reasons || []),
          String(pipelineResult.reject_evidence || "").slice(0, 220),
          String(pipelineResult.reason_top_matches || "").slice(0, 1000),
          transition.next_status,
          transition.system_status,
          transition.status,
          now,
          now,
          jobKey
        ).run();

        try {
          const resumeTailoring = await loadLatestResumeTailoringForEvidence_(env, jobKey);
          const evidenceRows = buildEvidenceRows_({
            jobKey,
            extractedJd: {
              must_have_keywords: Array.isArray(extracted?.must_have_keywords)
                ? extracted.must_have_keywords
                : safeJsonParseArray_(job.must_have_keywords_json),
              nice_to_have_keywords: Array.isArray(extracted?.nice_to_have_keywords)
                ? extracted.nice_to_have_keywords
                : safeJsonParseArray_(job.nice_to_have_keywords_json),
              reject_keywords: Array.isArray(extracted?.reject_keywords)
                ? extracted.reject_keywords
                : safeJsonParseArray_(job.reject_keywords_json),
              constraints: [],
              jd_text: jdClean,
            },
            resumeJson: resumeTailoring,
            now,
          });
          await upsertJobEvidence_(env, jobKey, evidenceRows);
        } catch (e) {
          await logEvent_(env, "EVIDENCE_UPSERT_FAILED", jobKey, {
            route: "rescore",
            error: String(e?.message || e || "unknown").slice(0, 300),
            ts: Date.now(),
          });
        }

        await logEvent_(env, "RESCORED_ONE", jobKey, { final_score: finalScore, status: transition.status, ts: now });

        return json_({
          ok: true,
          data: {
            job_key: jobKey,
            final_score: finalScore,
            status: transition.status,
            primary_target_id: pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
            potential_contacts: Array.isArray(pipelineResult.potential_contacts) ? pipelineResult.potential_contacts : [],
          }
        }, env, 200);
      }

      // ============================
      // UI: Auto-pilot (score + generate)
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/auto-pilot") && request.method === "POST") {
        const parts = path.split("/");
        const jobKey = decodeURIComponent(parts[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const aiAuto = ai || getAi_(env);
        if (!aiAuto) {
          return json_({ ok: false, error: "Missing Workers AI binding (env.AI or AI_BINDING)" }, env, 500);
        }

        const job = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        const targets = await loadTargets_(env);
        if (!targets.length) return json_({ ok: false, error: "No targets configured" }, env, 400);

        const jdClean = String(job.jd_text_clean || "").trim();
        let roleTitle = String(job.role_title || "").trim();
        let location = String(job.location || "").trim();
        let seniority = String(job.seniority || "").trim();
        let company = String(job.company || "").trim();
        let extracted = null;
        if (!jdClean && !roleTitle) {
          return json_({ ok: false, error: "Job missing jd_text_clean and role_title" }, env, 400);
        }

        if (jdClean.length >= 200) {
          extracted = await extractJdWithModel_(aiAuto, jdClean)
            .then((x) => sanitizeExtracted_(x, jdClean, {
              job_url: job?.job_url,
              source_domain: job?.source_domain,
              email_subject: "",
            }))
            .catch(() => null);
          if (extracted) {
            roleTitle = String(extracted.role_title || roleTitle || "").trim();
            location = String(extracted.location || location || "").trim();
            seniority = String(extracted.seniority || seniority || "").trim();
            company = String(extracted.company || company || "").trim();
          }
        }

        const cfg = await loadSysCfg_(env);
        const pipelineResult = await runScoringPipelineForJob_(env, {
          source: "auto-pilot",
          job_key: jobKey,
          existing_job: job,
          ai: aiAuto,
          targets,
          cfg,
          jd_clean: jdClean,
          company,
          role_title: roleTitle,
          location,
          seniority,
        });
        const finalScore = pipelineResult.final_score;
        const transition = pipelineResult.transition;

        const scoredAt = Date.now();
        await env.DB.prepare(`
          UPDATE jobs SET
            company = COALESCE(?, company),
            role_title = COALESCE(?, role_title),
            location = COALESCE(?, location),
            work_mode = COALESCE(?, work_mode),
            seniority = COALESCE(?, seniority),
            experience_years_min = COALESCE(?, experience_years_min),
            experience_years_max = COALESCE(?, experience_years_max),
            skills_json = CASE WHEN ? != '[]' THEN ? ELSE skills_json END,
            must_have_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE must_have_keywords_json END,
            nice_to_have_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE nice_to_have_keywords_json END,
            reject_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE reject_keywords_json END,
            primary_target_id = ?,
            score_must = ?,
            score_nice = ?,
            final_score = ?,
            reject_triggered = ?,
            reject_reasons_json = ?,
            reject_evidence = ?,
            reason_top_matches = ?,
            next_status = ?,
            system_status = ?,
            status = ?,
            updated_at = ?,
            last_scored_at = ?
          WHERE job_key = ?;
        `.trim()).bind(
          extracted?.company ?? null,
          extracted?.role_title ?? null,
          extracted?.location ?? null,
          extracted?.work_mode ?? null,
          extracted?.seniority ?? null,
          numOrNull_(extracted?.experience_years_min),
          numOrNull_(extracted?.experience_years_max),
          JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
          JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
          JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
          JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
          JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
          pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
          clampInt_(pipelineResult.score_must, 0, 100),
          clampInt_(pipelineResult.score_nice, 0, 100),
          finalScore,
          pipelineResult.reject_triggered ? 1 : 0,
          JSON.stringify(pipelineResult.reject_reasons || []),
          String(pipelineResult.reject_evidence || "").slice(0, 220),
          String(pipelineResult.reason_top_matches || "").slice(0, 1000),
          transition.next_status,
          transition.system_status,
          transition.status,
          scoredAt,
          scoredAt,
          jobKey
        ).run();

        try {
          const resumeTailoring = await loadLatestResumeTailoringForEvidence_(env, jobKey);
          const evidenceRows = buildEvidenceRows_({
            jobKey,
            extractedJd: {
              must_have_keywords: Array.isArray(extracted?.must_have_keywords)
                ? extracted.must_have_keywords
                : safeJsonParseArray_(job.must_have_keywords_json),
              nice_to_have_keywords: Array.isArray(extracted?.nice_to_have_keywords)
                ? extracted.nice_to_have_keywords
                : safeJsonParseArray_(job.nice_to_have_keywords_json),
              reject_keywords: Array.isArray(extracted?.reject_keywords)
                ? extracted.reject_keywords
                : safeJsonParseArray_(job.reject_keywords_json),
              constraints: [],
              jd_text: jdClean,
            },
            resumeJson: resumeTailoring,
            now: scoredAt,
          });
          await upsertJobEvidence_(env, jobKey, evidenceRows);
        } catch (e) {
          await logEvent_(env, "EVIDENCE_UPSERT_FAILED", jobKey, {
            route: "auto-pilot",
            error: String(e?.message || e || "unknown").slice(0, 300),
            ts: Date.now(),
          });
        }

        const scoredJob = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!scoredJob) return json_({ ok: false, error: "Not found after score update" }, env, 404);

        const force = Boolean(body.force);
        const renderer = String(body.renderer || "reactive_resume").trim().toLowerCase();
        const rendererSafe = (renderer === "html_simple" || renderer === "reactive_resume") ? renderer : "reactive_resume";
        const legacyOnePagerProvided = (body.one_pager_strict !== undefined || body.onePagerStrict !== undefined);
        const controls = {
          template_id: String(body.template_id || body.templateId || "").trim().slice(0, 80),
          enabled_blocks: Array.isArray(body.enabled_blocks)
            ? body.enabled_blocks
            : (Array.isArray(body.enabledBlocks) ? body.enabledBlocks : []),
          selected_keywords: Array.isArray(body.selected_keywords)
            ? body.selected_keywords
            : (Array.isArray(body.selectedKeywords) ? body.selectedKeywords : []),
          ats_target_mode: String(body.ats_target_mode || body.atsTargetMode || "").trim().toLowerCase(),
          one_page_mode: normalizeOnePageMode_(body.one_page_mode ?? body.onePageMode),
          one_pager_strict: toBool_(body.one_pager_strict ?? body.onePagerStrict, true),
          content_review_required: true,
        };
        const resolvedOnePageMode = controls.one_page_mode || resolveDefaultOnePageMode_(scoredJob);
        controls.one_page_mode = resolvedOnePageMode;
        controls.one_pager_strict = legacyOnePagerProvided
          ? toBool_(body.one_pager_strict ?? body.onePagerStrict, true)
          : (resolvedOnePageMode === "hard");

        const profileResolved = await resolvePreferredProfileForJob_(env, {
          jobKey: scoredJob.job_key,
          profileIdIn: String(body.profile_id || body.profileId || "").trim(),
        });
        const profile = profileResolved.profile;
        if (!profile) {
          return json_({ ok: false, error: "Unable to resolve profile" }, env, 500);
        }

        const target = targets.find((t) => t.id === String(scoredJob.primary_target_id || "")) || null;
        const evidenceFirst = body.evidence_first === undefined ? true : toBool_(body.evidence_first, true);
        const evidenceLimit = clampInt_(body.evidence_limit || 12, 1, 30);

        let packData = null;
        try {
          const matchedEvidence = evidenceFirst
            ? await loadMatchedEvidenceForPack_(env, scoredJob.job_key, evidenceLimit)
            : [];
          packData = await generateApplicationPack_({
            env,
            ai: aiAuto,
            job: scoredJob,
            target,
            profile,
            renderer: rendererSafe,
            controls,
            matchedEvidence,
          });
        } catch (e) {
          packData = {
            status: "ERROR",
            error_text: String(e?.message || e).slice(0, 1000),
            pack_json: {
              job: { job_key: scoredJob.job_key, job_url: scoredJob.job_url, source_domain: scoredJob.source_domain, status: scoredJob.status },
              target: target || null,
              extracted: { role_title: scoredJob.role_title, company: scoredJob.company, location: scoredJob.location, seniority: scoredJob.seniority, final_score: scoredJob.final_score },
              tailoring: {
                summary: "",
                bullets: [],
                cover_letter: "",
                must_keywords: safeJsonParseArray_(scoredJob.must_have_keywords_json),
                nice_keywords: safeJsonParseArray_(scoredJob.nice_to_have_keywords_json),
              },
              renderer: rendererSafe,
            },
            ats_json: {
              score: 0,
              missing_keywords: safeJsonParseArray_(scoredJob.must_have_keywords_json).slice(0, 20),
              coverage: {},
              notes: "Pack generation failed. Retry later.",
            },
            rr_export_json: {},
            ats_score: 0,
          };
        }

        const saved = await persistResumeDraft_({
          env,
          jobKey: scoredJob.job_key,
          profileId: profile.id,
          pack: packData,
          force,
        });
        if (saved?.locked) {
          return json_({
            ok: true,
            data: {
              job_key: scoredJob.job_key,
              draft_id: saved.draft_id,
              profile_id: profile.id,
              profile_source: profileResolved.source,
              status: saved.locked_status || "READY_TO_APPLY",
              locked: true,
              message: "Draft is locked after approval. Use force=true to regenerate.",
            }
          }, env, 200);
        }
        const versionMeta = await createResumeDraftVersionFromLatest_(env, {
          draftId: saved.draft_id,
          jobKey: scoredJob.job_key,
          profileId: profile.id,
          sourceAction: force ? "regenerate" : "generate",
          controls,
        });

        const finishedAt = Date.now();
        await logEvent_(env, "AUTOPILOT_COMPLETED", jobKey, {
          final_score: finalScore,
          job_status: transition.status,
          pack_status: packData.status,
          profile_id: profile.id,
          profile_source: profileResolved.source,
          draft_id: saved.draft_id,
          version_id: versionMeta?.id || null,
          version_no: versionMeta?.version_no || null,
          ts: finishedAt,
        });

        return json_({
          ok: true,
          data: {
            job_key: scoredJob.job_key,
            score: {
              final_score: finalScore,
              status: transition.status,
              primary_target_id: pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
              potential_contacts: Array.isArray(pipelineResult.potential_contacts) ? pipelineResult.potential_contacts : [],
            },
            pack: {
              draft_id: saved.draft_id,
              profile_id: profile.id,
              profile_source: profileResolved.source,
              status: packData.status,
              ats_score: packData.ats_score,
              one_page_mode: controls.one_page_mode,
              one_pager_strict: Boolean(controls.one_pager_strict),
            },
            output: {
              summary: String(packData?.pack_json?.tailoring?.summary || ""),
              bullets: Array.isArray(packData?.pack_json?.tailoring?.bullets) ? packData.pack_json.tailoring.bullets : [],
              cover_letter: String(packData?.pack_json?.tailoring?.cover_letter || ""),
            },
            next_action: "review_and_copy",
            updated_at: finishedAt,
          }
        }, env, 200);
      }

      // ============================
      // UI: Checklist GET/POST
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/checklist") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const jobsSchema = await getJobsSchema_(env);
        if (!jobsSchema.hasChecklistFields) {
          return json_({ ok: false, error: "Checklist fields not enabled in DB schema" }, env, 400);
        }

        const row = await env.DB.prepare(`
          SELECT job_key, applied_note, follow_up_at, referral_status, applied_at
          FROM jobs WHERE job_key = ? LIMIT 1;
        `.trim()).bind(jobKey).first();

        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);
        return json_({ ok: true, data: row }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/checklist") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const jobsSchema = await getJobsSchema_(env);
        if (!jobsSchema.hasChecklistFields) {
          return json_({ ok: false, error: "Checklist fields not enabled in DB schema" }, env, 400);
        }

        const body = await request.json().catch(() => ({}));
        const appliedNote = String(body.applied_note || "").slice(0, 2000);
        const followUpAt = numOrNull_(body.follow_up_at);
        const referralStatus = String(body.referral_status || "").trim().slice(0, 50);

        const now = Date.now();
        const r = await env.DB.prepare(`
          UPDATE jobs SET
            applied_note = ?,
            follow_up_at = ?,
            referral_status = ?,
            updated_at = ?
          WHERE job_key = ?;
        `.trim()).bind(appliedNote, followUpAt, referralStatus, now, jobKey).run();

        if (!r.success || r.changes === 0) return json_({ ok: false, error: "Not found" }, env, 404);
        await logEvent_(env, "CHECKLIST_UPDATED", jobKey, { follow_up_at: followUpAt, referral_status: referralStatus, ts: now });
        return json_({ ok: true, data: { job_key: jobKey, updated_at: now } }, env, 200);
      }

      // ============================
      // UI: Resume payload (bridge-ready)
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/resume-payload") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const job = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        const payload = {
          job_key: job.job_key,
          company: job.company || null,
          role_title: job.role_title || null,
          location: job.location || null,
          source_domain: job.source_domain || null,
          primary_target_id: job.primary_target_id || null,
          final_score: job.final_score ?? null,
          skills_to_emphasize: safeJsonParseArray_(job.must_have_keywords_json).slice(0, 30),
          keywords: unique_(safeJsonParseArray_(job.must_have_keywords_json).concat(safeJsonParseArray_(job.nice_to_have_keywords_json))).slice(0, 60),
        };

        return json_({ ok: true, data: payload }, env, 200);
      }

      // ============================
      // UI: Outreach drafting
      // ============================
      if (
        path.startsWith("/jobs/") &&
        path.includes("/contacts/") &&
        path.endsWith("/draft") &&
        request.method === "POST"
      ) {
        const parts = path.split("/");
        const jobKey = decodeURIComponent(parts[2] || "").trim();
        const contactId = decodeURIComponent(parts[4] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        if (!contactId) return json_({ ok: false, error: "Missing contact_id" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const draftData = await draftOutreachForJob_(env, {
          job_key: jobKey,
          contact_id: contactId,
          profile_id: String(body.profile_id || body.profileId || "").trim(),
          channel: normalizeOutreachChannel_(body.channel || "LINKEDIN"),
          tone: String(body.tone || "professional").trim(),
          use_ai: toBool_(body.use_ai ?? body.useAi, true),
        });
        if (!draftData.ok) {
          return json_({ ok: false, error: draftData.error || "Failed to draft outreach." }, env, draftData.status || 400);
        }
        return json_({ ok: true, data: draftData.data }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/draft-outreach") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const contactId = String(body.contact_id || body.contactId || "").trim();
        const draftData = await draftOutreachForJob_(env, {
          job_key: jobKey,
          contact_id: contactId || null,
          profile_id: String(body.profile_id || body.profileId || "").trim(),
          channel: normalizeOutreachChannel_(body.channel || "LINKEDIN"),
          tone: String(body.tone || "professional").trim(),
          use_ai: toBool_(body.use_ai ?? body.useAi, true),
        });
        if (!draftData.ok) {
          return json_({ ok: false, error: draftData.error || "Failed to draft outreach." }, env, draftData.status || 400);
        }
        return json_({ ok: true, data: draftData.data }, env, 200);
      }

      if (
        path.startsWith("/jobs/") &&
        path.includes("/contacts/") &&
        path.endsWith("/touchpoint-status") &&
        request.method === "POST"
      ) {
        const parts = path.split("/");
        const jobKey = decodeURIComponent(parts[2] || "").trim();
        const contactId = decodeURIComponent(parts[4] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        if (!contactId) return json_({ ok: false, error: "Missing contact_id" }, env, 400);

        const storage = await hasContactsStorage_(env);
        if (!storage?.enabled) {
          return json_({ ok: false, error: "Contacts schema not enabled in DB." }, env, 400);
        }

        const job = await env.DB.prepare(`
          SELECT job_key
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(jobKey).first();
        if (!job?.job_key) return json_({ ok: false, error: "Not found" }, env, 404);

        const contact = await env.DB.prepare(`
          SELECT id, name
          FROM contacts
          WHERE id = ?
          LIMIT 1;
        `.trim()).bind(contactId).first();
        if (!contact?.id) return json_({ ok: false, error: "Contact not found" }, env, 404);

        const body = await request.json().catch(() => ({}));
        const statusRaw = String(body.status || "").trim().toUpperCase();
        const channelRaw = String(body.channel || "").trim().toUpperCase();
        if (statusRaw && !["DRAFT", "SENT", "REPLIED"].includes(statusRaw)) {
          return json_({ ok: false, error: "Invalid touchpoint status", allowed: ["DRAFT", "SENT", "REPLIED"] }, env, 400);
        }
        if (channelRaw && !["LINKEDIN", "EMAIL", "OTHER"].includes(channelRaw)) {
          return json_({ ok: false, error: "Invalid touchpoint channel", allowed: ["LINKEDIN", "EMAIL", "OTHER"] }, env, 400);
        }

        const touchpoint = await upsertOutreachTouchpointStatus_(env, {
          contact_id: contactId,
          job_key: jobKey,
          channel: channelRaw || "LINKEDIN",
          status: statusRaw || "DRAFT",
          content: String(body.content || "").trim(),
        });
        if (!touchpoint) return json_({ ok: false, error: "Failed to update touchpoint status." }, env, 500);

        await logEvent_(env, "OUTREACH_TOUCHPOINT_STATUS_UPDATED", jobKey, {
          contact_id: contactId,
          contact_name: String(contact.name || "").trim() || null,
          channel: touchpoint.channel,
          status: touchpoint.status,
          ts: Date.now(),
        });

        return json_({
          ok: true,
          data: {
            job_key: jobKey,
            contact_id: contactId,
            channel: touchpoint.channel,
            status: touchpoint.status,
            touchpoint,
          },
        }, env, 200);
      }

      // ============================
      // UI: Resume profiles
      // ============================
      if (path === "/resume/rr/health" && request.method === "GET") {
        const data = await probeReactiveResume_(env);
        await logEvent_(env, "RR_HEALTH_CHECK", null, {
          status: data?.status || "unknown",
          configured: Boolean(data?.configured),
          reachable: Boolean(data?.reachable),
          authenticated: data?.authenticated === true,
          http_status: Number.isFinite(Number(data?.http_status)) ? Number(data.http_status) : null,
          path: data?.matched_path || null,
          ts: Date.now(),
        });
        return json_({ ok: true, data }, env, 200);
      }

      if (path === "/resume/profiles" && request.method === "GET") {
        await ensurePrimaryProfile_(env);
        const res = await env.DB.prepare(`
          SELECT id, name, updated_at
          FROM resume_profiles
          ORDER BY updated_at DESC;
        `.trim()).all();
        return json_({ ok: true, data: res.results || [] }, env, 200);
      }

      if (path.startsWith("/resume/profiles/") && request.method === "GET") {
        const profileId = decodeURIComponent(path.split("/")[3] || "").trim();
        if (!profileId) return json_({ ok: false, error: "Missing profile id" }, env, 400);
        const row = await env.DB.prepare(`
          SELECT id, name, profile_json, updated_at
          FROM resume_profiles
          WHERE id = ?
          LIMIT 1;
        `.trim()).bind(profileId).first();
        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);
        return json_({
          ok: true,
          data: {
            id: row.id,
            name: row.name || row.id,
            profile_json: safeJsonParse_(row.profile_json) || {},
            updated_at: row.updated_at,
          }
        }, env, 200);
      }

      if (path === "/resume/profiles" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const id = String(body.id || body.profile_id || crypto.randomUUID()).trim().slice(0, 80);
        const name = String(body.name || "Primary").trim().slice(0, 120) || "Primary";
        const profileObj = (body.profile_json && typeof body.profile_json === "object")
          ? body.profile_json
          : safeJsonParse_(body.profile_json) || {};
        const now = Date.now();

        await env.DB.prepare(`
          INSERT INTO resume_profiles (id, name, profile_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            profile_json = excluded.profile_json,
            updated_at = excluded.updated_at;
        `.trim()).bind(id, name, JSON.stringify(profileObj), now, now).run();

        return json_({ ok: true, data: { id, name, updated_at: now } }, env, 200);
      }

      // ============================
      // UI: Generate application pack
      // ============================
      if (
        path.startsWith("/jobs/") &&
        (path.endsWith("/generate-application-pack") || path.endsWith("/generate-pack")) &&
        request.method === "POST"
      ) {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const force = Boolean(body.force);
        const renderer = String(body.renderer || "reactive_resume").trim().toLowerCase();
        const rendererSafe = (renderer === "html_simple" || renderer === "reactive_resume") ? renderer : "reactive_resume";
        const legacyOnePagerProvided = (body.one_pager_strict !== undefined || body.onePagerStrict !== undefined);
        const controls = {
          template_id: String(body.template_id || body.templateId || "").trim().slice(0, 80),
          enabled_blocks: Array.isArray(body.enabled_blocks)
            ? body.enabled_blocks
            : (Array.isArray(body.enabledBlocks) ? body.enabledBlocks : []),
          selected_keywords: Array.isArray(body.selected_keywords)
            ? body.selected_keywords
            : (Array.isArray(body.selectedKeywords) ? body.selectedKeywords : []),
          ats_target_mode: String(body.ats_target_mode || body.atsTargetMode || "").trim().toLowerCase(),
          one_page_mode: normalizeOnePageMode_(body.one_page_mode ?? body.onePageMode),
          one_pager_strict: toBool_(body.one_pager_strict ?? body.onePagerStrict, true),
          content_review_required: true,
        };

        const job = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        const resolvedOnePageMode = controls.one_page_mode || resolveDefaultOnePageMode_(job);
        controls.one_page_mode = resolvedOnePageMode;
        controls.one_pager_strict = legacyOnePagerProvided
          ? toBool_(body.one_pager_strict ?? body.onePagerStrict, true)
          : (resolvedOnePageMode === "hard");

        const profileResolved = await resolvePreferredProfileForJob_(env, {
          jobKey: job.job_key,
          profileIdIn: String(body.profile_id || body.profileId || "").trim(),
        });
        const profile = profileResolved.profile;
        if (!profile) {
          return json_({ ok: false, error: "Unable to resolve profile" }, env, 500);
        }

        const targets = await loadTargets_(env);
        const target = targets.find((t) => t.id === String(job.primary_target_id || "")) || null;
        const aiForPack = getAi_(env);
        const evidenceFirst = body.evidence_first === undefined ? true : toBool_(body.evidence_first, true);
        const evidenceLimit = clampInt_(body.evidence_limit || 12, 1, 30);

        let packData = null;
        try {
          const matchedEvidence = evidenceFirst
            ? await loadMatchedEvidenceForPack_(env, job.job_key, evidenceLimit)
            : [];
          packData = await generateApplicationPack_({
            env,
            ai: aiForPack || null,
            job,
            target,
            profile,
            renderer: rendererSafe,
            controls,
            matchedEvidence,
          });
        } catch (e) {
          packData = {
            status: aiForPack ? "ERROR" : "NEEDS_AI",
            error_text: String(e?.message || e).slice(0, 1000),
            pack_json: {
              job: { job_key: job.job_key, job_url: job.job_url, source_domain: job.source_domain, status: job.status },
              target: target || null,
              extracted: { role_title: job.role_title, company: job.company, location: job.location, seniority: job.seniority, final_score: job.final_score },
              tailoring: {
                summary: "",
                bullets: [],
                cover_letter: "",
                must_keywords: safeJsonParseArray_(job.must_have_keywords_json),
                nice_keywords: safeJsonParseArray_(job.nice_to_have_keywords_json),
              },
              renderer: rendererSafe,
            },
            ats_json: {
              score: 0,
              missing_keywords: safeJsonParseArray_(job.must_have_keywords_json).slice(0, 20),
              coverage: {},
              notes: "Pack generation failed. Retry later.",
              target_rubric: {
                template_id: "target_generic_v1",
                target_id: String(target?.id || "").trim() || null,
                target_name: String(target?.name || "").trim() || null,
                target_role: String(target?.primaryRole || target?.primary_role || "").trim() || null,
                applicable: true,
                score: null,
                dimensions: [],
                missing_evidence: [],
                notes: "Target rubric unavailable due to pack generation failure.",
              },
              pm_rubric: {
                applicable: /product manager|product management|product owner|\bpm\b/i.test(String(job.role_title || "")),
                score: null,
                dimensions: [],
                missing_evidence: [],
                notes: "PM rubric unavailable due to pack generation failure.",
              },
            },
            rr_export_json: {},
            ats_score: 0,
          };
        }

        const saved = await persistResumeDraft_({
          env,
          jobKey: job.job_key,
          profileId: profile.id,
          pack: packData,
          force,
        });
        if (saved?.locked) {
          return json_({
            ok: true,
            data: {
              job_key: job.job_key,
              draft_id: saved.draft_id,
              profile_id: profile.id,
              profile_source: profileResolved.source,
              status: saved.locked_status || "READY_TO_APPLY",
              locked: true,
              message: "Draft is locked after approval. Use force=true to regenerate.",
            }
          }, env, 200);
        }
        await createResumeDraftVersionFromLatest_(env, {
          draftId: saved.draft_id,
          jobKey: job.job_key,
          profileId: profile.id,
          sourceAction: force ? "regenerate" : "generate",
          controls,
        });

        await logEvent_(env, "APPLICATION_PACK_GENERATED", jobKey, {
          profile_id: profile.id,
          profile_source: profileResolved.source,
          status: packData.status,
          ats_score: packData.ats_score,
          evidence_first: evidenceFirst,
          evidence_match_count: Array.isArray(packData?.pack_json?.tailoring?.evidence_matches)
            ? packData.pack_json.tailoring.evidence_matches.length
            : 0,
          rr_export_contract_id: RR_EXPORT_CONTRACT_ID,
          rr_export_schema_version: RR_EXPORT_SCHEMA_VERSION,
          rr_export_import_ready: Boolean(packData?.rr_export_json?.metadata?.import_ready),
          ts: Date.now(),
        });

        return json_({
          ok: true,
          data: {
            job_key: job.job_key,
            draft_id: saved.draft_id,
            profile_id: profile.id,
            profile_source: profileResolved.source,
            status: packData.status,
            ats_score: packData.ats_score,
            template_id: controls.template_id || "",
            enabled_blocks_count: Array.isArray(controls.enabled_blocks) ? controls.enabled_blocks.length : 0,
            selected_keywords_count: Array.isArray(controls.selected_keywords) ? controls.selected_keywords.length : 0,
            one_page_mode: controls.one_page_mode,
            one_pager_strict: Boolean(controls.one_pager_strict),
            content_review_required: true,
            evidence_first: evidenceFirst,
            evidence_match_count: Array.isArray(packData?.pack_json?.tailoring?.evidence_matches)
              ? packData.pack_json.tailoring.evidence_matches.length
              : 0,
            rr_export_contract: {
              id: RR_EXPORT_CONTRACT_ID,
              schema_version: RR_EXPORT_SCHEMA_VERSION,
            },
            rr_export_import_ready: Boolean(packData?.rr_export_json?.metadata?.import_ready),
            rr_export_import_errors: Array.isArray(packData?.rr_export_json?.metadata?.import_errors)
              ? packData.rr_export_json.metadata.import_errors
              : [],
          }
        }, env, 200);
      }

      // ============================
      // UI: Get application pack
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/application-pack") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const requestedProfileId = String(url.searchParams.get("profile_id") || "").trim();
        const draftSchema = await getResumeDraftSchema_(env);

        let preference = { enabled: false, profile_id: "", updated_at: null };
        let lookupProfileId = requestedProfileId;
        let lookupSource = requestedProfileId ? "request" : "latest";
        if (!lookupProfileId) {
          preference = await getJobProfilePreference_(env, jobKey);
          if (preference.enabled && preference.profile_id) {
            lookupProfileId = String(preference.profile_id || "").trim();
            lookupSource = "job_preference";
          }
        }

        let row = null;
        if (lookupProfileId) {
          row = await env.DB.prepare(`
            SELECT * FROM resume_drafts
            WHERE job_key = ? AND profile_id = ?
            ORDER BY updated_at DESC
            LIMIT 1;
          `.trim()).bind(jobKey, lookupProfileId).first();
        }
        if (!row && !requestedProfileId) {
          row = await env.DB.prepare(`
            SELECT * FROM resume_drafts
            WHERE job_key = ?
            ORDER BY updated_at DESC
            LIMIT 1;
          `.trim()).bind(jobKey).first();
          if (row) lookupSource = "latest";
        }

        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);

        const packJson = safeJsonParse_(row.pack_json) || {};
        const atsJson = safeJsonParse_(row.ats_json) || {};
        const rrExportJson = ensureReactiveResumeExportContract_(
          safeJsonParse_(row.rr_export_json) || {},
          {
            jobKey: row.job_key,
            templateId: String(packJson?.controls?.template_id || ""),
          }
        );
        const jobRow = await env.DB.prepare(`
          SELECT job_key, role_title, company, status, system_status, jd_text_clean, fetch_debug_json
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(row.job_key).first();
        const pdfReadiness = evaluatePdfReadiness_(env, {
          job: jobRow || {},
          packJson,
          atsJson,
          rrExportJson,
        });
        const rrResumeId = draftSchema.hasRrPushFields
          ? (String(row.rr_resume_id || "").trim() || null)
          : null;
        const rrLastPushedAt = draftSchema.hasRrPushFields
          ? numOrNull_(row.rr_last_pushed_at)
          : null;
        const rrLastPushStatus = draftSchema.hasRrPushFields
          ? (String(row.rr_last_push_status || "").trim() || null)
          : null;
        const rrLastPushError = draftSchema.hasRrPushFields
          ? String(row.rr_last_push_error || "").trim()
          : "";
        const rrPdfUrl = draftSchema.hasRrPdfFields
          ? (String(row.rr_pdf_url || "").trim() || null)
          : null;
        const rrPdfLastExportedAt = draftSchema.hasRrPdfFields
          ? numOrNull_(row.rr_pdf_last_exported_at)
          : null;
        const rrPdfLastExportStatus = draftSchema.hasRrPdfFields
          ? (String(row.rr_pdf_last_export_status || "").trim() || null)
          : null;
        const rrPdfLastExportError = draftSchema.hasRrPdfFields
          ? String(row.rr_pdf_last_export_error || "").trim()
          : "";
        const versionsEnabled = await hasResumeDraftVersions_(env);
        const latestVersion = versionsEnabled
          ? await env.DB.prepare(`
              SELECT id, version_no, source_action, created_at
              FROM resume_draft_versions
              WHERE draft_id = ?
              ORDER BY version_no DESC
              LIMIT 1;
            `.trim()).bind(row.id).first()
          : null;
        const onePageMode = normalizeOnePageMode_(packJson?.controls?.one_page_mode) || null;
        const contentReviewRequired = toBool_(packJson?.controls?.content_review_required, true);

        return json_({
          ok: true,
          data: {
            id: row.id,
            job_key: row.job_key,
            profile_id: row.profile_id,
            profile_lookup_source: lookupSource,
            requested_profile_id: requestedProfileId || null,
            preference_profile_id: String(preference.profile_id || "").trim() || null,
            status: row.status,
            error_text: row.error_text || "",
            pack_json: packJson,
            ats_json: atsJson,
            rr_export_json: rrExportJson,
            rr_export_contract: {
              id: RR_EXPORT_CONTRACT_ID,
              schema_version: RR_EXPORT_SCHEMA_VERSION,
            },
            rr_export_import_ready: Boolean(rrExportJson?.metadata?.import_ready),
            rr_export_import_errors: Array.isArray(rrExportJson?.metadata?.import_errors)
              ? rrExportJson.metadata.import_errors
              : [],
            rr_resume_id: rrResumeId,
            rr_last_pushed_at: rrLastPushedAt,
            rr_last_push_status: rrLastPushStatus,
            rr_last_push_error: rrLastPushError,
            rr_pdf_url: rrPdfUrl,
            rr_pdf_last_exported_at: rrPdfLastExportedAt,
            rr_pdf_last_export_status: rrPdfLastExportStatus,
            rr_pdf_last_export_error: rrPdfLastExportError,
            pdf_readiness: pdfReadiness,
            one_page_mode: onePageMode,
            content_review_required: contentReviewRequired,
            latest_version: latestVersion
              ? {
                id: latestVersion.id,
                version_no: numOrNull_(latestVersion.version_no),
                source_action: String(latestVersion.source_action || "").trim(),
                created_at: numOrNull_(latestVersion.created_at),
              }
              : null,
            version_history_enabled: versionsEnabled,
            rr_base_url: getReactiveResumeBaseUrl_(env),
            updated_at: row.updated_at,
          }
        }, env, 200);
      }

      // ============================
      // UI: Application pack versions
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/application-pack/versions") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const profileId = String(url.searchParams.get("profile_id") || "").trim();
        const limit = clampInt_(url.searchParams.get("limit") || 20, 1, 100);
        const rows = await listDraftVersions_(env, { jobKey, profileId, limit });
        return json_({
          ok: true,
          data: rows,
          meta: {
            job_key: jobKey,
            profile_id: profileId || null,
            limit,
            versions_enabled: await hasResumeDraftVersions_(env),
          },
        }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/application-pack/review") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const profileId = String(body.profile_id || body.profileId || "").trim();
        const summaryRaw = String(body.summary || "").trim();
        const coverLetterRaw = String(body.cover_letter || body.coverLetter || "").trim();
        const bulletsInput = Array.isArray(body.bullets)
          ? body.bullets
          : String(body.bullets_text || body.bulletsText || "")
            .split(/\r?\n+/g)
            .map((x) => x.trim())
            .filter(Boolean);
        const bulletsRaw = Array.isArray(bulletsInput)
          ? bulletsInput.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        if (!summaryRaw) {
          return json_({ ok: false, error: "summary is required" }, env, 400);
        }
        if (!bulletsRaw.length) {
          return json_({ ok: false, error: "bullets are required" }, env, 400);
        }

        const row = profileId
          ? await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ? AND profile_id = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey, profileId).first()
          : await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey).first();

        if (!row) {
          return json_({ ok: false, error: "Application pack not found. Generate pack first." }, env, 404);
        }

        const packJson = safeJsonParse_(row.pack_json) || {};
        const atsJsonPrev = safeJsonParse_(row.ats_json) || {};
        const rrJsonPrev = safeJsonParse_(row.rr_export_json) || {};
        const controlsPrev = (packJson?.controls && typeof packJson.controls === "object") ? packJson.controls : {};
        const selectedKeywords = Array.isArray(body.selected_keywords)
          ? body.selected_keywords.map((x) => String(x || "").trim()).filter(Boolean)
          : (Array.isArray(controlsPrev.selected_keywords) ? controlsPrev.selected_keywords : []);
        const enabledBlocks = Array.isArray(body.enabled_blocks)
          ? body.enabled_blocks.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
          : (Array.isArray(controlsPrev.enabled_blocks) ? controlsPrev.enabled_blocks : ["summary", "experience", "skills", "highlights", "bullets"]);
        const templateId = String(body.template_id || body.templateId || controlsPrev.template_id || "balanced").trim().slice(0, 80) || "balanced";
        const atsTargetMode = String(body.ats_target_mode || body.atsTargetMode || controlsPrev.ats_target_mode || "all").trim().toLowerCase() || "all";
        const onePageMode = normalizeOnePageMode_(body.one_page_mode ?? body.onePageMode)
          || normalizeOnePageMode_(controlsPrev.one_page_mode)
          || resolveDefaultOnePageMode_(packJson?.job || {});
        const onePagerStrict = (body.one_pager_strict !== undefined || body.onePagerStrict !== undefined)
          ? toBool_(body.one_pager_strict ?? body.onePagerStrict, onePageMode === "hard")
          : (onePageMode === "hard");
        const capped = applyOnePageCaps_(summaryRaw, bulletsRaw);

        packJson.tailoring = {
          ...(packJson.tailoring && typeof packJson.tailoring === "object" ? packJson.tailoring : {}),
          summary: enabledBlocks.includes("summary") ? capped.summary : "",
          bullets: enabledBlocks.includes("bullets") ? capped.bullets : [],
          cover_letter: coverLetterRaw || String(packJson?.tailoring?.cover_letter || "").trim(),
        };
        packJson.controls = {
          ...controlsPrev,
          template_id: templateId,
          enabled_blocks: enabledBlocks,
          selected_keywords: selectedKeywords,
          ats_target_mode: atsTargetMode,
          one_page_mode: onePageMode,
          one_pager_strict: onePagerStrict,
          content_review_required: true,
        };

        let rrExport = ensureReactiveResumeExportContract_(rrJsonPrev, {
          jobKey: row.job_key,
          templateId,
        });
        rrExport.basics = {
          ...(rrExport.basics && typeof rrExport.basics === "object" ? rrExport.basics : {}),
          summary: String(packJson.tailoring.summary || ""),
        };
        rrExport.sections = {
          ...(rrExport.sections && typeof rrExport.sections === "object" ? rrExport.sections : {}),
          highlights: Array.isArray(packJson.tailoring.bullets)
            ? packJson.tailoring.bullets.map((x) => ({ text: String(x || "").trim() })).filter((x) => x.text).slice(0, onePagerStrict ? 4 : 8)
            : [],
        };
        rrExport.metadata = {
          ...(rrExport.metadata && typeof rrExport.metadata === "object" ? rrExport.metadata : {}),
          template_id: templateId,
          one_page_mode: onePageMode,
          one_pager_strict: onePagerStrict,
        };
        rrExport = ensureReactiveResumeExportContract_(rrExport, {
          jobKey: row.job_key,
          templateId,
        });

        const atsJson = recomputeReviewedAts_(packJson, atsJsonPrev);
        const jobRow = await env.DB.prepare(`
          SELECT job_key, role_title, company, status, system_status, jd_text_clean, fetch_debug_json
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(row.job_key).first();
        const pdfReadiness = evaluatePdfReadiness_(env, {
          job: jobRow || {},
          packJson,
          atsJson,
          rrExportJson: rrExport,
        });
        const reviewedStatus = (pdfReadiness.ready || !pdfReadiness.hard_gate_applied)
          ? "READY_FOR_EXPORT"
          : "CONTENT_REVIEW_REQUIRED";
        const now = Date.now();

        await env.DB.prepare(`
          UPDATE resume_drafts
          SET pack_json = ?, ats_json = ?, rr_export_json = ?, status = ?, error_text = NULL, updated_at = ?
          WHERE id = ?;
        `.trim()).bind(
          JSON.stringify(packJson),
          JSON.stringify(atsJson),
          JSON.stringify(rrExport),
          reviewedStatus,
          now,
          row.id
        ).run();

        const versionMeta = await insertDraftVersion_(env, {
          jobKey: row.job_key,
          profileId: row.profile_id,
          draftId: row.id,
          sourceAction: "manual_edit",
          packJson,
          atsJson,
          rrExportJson: rrExport,
          controlsJson: packJson.controls || {},
          status: reviewedStatus,
          errorText: "",
          createdAt: now,
        });

        await logEvent_(env, "APPLICATION_PACK_REVIEWED", jobKey, {
          profile_id: row.profile_id,
          draft_id: row.id,
          version_id: versionMeta?.id || null,
          version_no: versionMeta?.version_no || null,
          one_page_mode: onePageMode,
          hard_gate_applied: Boolean(pdfReadiness?.hard_gate_applied),
          ats_score: numOrNull_(atsJson?.score),
          ts: now,
        });

        return json_({
          ok: true,
          data: {
            job_key: row.job_key,
            profile_id: row.profile_id,
            draft_id: row.id,
            status: reviewedStatus,
            ats_score: numOrNull_(atsJson?.score),
            pdf_readiness: pdfReadiness,
            version_id: versionMeta?.id || null,
            version_no: versionMeta?.version_no || null,
          },
        }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/approve-pack") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const profileId = String(body.profile_id || body.profileId || "").trim();

        const row = profileId
          ? await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ? AND profile_id = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey, profileId).first()
          : await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey).first();

        if (!row) {
          return json_({ ok: false, error: "Application pack not found. Generate pack first." }, env, 404);
        }

        const packJson = safeJsonParse_(row.pack_json) || {};
        const atsJsonPrev = safeJsonParse_(row.ats_json) || {};
        const rrJsonPrev = safeJsonParse_(row.rr_export_json) || {};
        const controlsPrev = (packJson?.controls && typeof packJson.controls === "object") ? packJson.controls : {};
        const tailoringPrev = (packJson?.tailoring && typeof packJson.tailoring === "object") ? packJson.tailoring : {};

        const summaryRaw = String(body.summary || tailoringPrev.summary || "").trim();
        const coverLetterRaw = String(body.cover_letter || body.coverLetter || tailoringPrev.cover_letter || "").trim();
        const bulletsInput = Array.isArray(body.bullets)
          ? body.bullets
          : (Array.isArray(tailoringPrev.bullets) ? tailoringPrev.bullets : []);
        const bulletsRaw = Array.isArray(bulletsInput)
          ? bulletsInput.map((x) => String(x || "").trim()).filter(Boolean)
          : [];

        if (!summaryRaw) return json_({ ok: false, error: "summary is required" }, env, 400);
        if (!coverLetterRaw) return json_({ ok: false, error: "cover_letter is required" }, env, 400);

        const onePageMode = normalizeOnePageMode_(body.one_page_mode ?? body.onePageMode)
          || normalizeOnePageMode_(controlsPrev.one_page_mode)
          || resolveDefaultOnePageMode_(packJson?.job || {});
        const onePagerStrict = (body.one_pager_strict !== undefined || body.onePagerStrict !== undefined)
          ? toBool_(body.one_pager_strict ?? body.onePagerStrict, onePageMode === "hard")
          : (onePageMode === "hard");

        const capped = applyOnePageCaps_(summaryRaw, bulletsRaw);
        packJson.tailoring = {
          ...tailoringPrev,
          summary: capped.summary,
          bullets: capped.bullets,
          cover_letter: coverLetterRaw,
        };
        packJson.controls = {
          ...controlsPrev,
          one_page_mode: onePageMode,
          one_pager_strict: onePagerStrict,
          content_review_required: false,
          approved_at: Date.now(),
        };

        let rrExport = ensureReactiveResumeExportContract_(rrJsonPrev, {
          jobKey: row.job_key,
          templateId: String(packJson?.controls?.template_id || ""),
        });
        rrExport.basics = {
          ...(rrExport.basics && typeof rrExport.basics === "object" ? rrExport.basics : {}),
          summary: String(packJson.tailoring.summary || ""),
        };
        rrExport.sections = {
          ...(rrExport.sections && typeof rrExport.sections === "object" ? rrExport.sections : {}),
          highlights: Array.isArray(packJson.tailoring.bullets)
            ? packJson.tailoring.bullets.map((x) => ({ text: String(x || "").trim() })).filter((x) => x.text).slice(0, onePagerStrict ? 4 : 8)
            : [],
        };
        rrExport.metadata = {
          ...(rrExport.metadata && typeof rrExport.metadata === "object" ? rrExport.metadata : {}),
          one_page_mode: onePageMode,
          one_pager_strict: onePagerStrict,
        };
        rrExport = ensureReactiveResumeExportContract_(rrExport, {
          jobKey: row.job_key,
          templateId: String(packJson?.controls?.template_id || ""),
        });

        const atsJson = recomputeReviewedAts_(packJson, atsJsonPrev);
        const jobRow = await env.DB.prepare(`
          SELECT job_key, role_title, company, status, system_status, jd_text_clean, fetch_debug_json
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(row.job_key).first();
        const pdfReadiness = evaluatePdfReadiness_(env, {
          job: jobRow || {},
          packJson,
          atsJson,
          rrExportJson: rrExport,
        });

        const approvedStatus = "READY_TO_APPLY";
        const now = Date.now();
        await env.DB.prepare(`
          UPDATE resume_drafts
          SET pack_json = ?, ats_json = ?, rr_export_json = ?, status = ?, error_text = NULL, updated_at = ?
          WHERE id = ?;
        `.trim()).bind(
          JSON.stringify(packJson),
          JSON.stringify(atsJson),
          JSON.stringify(rrExport),
          approvedStatus,
          now,
          row.id
        ).run();

        await env.DB.prepare(`
          UPDATE jobs
          SET status = ?, system_status = ?, updated_at = ?
          WHERE job_key = ?;
        `.trim()).bind(
          approvedStatus,
          approvedStatus,
          now,
          row.job_key
        ).run();

        const versionMeta = await insertDraftVersion_(env, {
          jobKey: row.job_key,
          profileId: row.profile_id,
          draftId: row.id,
          sourceAction: "approve",
          packJson,
          atsJson,
          rrExportJson: rrExport,
          controlsJson: packJson.controls || {},
          status: approvedStatus,
          errorText: "",
          createdAt: now,
        });

        await logEvent_(env, "APPLICATION_PACK_APPROVED", jobKey, {
          profile_id: row.profile_id,
          draft_id: row.id,
          version_id: versionMeta?.id || null,
          version_no: versionMeta?.version_no || null,
          ats_score: numOrNull_(atsJson?.score),
          pdf_ready: Boolean(pdfReadiness?.ready),
          hard_gate_applied: Boolean(pdfReadiness?.hard_gate_applied),
          ts: now,
        });
        await logEvent_(env, "PACK_APPROVED", jobKey, {
          profile_id: row.profile_id,
          draft_id: row.id,
          version_id: versionMeta?.id || null,
          version_no: versionMeta?.version_no || null,
          ats_score: numOrNull_(atsJson?.score),
          ts: now,
        });

        return json_({
          ok: true,
          data: {
            job_key: row.job_key,
            profile_id: row.profile_id,
            draft_id: row.id,
            status: approvedStatus,
            ats_score: numOrNull_(atsJson?.score),
            pdf_readiness: pdfReadiness,
            version_id: versionMeta?.id || null,
            version_no: versionMeta?.version_no || null,
          },
        }, env, 200);
      }

      if (path.startsWith("/jobs/") && path.endsWith("/application-pack/revert") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const body = await request.json().catch(() => ({}));
        const profileId = String(body.profile_id || body.profileId || "").trim();
        const versionId = String(body.version_id || body.versionId || "").trim();
        if (!versionId) return json_({ ok: false, error: "Missing version_id" }, env, 400);

        const restored = await restoreDraftVersion_(env, {
          jobKey,
          profileId,
          versionId,
        });
        if (!restored) {
          return json_({ ok: false, error: "Version not found" }, env, 404);
        }

        await logEvent_(env, "APPLICATION_PACK_REVERTED", jobKey, {
          profile_id: restored.profile_id,
          draft_id: restored.draft_id,
          version_id: restored.version_id,
          restored_version_no: restored.version_no,
          ts: Date.now(),
        });

        return json_({
          ok: true,
          data: restored,
        }, env, 200);
      }

      // ============================
      // UI: Push application pack to Reactive Resume
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/push-reactive-resume") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const draftSchema = await getResumeDraftSchema_(env);

        const body = await request.json().catch(() => ({}));
        const profileId = String(body.profile_id || body.profileId || "").trim();
        const row = profileId
          ? await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ? AND profile_id = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey, profileId).first()
          : await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey).first();

        if (!row) {
          return json_({ ok: false, error: "Application pack not found. Generate pack first." }, env, 404);
        }

        const packJson = safeJsonParse_(row.pack_json) || {};
        const rrExport = ensureReactiveResumeExportContract_(
          safeJsonParse_(row.rr_export_json) || {},
          {
            jobKey: row.job_key,
            templateId: String(packJson?.controls?.template_id || ""),
          }
        );
        if (!Boolean(rrExport?.metadata?.import_ready)) {
          return json_({
            ok: false,
            error: "RR export is not import-ready",
            data: {
              rr_export_import_errors: Array.isArray(rrExport?.metadata?.import_errors)
                ? rrExport.metadata.import_errors
                : [],
            }
          }, env, 400);
        }

        const existingResumeId = draftSchema.hasRrPushFields
          ? String(row.rr_resume_id || "").trim()
          : "";
        const rrPush = await pushReactiveResume_(env, {
          rrExport,
          titleHint: `${String(packJson?.extracted?.role_title || "").trim()} ${String(packJson?.extracted?.company || "").trim()}`.trim(),
          resumeId: existingResumeId,
        });
        const pushedAt = Date.now();
        if (!rrPush.ok) {
          if (draftSchema.hasRrPushFields) {
            await env.DB.prepare(`
              UPDATE resume_drafts
              SET rr_last_pushed_at = ?, rr_last_push_status = ?, rr_last_push_error = ?, updated_at = ?
              WHERE id = ?;
            `.trim()).bind(
              pushedAt,
              "ERROR",
              String(rrPush.error || "Reactive Resume push failed").slice(0, 1000),
              pushedAt,
              row.id
            ).run();
          }
          return json_({
            ok: false,
            error: rrPush.error || "Reactive Resume push failed",
            data: {
              http_status: rrPush.http_status,
              import_path: rrPush.import_path || null,
            },
          }, env, rrPush.http_status && rrPush.http_status >= 400 ? rrPush.http_status : 502);
        }
        const rrResumeId = String(rrPush.resume_id || existingResumeId || "").trim() || null;
        if (draftSchema.hasRrPushFields) {
          await env.DB.prepare(`
            UPDATE resume_drafts
            SET rr_resume_id = ?, rr_last_pushed_at = ?, rr_last_push_status = ?, rr_last_push_error = NULL, updated_at = ?
            WHERE id = ?;
          `.trim()).bind(
            rrResumeId,
            pushedAt,
            "SUCCESS",
            pushedAt,
            row.id
          ).run();
        }

        await logEvent_(env, "RR_PUSH", jobKey, {
          profile_id: row.profile_id,
          draft_id: row.id,
          rr_resume_id: rrResumeId,
          import_path: rrPush.import_path,
          http_status: rrPush.http_status,
          mode: rrPush.mode || null,
          ts: Date.now(),
        });

        return json_({
          ok: true,
          data: {
            job_key: row.job_key,
            profile_id: row.profile_id,
            draft_id: row.id,
            rr_resume_id: rrResumeId,
            rr_import_path: rrPush.import_path,
            rr_http_status: rrPush.http_status,
            rr_push_adapter: rrPush.adapter || "jobops_rr_export",
            rr_push_mode: rrPush.mode || "imported_new",
            rr_last_pushed_at: pushedAt,
            rr_last_push_status: "SUCCESS",
            rr_base_url: getReactiveResumeBaseUrl_(env),
            pushed_at: pushedAt,
          }
        }, env, 200);
      }

      // ============================
      // UI: Export Reactive Resume PDF
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/export-reactive-resume-pdf") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const draftSchema = await getResumeDraftSchema_(env);

        const body = await request.json().catch(() => ({}));
        const profileId = String(body.profile_id || body.profileId || "").trim();
        const force = Boolean(body.force);
        const row = profileId
          ? await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ? AND profile_id = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey, profileId).first()
          : await env.DB.prepare(`
              SELECT * FROM resume_drafts
              WHERE job_key = ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `.trim()).bind(jobKey).first();

        if (!row) {
          return json_({ ok: false, error: "Application pack not found. Generate pack first." }, env, 404);
        }

        const packJson = safeJsonParse_(row.pack_json) || {};
        const rrExport = ensureReactiveResumeExportContract_(
          safeJsonParse_(row.rr_export_json) || {},
          {
            jobKey: row.job_key,
            templateId: String(packJson?.controls?.template_id || ""),
          }
        );
        const atsJson = safeJsonParse_(row.ats_json) || {};
        const jobRow = await env.DB.prepare(`
          SELECT job_key, role_title, company, status, system_status, jd_text_clean, fetch_debug_json
          FROM jobs
          WHERE job_key = ?
          LIMIT 1;
        `.trim()).bind(row.job_key).first();
        const pdfReadiness = evaluatePdfReadiness_(env, {
          job: jobRow || {},
          packJson,
          atsJson,
          rrExportJson: rrExport,
        });
        if (!pdfReadiness.ready) {
          const exportTs = Date.now();
          const firstIssue = pdfReadiness.failed_checks?.[0]?.detail || pdfReadiness.failed_checks?.[0]?.id || "readiness_gate_failed";
          if (draftSchema.hasRrPdfFields) {
            await env.DB.prepare(`
              UPDATE resume_drafts
              SET rr_pdf_last_exported_at = ?, rr_pdf_last_export_status = ?, rr_pdf_last_export_error = ?, updated_at = ?
              WHERE id = ?;
            `.trim()).bind(
              exportTs,
              "BLOCKED",
              String(firstIssue).slice(0, 1000),
              exportTs,
              row.id
            ).run();
          }
          return json_({
            ok: false,
            error: "PDF readiness gate failed",
            data: { pdf_readiness: pdfReadiness },
          }, env, 400);
        }
        if (!Boolean(rrExport?.metadata?.import_ready)) {
          return json_({
            ok: false,
            error: "RR export is not import-ready",
            data: {
              rr_export_import_errors: Array.isArray(rrExport?.metadata?.import_errors)
                ? rrExport.metadata.import_errors
                : [],
            }
          }, env, 400);
        }

        let rrResumeId = draftSchema.hasRrPushFields
          ? String(row.rr_resume_id || "").trim()
          : "";
        if (!rrResumeId || force) {
          const rrPush = await pushReactiveResume_(env, {
            rrExport,
            titleHint: `${String(packJson?.extracted?.role_title || "").trim()} ${String(packJson?.extracted?.company || "").trim()}`.trim(),
            resumeId: rrResumeId,
          });
          const pushTs = Date.now();
          if (!rrPush.ok) {
            if (draftSchema.hasRrPushFields) {
              await env.DB.prepare(`
                UPDATE resume_drafts
                SET rr_last_pushed_at = ?, rr_last_push_status = ?, rr_last_push_error = ?, updated_at = ?
                WHERE id = ?;
              `.trim()).bind(
                pushTs,
                "ERROR",
                String(rrPush.error || "Reactive Resume push failed").slice(0, 1000),
                pushTs,
                row.id
              ).run();
            }
            if (draftSchema.hasRrPdfFields) {
              await env.DB.prepare(`
                UPDATE resume_drafts
                SET rr_pdf_last_exported_at = ?, rr_pdf_last_export_status = ?, rr_pdf_last_export_error = ?, updated_at = ?
                WHERE id = ?;
              `.trim()).bind(
                pushTs,
                "ERROR",
                String(rrPush.error || "Reactive Resume push failed before PDF export").slice(0, 1000),
                pushTs,
                row.id
              ).run();
            }
            return json_({
              ok: false,
              error: rrPush.error || "Reactive Resume push failed",
              data: {
                rr_push_mode: rrPush.mode || null,
                http_status: rrPush.http_status || null,
              },
            }, env, rrPush.http_status && rrPush.http_status >= 400 ? rrPush.http_status : 502);
          }
          rrResumeId = String(rrPush.resume_id || "").trim();
          if (draftSchema.hasRrPushFields) {
            await env.DB.prepare(`
              UPDATE resume_drafts
              SET rr_resume_id = ?, rr_last_pushed_at = ?, rr_last_push_status = ?, rr_last_push_error = NULL, updated_at = ?
              WHERE id = ?;
            `.trim()).bind(
              rrResumeId || null,
              pushTs,
              "SUCCESS",
              pushTs,
              row.id
            ).run();
          }
        }

        if (!rrResumeId) {
          return json_({ ok: false, error: "No Reactive Resume id available for PDF export." }, env, 400);
        }

        const rrPdf = await exportReactiveResumePdf_(env, { resumeId: rrResumeId });
        const exportTs = Date.now();
        if (!rrPdf.ok) {
          if (draftSchema.hasRrPdfFields) {
            await env.DB.prepare(`
              UPDATE resume_drafts
              SET rr_pdf_last_exported_at = ?, rr_pdf_last_export_status = ?, rr_pdf_last_export_error = ?, updated_at = ?
              WHERE id = ?;
            `.trim()).bind(
              exportTs,
              "ERROR",
              String(rrPdf.error || "Reactive Resume PDF export failed").slice(0, 1000),
              exportTs,
              row.id
            ).run();
          }
          return json_({
            ok: false,
            error: rrPdf.error || "Reactive Resume PDF export failed",
            data: {
              rr_resume_id: rrResumeId,
              http_status: rrPdf.http_status || null,
            },
          }, env, rrPdf.http_status && rrPdf.http_status >= 400 ? rrPdf.http_status : 502);
        }

        if (draftSchema.hasRrPdfFields) {
          await env.DB.prepare(`
            UPDATE resume_drafts
            SET rr_pdf_url = ?, rr_pdf_last_exported_at = ?, rr_pdf_last_export_status = ?, rr_pdf_last_export_error = NULL, updated_at = ?
            WHERE id = ?;
          `.trim()).bind(
            String(rrPdf.pdf_url || "").trim() || null,
            exportTs,
            "SUCCESS",
            exportTs,
            row.id
          ).run();
        }
        await createResumeDraftVersionFromLatest_(env, {
          draftId: row.id,
          jobKey: row.job_key,
          profileId: row.profile_id,
          sourceAction: "pdf_export",
        });

        await logEvent_(env, "RR_PDF_EXPORTED", jobKey, {
          profile_id: row.profile_id,
          draft_id: row.id,
          rr_resume_id: rrResumeId,
          http_status: rrPdf.http_status || null,
          ts: exportTs,
        });

        return json_({
          ok: true,
          data: {
            job_key: row.job_key,
            profile_id: row.profile_id,
            draft_id: row.id,
            rr_resume_id: rrResumeId,
            rr_pdf_url: String(rrPdf.pdf_url || "").trim() || null,
            rr_pdf_last_exported_at: exportTs,
            rr_pdf_last_export_status: "SUCCESS",
            rr_base_url: getReactiveResumeBaseUrl_(env),
          }
        }, env, 200);
      }

      // ============================
      // UI: Targets list
      // ============================
      if (path === "/targets" && request.method === "GET") {
        const targetSchema = await getTargetsSchema_(env);
        const rejectSelect = targetSchema.hasRejectKeywords ? "reject_keywords_json" : "'[]' AS reject_keywords_json";
        const rubricSelect = targetSchema.hasRubricProfile ? "rubric_profile" : "'auto' AS rubric_profile";
        const res = await env.DB.prepare(`
          SELECT id, name, primary_role, seniority_pref, location_pref,
                 must_keywords_json, nice_keywords_json, ${rejectSelect}, ${rubricSelect},
                 updated_at, created_at
          FROM targets
          ORDER BY updated_at DESC;
        `.trim()).all();

        const rows = (res.results || []).map((r) => ({
          ...r,
          must_keywords: safeJsonParseArray_(r.must_keywords_json),
          nice_keywords: safeJsonParseArray_(r.nice_keywords_json),
          reject_keywords: safeJsonParseArray_(r.reject_keywords_json),
          rubric_profile: normalizeRubricProfile_(r.rubric_profile || "auto"),
        }));

        return json_({
          ok: true,
          data: rows,
          meta: {
            reject_keywords_enabled: targetSchema.hasRejectKeywords,
            rubric_profile_enabled: targetSchema.hasRubricProfile,
          }
        }, env, 200);
      }

      // ============================
      // UI: Target detail
      // ============================
      if (path.startsWith("/targets/") && request.method === "GET") {
        const targetId = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!targetId) return json_({ ok: false, error: "Missing target id" }, env, 400);
        const targetSchema = await getTargetsSchema_(env);
        const rejectSelect = targetSchema.hasRejectKeywords ? "reject_keywords_json" : "'[]' AS reject_keywords_json";
        const rubricSelect = targetSchema.hasRubricProfile ? "rubric_profile" : "'auto' AS rubric_profile";

        const row = await env.DB.prepare(`
          SELECT id, name, primary_role, seniority_pref, location_pref,
                 must_keywords_json, nice_keywords_json, ${rejectSelect}, ${rubricSelect},
                 updated_at, created_at
          FROM targets WHERE id = ? LIMIT 1;
        `.trim()).bind(targetId).first();

        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);

        row.must_keywords = safeJsonParseArray_(row.must_keywords_json);
        row.nice_keywords = safeJsonParseArray_(row.nice_keywords_json);
        row.reject_keywords = safeJsonParseArray_(row.reject_keywords_json);
        row.rubric_profile = normalizeRubricProfile_(row.rubric_profile || "auto");

        return json_({
          ok: true,
          data: row,
          meta: {
            reject_keywords_enabled: targetSchema.hasRejectKeywords,
            rubric_profile_enabled: targetSchema.hasRubricProfile,
          }
        }, env, 200);
      }

      // ============================
      // UI: Update target
      // ============================
      if (path.startsWith("/targets/") && request.method === "POST") {
        const targetId = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!targetId) return json_({ ok: false, error: "Missing target id" }, env, 400);

        const body = await request.json().catch(() => ({}));

        const name = String(body.name || "").trim().slice(0, 120);
        const primaryRole = String(body.primary_role || body.primaryRole || "").trim().slice(0, 200);
        const seniorityPref = String(body.seniority_pref || body.seniorityPref || "").trim().slice(0, 120);
        const locationPref = String(body.location_pref || body.locationPref || "").trim().slice(0, 200);
        const rubricProfile = normalizeRubricProfile_(
          body.rubric_profile ?? body.rubricProfile ?? "auto"
        );

        // Keywords: accept array OR string with commas/newlines
        const must = normalizeKeywords_(body.must_keywords ?? body.must_keywords_json ?? []);
        const nice = normalizeKeywords_(body.nice_keywords ?? body.nice_keywords_json ?? []);
        const reject = normalizeKeywords_(body.reject_keywords ?? body.reject_keywords_json ?? []);
        const targetSchema = await getTargetsSchema_(env);

        const now = Date.now();
        const r = (targetSchema.hasRejectKeywords && targetSchema.hasRubricProfile)
          ? await env.DB.prepare(`
              INSERT INTO targets (
                id, name, primary_role, seniority_pref, location_pref, rubric_profile,
                must_keywords_json, nice_keywords_json, reject_keywords_json,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), targets.name),
                primary_role = COALESCE(NULLIF(excluded.primary_role, ''), targets.primary_role),
                seniority_pref = COALESCE(NULLIF(excluded.seniority_pref, ''), targets.seniority_pref),
                location_pref = COALESCE(NULLIF(excluded.location_pref, ''), targets.location_pref),
                rubric_profile = excluded.rubric_profile,
                must_keywords_json = excluded.must_keywords_json,
                nice_keywords_json = excluded.nice_keywords_json,
                reject_keywords_json = excluded.reject_keywords_json,
                updated_at = excluded.updated_at;
            `.trim()).bind(
            targetId,
            name || targetId,
            primaryRole,
            seniorityPref,
            locationPref,
            rubricProfile,
            JSON.stringify(must),
            JSON.stringify(nice),
            JSON.stringify(reject),
            now,
            now
          ).run()
          : (targetSchema.hasRejectKeywords
            ? await env.DB.prepare(`
              INSERT INTO targets (
                id, name, primary_role, seniority_pref, location_pref,
                must_keywords_json, nice_keywords_json, reject_keywords_json,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), targets.name),
                primary_role = COALESCE(NULLIF(excluded.primary_role, ''), targets.primary_role),
                seniority_pref = COALESCE(NULLIF(excluded.seniority_pref, ''), targets.seniority_pref),
                location_pref = COALESCE(NULLIF(excluded.location_pref, ''), targets.location_pref),
                must_keywords_json = excluded.must_keywords_json,
                nice_keywords_json = excluded.nice_keywords_json,
                reject_keywords_json = excluded.reject_keywords_json,
                updated_at = excluded.updated_at;
            `.trim()).bind(
            targetId,
            name || targetId,
            primaryRole,
            seniorityPref,
            locationPref,
            JSON.stringify(must),
            JSON.stringify(nice),
            JSON.stringify(reject),
            now,
            now
          ).run()
          : (targetSchema.hasRubricProfile
            ? await env.DB.prepare(`
              INSERT INTO targets (
                id, name, primary_role, seniority_pref, location_pref, rubric_profile,
                must_keywords_json, nice_keywords_json,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), targets.name),
                primary_role = COALESCE(NULLIF(excluded.primary_role, ''), targets.primary_role),
                seniority_pref = COALESCE(NULLIF(excluded.seniority_pref, ''), targets.seniority_pref),
                location_pref = COALESCE(NULLIF(excluded.location_pref, ''), targets.location_pref),
                rubric_profile = excluded.rubric_profile,
                must_keywords_json = excluded.must_keywords_json,
                nice_keywords_json = excluded.nice_keywords_json,
                updated_at = excluded.updated_at;
            `.trim()).bind(
            targetId,
            name || targetId,
            primaryRole,
            seniorityPref,
            locationPref,
            rubricProfile,
            JSON.stringify(must),
            JSON.stringify(nice),
            now,
            now
          ).run()
            : await env.DB.prepare(`
              INSERT INTO targets (
                id, name, primary_role, seniority_pref, location_pref,
                must_keywords_json, nice_keywords_json,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), targets.name),
                primary_role = COALESCE(NULLIF(excluded.primary_role, ''), targets.primary_role),
                seniority_pref = COALESCE(NULLIF(excluded.seniority_pref, ''), targets.seniority_pref),
                location_pref = COALESCE(NULLIF(excluded.location_pref, ''), targets.location_pref),
                must_keywords_json = excluded.must_keywords_json,
                nice_keywords_json = excluded.nice_keywords_json,
                updated_at = excluded.updated_at;
            `.trim()).bind(
            targetId,
            name || targetId,
            primaryRole,
            seniorityPref,
            locationPref,
            JSON.stringify(must),
            JSON.stringify(nice),
            now,
            now
          ).run()));

        if (!r.success) return json_({ ok: false, error: "Failed to save target" }, env, 500);

        await logEvent_(env, "TARGET_UPDATED", null, { id: targetId, ts: now });
        return json_({ ok: true, data: { id: targetId, updated_at: now } }, env, 200);
      }

      // ============================
      // ADMIN: Normalize URL
      // ============================
      if (path === "/normalize-job" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rawUrl = String(body.raw_url || "").trim();
        if (!rawUrl) return json_({ ok: false, error: "Missing raw_url" }, env, 400);

        const normalized = await normalizeJobUrl_(rawUrl);
        if (!normalized || normalized.ignored) return json_({ ok: true, data: { ignored: true } }, env, 200);
        return json_({ ok: true, data: normalized }, env, 200);
      }

      // ============================
      // ADMIN: Resolve JD (fetch + email fallback)
      // ============================
      if (path === "/resolve-jd" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const jobUrl = String(body.job_url || "").trim();
        const emailHtml = typeof body.email_html === "string" ? body.email_html : "";
        const emailText = typeof body.email_text === "string" ? body.email_text : "";
        const emailSubject = typeof body.email_subject === "string" ? body.email_subject : "";
        const emailFrom = typeof body.email_from === "string" ? body.email_from : "";
        if (!jobUrl) return json_({ ok: false, error: "Missing job_url" }, env, 400);

        const resolved = await resolveJd_(env, jobUrl, { emailHtml, emailText, emailSubject, emailFrom });
        return json_({ ok: true, data: resolved }, env, 200);
      }

      // ============================
      // ADMIN: Extract JD (AI)
      // ============================
      if (path === "/extract-jd" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || "").trim();
        if (!text || text.length < 50) return json_({ ok: false, error: "JD text too short" }, env, 400);

        const extracted = sanitizeExtracted_(await extractJdWithModel_(ai, text), text);
        return json_({ ok: true, data: extracted }, env, 200);
      }

      // ============================
      // ADMIN: Score JD (AI)
      // ============================
      if (path === "/score-jd" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const job = body.job || {};
        const targetsIn = Array.isArray(body.targets) ? body.targets : [];
        const cfgIn = body.cfg || {};

        const roleTitle = String(job.role_title || "").trim();
        const location = String(job.location || "").trim();
        const seniority = String(job.seniority || "").trim();
        const jdClean = String(job.jd_clean || job.jdClean || "").trim();

        if (!roleTitle && !jdClean) return json_({ ok: false, error: "Missing job.role_title and job.jd_clean" }, env, 400);
        if (!targetsIn.length) return json_({ ok: false, error: "No targets provided" }, env, 400);

        const cfg = {
          SCORE_THRESHOLD_SHORTLIST: numOr_(cfgIn.SCORE_THRESHOLD_SHORTLIST, 75),
          SCORE_THRESHOLD_ARCHIVE: numOr_(cfgIn.SCORE_THRESHOLD_ARCHIVE, 55),
          DEFAULT_TARGET_ID: String(cfgIn.DEFAULT_TARGET_ID || "TGT-001"),
        };

        const targets = targetsIn.map((t) => ({
          id: String(t.id || t.Target_ID || "").trim(),
          name: String(t.name || t.Target_Name || "").trim(),
          primaryRole: String(t.primaryRole || t.primary_role || t.Primary_Role || "").trim(),
          seniorityPref: String(t.seniorityPref || t.seniority_pref || t.Seniority || "").trim(),
          locationPref: String(t.locationPref || t.location_pref || t.Location_Preference || "").trim(),
          must: safeJsonParseArray_(t.must_keywords_json || t.must_keywords || t.must_keywords_json),
          nice: safeJsonParseArray_(t.nice_keywords_json || t.nice_keywords || t.nice_keywords_json),
          reject: safeJsonParseArray_(t.reject_keywords_json || t.reject_keywords || t.reject_keywords_json),
        })).filter((t) => t.id);

        const scoring = await scoreJobWithModel_(ai, {
          role_title: roleTitle,
          company: String(job.company || "").trim(),
          location,
          seniority,
          jd_clean: jdClean,
        }, targets, cfg);
        return json_({ ok: true, data: scoring }, env, 200);
      }

      // ============================
      // ADMIN: Batch score pending jobs
      // ============================
      if (path === "/score-pending" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const batch = await runScorePending_(env, ai, body, { defaultStatuses: ["NEW"] });
        if (!batch.ok) return json_({ ok: false, error: batch.error }, env, batch.status || 400);

        await logEvent_(env, "RESCORED_BATCH", null, {
          limit: batch.limit,
          status: batch.statuses.join(","),
          updated: batch.data.updated,
          ts: Date.now(),
        });
        return json_({ ok: true, data: batch.data }, env, 200);
      }

      // ============================
      // PUBLIC: WhatsApp (Vonage) ingest webhook
      // ============================
      if (path === "/ingest/whatsapp/vonage" && request.method === "POST") {
        const configuredKey = String(env.WHATSAPP_VONAGE_KEY || env.WHATSAPP_INGEST_KEY || "").trim();
        if (!configuredKey) {
          return json_({ ok: false, error: "Missing WHATSAPP_VONAGE_KEY (or WHATSAPP_INGEST_KEY)" }, env, 500);
        }

        const providedKey = String(
          url.searchParams.get("key") ||
          request.headers.get("x-webhook-key") ||
          request.headers.get("x-ingest-key") ||
          ""
        ).trim();
        if (!providedKey || providedKey !== configuredKey) {
          return json_({ ok: false, error: "Unauthorized" }, env, 401);
        }

        const rawBody = await request.text().catch(() => "");
        const bodyParsed = safeJsonParseAny_(rawBody);
        const body = (bodyParsed && typeof bodyParsed === "object" && !Array.isArray(bodyParsed))
          ? bodyParsed
          : {};
        const rawBodyMediaRef = extractVonageMediaRefFromRawBody_(rawBody);

        const signatureCheck = await verifyVonageWebhookSignature_(request, rawBody, env);
        if (!signatureCheck.ok) {
          return json_({ ok: false, error: signatureCheck.error || "Invalid Vonage signature" }, env, signatureCheck.status || 401);
        }
        const inboundAuthorization = String(request.headers.get("authorization") || "").trim();
        const sender = pickVonageWebhookSender_(body);
        const senderNorm = normalizeVonageSenderForAllowList_(sender);
        const allowedSenders = getVonageAllowedSenders_(env);
        if (allowedSenders.length && (!senderNorm || !allowedSenders.includes(senderNorm))) {
          await logEvent_(env, "WHATSAPP_VONAGE_INGEST_REJECTED_SENDER", null, {
            route: "/ingest/whatsapp/vonage",
            sender: sender || null,
            sender_normalized: senderNorm || null,
            allowed_senders_count: allowedSenders.length,
            signature_verified: Boolean(signatureCheck.enabled),
            signature_mode: signatureCheck.mode || "disabled",
            ts: Date.now(),
          });
          return json_({ ok: false, error: "Forbidden sender" }, env, 403);
        }

        const messageId = String(
          body?.message_uuid ||
          body?.messageUuid ||
          body?.message_id ||
          body?.messageId ||
          body?.uuid ||
          body?.id ||
          crypto.randomUUID()
        ).trim().slice(0, 240) || crypto.randomUUID();

        const processed = processDomainIngest_(body, "WHATSAPP");
        const sourceHealth = checkIngestSourceHealth_(processed);
        const rawUrls = Array.isArray(processed?.ingest_input?.raw_urls) ? processed.ingest_input.raw_urls : [];
        const emailText = typeof processed?.ingest_input?.email_text === "string" ? processed.ingest_input.email_text : "";
        const emailHtml = typeof processed?.ingest_input?.email_html === "string" ? processed.ingest_input.email_html : "";
        const emailSubject = typeof processed?.ingest_input?.email_subject === "string" ? processed.ingest_input.email_subject : "";
        const emailFrom = typeof processed?.ingest_input?.email_from === "string" ? processed.ingest_input.email_from : "";
        const mediaMetaRaw = (processed?.metadata?.media && typeof processed.metadata.media === "object")
          ? processed.metadata.media
          : {};
        const mediaDetected = toBool_(mediaMetaRaw?.present, false);
        const mediaUrlInput = String(mediaMetaRaw?.url || rawBodyMediaRef?.url || "").trim();
        const mediaId = String(mediaMetaRaw?.id || rawBodyMediaRef?.id || "").trim();
        const mediaUrl = mediaUrlInput || vonageMediaUrlFromId_(env, mediaId);
        const mediaType = String(mediaMetaRaw?.type || "").trim().toLowerCase();
        const mediaMimeType = String(mediaMetaRaw?.mime_type || "").trim().toLowerCase();
        const mediaFileName = String(mediaMetaRaw?.file_name || "").trim();
        const mediaCaption = String(mediaMetaRaw?.caption || "").trim();
        const mediaSizeIn = mediaMetaRaw?.size_bytes;
        const mediaSizeBytes = (mediaSizeIn === null || mediaSizeIn === undefined || mediaSizeIn === "")
          ? null
          : (Number.isFinite(Number(mediaSizeIn)) ? Math.max(0, Math.floor(Number(mediaSizeIn))) : null);
        const mediaSummary = mediaDetected
          ? {
            type: mediaType || null,
            id: mediaId || null,
            mime_type: mediaMimeType || null,
            file_name: mediaFileName || null,
            size_bytes: mediaSizeBytes,
            caption_preview: mediaCaption ? mediaCaption.slice(0, 200) : null,
            url_host: sourceDomainFromUrl_(mediaUrl) || null,
          }
          : null;
        // Run media extraction whenever we can resolve a Vonage media URL (direct URL or media id fallback).
        const mediaNeedsExtraction = mediaDetected && Boolean(mediaUrl);
        const extractorConfigured = Boolean(String(env.WHATSAPP_MEDIA_EXTRACTOR_URL || "").trim());
        const baseExtractionStatus = mediaNeedsExtraction
          ? (extractorConfigured ? "queued" : "queued_unconfigured")
          : "not_applicable";

        const runWebhookIngest = async () => {
          if (mediaDetected && !mediaUrl) {
            await logEvent_(env, "WHATSAPP_VONAGE_MEDIA_MISSING_URL", null, {
              message_id: messageId,
              route: "/ingest/whatsapp/vonage",
              sender: sender || null,
              media_type: mediaType || null,
              media_id: mediaId || null,
              raw_media_ref_found: Boolean(rawBodyMediaRef?.url || rawBodyMediaRef?.id),
              media_file_name: mediaFileName || null,
              media_mime_type: mediaMimeType || null,
              extraction_status: "missing_media_url",
              ts: Date.now(),
            });
          }

          if (!mediaNeedsExtraction) {
            await logIngestSourceHealthIfNeeded_(env, sourceHealth, {
              route: "/ingest/whatsapp/vonage",
              source: "WHATSAPP_VONAGE",
            });
          }

          const data = rawUrls.length
            ? await ingestRawUrls_(env, {
              rawUrls,
              emailText,
              emailHtml,
              emailSubject,
              emailFrom,
              ingestChannel: "whatsapp_vonage",
            })
            : {
              count_in: 0,
              inserted_or_updated: 0,
              inserted_count: 0,
              updated_count: 0,
              ignored: 0,
              link_only: 0,
              results: [],
              source_summary: [],
            };

          let extractionStatus = baseExtractionStatus;
          let extractionIngest = null;

          if (mediaNeedsExtraction) {
            await logEvent_(env, "WHATSAPP_VONAGE_MEDIA_QUEUED", null, {
              message_id: messageId,
              route: "/ingest/whatsapp/vonage",
              sender: sender || null,
              media_type: mediaType || null,
              media_id: mediaId || null,
              media_mime_type: mediaMimeType || null,
              media_file_name: mediaFileName || null,
              media_size_bytes: mediaSizeBytes,
              media_url: mediaUrl || null,
              media_url_host: sourceDomainFromUrl_(mediaUrl) || null,
              extractor_configured: extractorConfigured,
              extraction_status: extractorConfigured ? "queued" : "queued_unconfigured",
              source_health: sourceHealth,
              ts: Date.now(),
            });

            if (extractorConfigured) {
              const extracted = await extractWhatsAppMediaText_(env, {
                provider: "vonage",
                message_id: messageId,
                sender,
                media_url: mediaUrl,
                media_id: mediaId || null,
                media_type: mediaType,
                media_mime_type: mediaMimeType,
                media_file_name: mediaFileName,
                media_size_bytes: mediaSizeBytes,
                media_caption: mediaCaption,
                source_health: sourceHealth,
                inbound_authorization: inboundAuthorization,
                signature_verified: Boolean(signatureCheck.enabled),
                signature_mode: signatureCheck.mode || "disabled",
                signature_issuer: String(signatureCheck?.claims?.iss || "").trim() || null,
              });

              if (!extracted.ok) {
                extractionStatus = "extract_failed";
                await logEvent_(env, "WHATSAPP_VONAGE_MEDIA_EXTRACT_FAILED", null, {
                  message_id: messageId,
                  route: "/ingest/whatsapp/vonage",
                  sender: sender || null,
                  media_type: mediaType || null,
                  media_id: mediaId || null,
                  media_mime_type: mediaMimeType || null,
                  media_file_name: mediaFileName || null,
                  media_url_host: sourceDomainFromUrl_(mediaUrl) || null,
                  extractor_url: String(extracted.extractor_url || "").trim() || null,
                  extractor_url_host: sourceDomainFromUrl_(extracted.extractor_url) || null,
                  error: String(extracted.error || "extract_failed").slice(0, 500),
                  source_health: sourceHealth,
                  ts: Date.now(),
                });
              } else {
                const extractedText = String(extracted.text || "").trim();
                const extractedUrls = Array.isArray(extracted.urls) ? extracted.urls : [];
                const ingestDecision = decideWhatsAppMediaExtractIngest_(
                  extractedText,
                  extractedUrls,
                  mediaType,
                  mediaMimeType
                );
                const canIngestExtracted = ingestDecision.accept === true;

                if (!canIngestExtracted) {
                  extractionStatus = "extract_empty";
                  await logEvent_(env, "WHATSAPP_VONAGE_MEDIA_EXTRACT_EMPTY", null, {
                    message_id: messageId,
                    route: "/ingest/whatsapp/vonage",
                    sender: sender || null,
                    media_type: mediaType || null,
                    media_id: mediaId || null,
                    extracted_text_len: extractedText.length,
                    extracted_url_count: extractedUrls.length,
                    ingest_decision: String(ingestDecision.reason || "").trim() || "reject",
                    signal_hits: numOr_(ingestDecision.keyword_hits, 0),
                    extracted_text_preview: extractedText.slice(0, 220) || null,
                    source_health: sourceHealth,
                    ts: Date.now(),
                  });
                } else {
                  const extractedRawUrls = extractedUrls.length
                    ? extractedUrls
                    : [syntheticWhatsappMediaJobUrl_(messageId)];

                  extractionIngest = await ingestRawUrls_(env, {
                    rawUrls: extractedRawUrls,
                    emailText: extractedText,
                    emailHtml: "",
                    emailSubject: String(extracted.title || emailSubject || mediaFileName || "WhatsApp Media Job Lead").trim().slice(0, 300),
                    emailFrom: emailFrom || sender || "whatsapp_vonage_media",
                    ingestChannel: "whatsapp_vonage_media",
                  });

                  extractionStatus = (numOr_(extractionIngest?.inserted_or_updated, 0) > 0 || numOr_(extractionIngest?.link_only, 0) > 0)
                    ? "ingested"
                    : "extract_no_insert";

                  await logEvent_(env, "WHATSAPP_VONAGE_MEDIA_EXTRACT_INGESTED", null, {
                    message_id: messageId,
                    route: "/ingest/whatsapp/vonage",
                    sender: sender || null,
                    media_type: mediaType || null,
                    media_id: mediaId || null,
                    media_mime_type: mediaMimeType || null,
                    media_file_name: mediaFileName || null,
                    extracted_text_len: extractedText.length,
                    extracted_url_count: extractedUrls.length,
                    synthetic_url_used: extractedUrls.length === 0,
                    ingest_decision: String(ingestDecision.reason || "").trim() || "accept",
                    signal_hits: numOr_(ingestDecision.keyword_hits, 0),
                    extraction_status: extractionStatus,
                    ingest: {
                      count_in: numOr_(extractionIngest?.count_in, 0),
                      inserted_or_updated: numOr_(extractionIngest?.inserted_or_updated, 0),
                      inserted_count: numOr_(extractionIngest?.inserted_count, 0),
                      updated_count: numOr_(extractionIngest?.updated_count, 0),
                      ignored: numOr_(extractionIngest?.ignored, 0),
                      link_only: numOr_(extractionIngest?.link_only, 0),
                    },
                    source_health: sourceHealth,
                    ts: Date.now(),
                  });
                }
              }
            }
          }

          const aggregatedData = extractionIngest
            ? {
              ...data,
              count_in: numOr_(data?.count_in, 0) + numOr_(extractionIngest?.count_in, 0),
              inserted_or_updated: numOr_(data?.inserted_or_updated, 0) + numOr_(extractionIngest?.inserted_or_updated, 0),
              inserted_count: numOr_(data?.inserted_count, 0) + numOr_(extractionIngest?.inserted_count, 0),
              updated_count: numOr_(data?.updated_count, 0) + numOr_(extractionIngest?.updated_count, 0),
              ignored: numOr_(data?.ignored, 0) + numOr_(extractionIngest?.ignored, 0),
              link_only: numOr_(data?.link_only, 0) + numOr_(extractionIngest?.link_only, 0),
              results: [
                ...(Array.isArray(data?.results) ? data.results : []),
                ...(Array.isArray(extractionIngest?.results) ? extractionIngest.results : []),
              ],
              source_summary: [
                ...(Array.isArray(data?.source_summary) ? data.source_summary : []),
                ...(Array.isArray(extractionIngest?.source_summary) ? extractionIngest.source_summary : []),
              ],
            }
            : data;

          await logEvent_(env, "WHATSAPP_VONAGE_INGEST", null, {
            message_id: messageId,
            route: "/ingest/whatsapp/vonage",
            count_in: aggregatedData?.count_in || 0,
            inserted_or_updated: aggregatedData?.inserted_or_updated || 0,
            ignored: aggregatedData?.ignored || 0,
            link_only: aggregatedData?.link_only || 0,
            media_detected: mediaDetected,
            media_queued_for_extraction: mediaNeedsExtraction,
            media_type: mediaType || null,
            media_id: mediaId || null,
            media_mime_type: mediaMimeType || null,
            media_file_name: mediaFileName || null,
            extraction_status: extractionStatus,
            signature_verified: Boolean(signatureCheck.enabled),
            signature_mode: signatureCheck.mode || "disabled",
            signature_issuer: String(signatureCheck?.claims?.iss || "").trim() || null,
            sender: sender || null,
            source_summary: Array.isArray(aggregatedData?.source_summary) ? aggregatedData.source_summary : [],
            ts: Date.now(),
          });
          return { ingest: aggregatedData, extraction_status: extractionStatus };
        };

        const responseBase = {
          ok: true,
          data: {
            accepted: true,
            queued: true,
            provider: "vonage",
            message_id: messageId,
            count_in: rawUrls.length,
            sender: sender || null,
            sender_whitelist_enabled: allowedSenders.length > 0,
            signature_verified: Boolean(signatureCheck.enabled),
            source_health: sourceHealth,
            media_detected: mediaDetected,
            media_queued_for_extraction: mediaNeedsExtraction,
            media: mediaSummary,
            extraction: mediaNeedsExtraction
              ? {
                queued: true,
                configured: extractorConfigured,
                status: baseExtractionStatus,
              }
              : {
                queued: false,
                configured: extractorConfigured,
                status: "not_applicable",
              },
          },
        };

        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(
            runWebhookIngest().catch(async (e) => {
              await logEvent_(env, "WHATSAPP_VONAGE_INGEST_FAILED", null, {
                message_id: messageId,
                route: "/ingest/whatsapp/vonage",
                error: String(e?.message || e || "unknown").slice(0, 400),
                ts: Date.now(),
              });
            })
          );
          return json_(responseBase, env, 200);
        }

        const runResult = await runWebhookIngest();
        return json_({
          ok: true,
          data: {
            accepted: true,
            queued: false,
            provider: "vonage",
            message_id: messageId,
            count_in: runResult?.ingest?.count_in || rawUrls.length,
            sender: sender || null,
            sender_whitelist_enabled: allowedSenders.length > 0,
            signature_verified: Boolean(signatureCheck.enabled),
            source_health: sourceHealth,
            media_detected: mediaDetected,
            media_queued_for_extraction: mediaNeedsExtraction,
            media: mediaSummary,
            extraction: mediaNeedsExtraction
              ? {
                queued: true,
                configured: extractorConfigured,
                status: String(runResult?.extraction_status || baseExtractionStatus),
              }
              : {
                queued: false,
                configured: extractorConfigured,
                status: "not_applicable",
              },
            ingest: runResult?.ingest || null,
          },
        }, env, 200);
      }

      // ============================
      // ADMIN: Ingest (raw URLs) â€” optional utility
      // ============================
      if (path === "/ingest" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const processed = processDomainIngest_(body, "MANUAL");
        const sourceHealth = checkIngestSourceHealth_(processed);
        await logIngestSourceHealthIfNeeded_(env, sourceHealth, {
          route: "/ingest",
          source: "MANUAL",
        });
        const rawUrls = Array.isArray(processed?.ingest_input?.raw_urls) ? processed.ingest_input.raw_urls : [];
        const emailText = typeof processed?.ingest_input?.email_text === "string" ? processed.ingest_input.email_text : "";
        const emailHtml = typeof processed?.ingest_input?.email_html === "string" ? processed.ingest_input.email_html : "";
        const emailSubject = typeof processed?.ingest_input?.email_subject === "string" ? processed.ingest_input.email_subject : "";
        const emailFrom = typeof processed?.ingest_input?.email_from === "string" ? processed.ingest_input.email_from : "";

        if (!rawUrls.length) return json_({ ok: false, error: "Missing raw_urls[]" }, env, 400);
        const data = await ingestRawUrls_(env, { rawUrls, emailText, emailHtml, emailSubject, emailFrom, ingestChannel: "ui" });
        return json_({ ok: true, data }, env, 200);
      }

      // ----------------------------
      // default
      // ----------------------------
      return new Response("Not found", { status: 404, headers: corsHeaders_(env) });

    } catch (err) {
      return json_(
        { ok: false, error: "Worker exception", detail: String(err?.message || err) },
        env,
        500
      );
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const cronStartedAt = Date.now();
          const scheduleMaxMs = clampInt_(env.SCHEDULE_MAX_MS || 45000, 5000, 840000);
          let budgetStopLogged = false;
          const budgetExceeded_ = async (stage) => {
            const elapsedMs = Date.now() - cronStartedAt;
            if (elapsedMs <= scheduleMaxMs) return false;
            if (!budgetStopLogged) {
              budgetStopLogged = true;
              await logEvent_(env, "SCHEDULE_BUDGET_STOP", null, {
                stage,
                elapsed_ms: elapsedMs,
                max_ms: scheduleMaxMs,
                ts: Date.now(),
              });
            }
            console.warn("scheduled budget reached", JSON.stringify({
              stage,
              elapsed_ms: elapsedMs,
              max_ms: scheduleMaxMs,
            }));
            return true;
          };

          if (await budgetExceeded_("gmail_poll")) return;
          const data = await runGmailPoll_(env);
          await logEvent_(env, "GMAIL_POLL", null, { source: "cron", ...data, ts: Date.now() });
          console.log("gmail poll ok", JSON.stringify(data));

          if (await budgetExceeded_("rss_poll")) return;
          const rssData = await runRssPoll_(env);
          if (!rssData?.skipped) {
            await logEvent_(env, "RSS_POLL", null, { source: "cron", ...rssData, ts: Date.now() });
          }
          console.log("rss poll", JSON.stringify(rssData));

          const recoveryEnabled = toBoolEnv_(env.RECOVERY_ENABLED, true);
          if (recoveryEnabled) {
            if (await budgetExceeded_("recovery_backfill")) return;
            const backfillLimit = clampInt_(env.RECOVER_BACKFILL_LIMIT || 30, 1, 200);
            const rescoreLimit = clampInt_(env.RECOVER_RESCORE_LIMIT || 30, 1, 200);

            const backfillData = await runBackfillMissing_(env, backfillLimit);
            await logEvent_(env, "RECOVERY_BACKFILL", null, {
              source: "cron",
              limit: backfillLimit,
              picked: backfillData.picked,
              processed: backfillData.processed,
              inserted_or_updated: backfillData.inserted_or_updated,
              inserted_count: backfillData.inserted_count,
              updated_count: backfillData.updated_count,
              ignored: backfillData.ignored,
              link_only: backfillData.link_only,
              ts: Date.now(),
            });
            console.log("recovery backfill cron", JSON.stringify({
              picked: backfillData.picked,
              processed: backfillData.processed,
              inserted_or_updated: backfillData.inserted_or_updated,
              updated_count: backfillData.updated_count,
              link_only: backfillData.link_only,
            }));

            const aiRecovery = getAi_(env);
            if (!aiRecovery) {
              console.warn("recovery rescore skipped: missing AI binding");
            } else {
              if (await budgetExceeded_("recovery_missing_fields")) return;
              const missingFieldsLimit = clampInt_(env.RECOVER_MISSING_FIELDS_LIMIT || 20, 1, 200);
              const missingFieldsData = await runRecoverMissingFields_(env, aiRecovery, missingFieldsLimit);
              await logEvent_(env, "RECOVERY_MISSING_FIELDS", null, {
                source: "cron",
                limit: missingFieldsLimit,
                picked: missingFieldsData.picked,
                updated: missingFieldsData.updated,
                skipped: missingFieldsData.skipped,
                errors: missingFieldsData.errors,
                ts: Date.now(),
              });
              console.log("recovery missing fields cron", JSON.stringify({
                picked: missingFieldsData.picked,
                updated: missingFieldsData.updated,
                skipped: missingFieldsData.skipped,
                errors: missingFieldsData.errors,
              }));

              if (await budgetExceeded_("recovery_rescore")) return;
              const recoveryBatch = await runScorePending_(
                env,
                aiRecovery,
                { limit: rescoreLimit, status: "NEW,SCORED,LINK_ONLY" },
                {
                  defaultStatuses: ["NEW", "SCORED", "LINK_ONLY"],
                  allowedStatuses: ["NEW", "SCORED", "LINK_ONLY"],
                  requireJd: true,
                }
              );
              if (!recoveryBatch.ok) {
                console.warn("recovery rescore skipped:", recoveryBatch.error);
              } else {
                await logEvent_(env, "RECOVERY_RESCORE", null, {
                  source: "cron",
                  limit: recoveryBatch.limit,
                  status: recoveryBatch.statuses.join(","),
                  picked: recoveryBatch.data.picked,
                  updated: recoveryBatch.data.updated,
                  ts: Date.now(),
                });
                console.log("recovery rescore cron", JSON.stringify(recoveryBatch.data));
              }
            }
          }

          if (await budgetExceeded_("score_pending")) return;
          const ai = getAi_(env);
          if (!ai) {
            console.warn("score pending skipped: missing AI binding");
            return;
          }
          const scoreBatch = await runScorePending_(env, ai, { limit: 30, status: "NEW" }, { defaultStatuses: ["NEW"] });
          if (!scoreBatch.ok) {
            console.warn("score pending skipped:", scoreBatch.error);
            return;
          }
          await logEvent_(env, "RESCORED_BATCH", null, {
            source: "cron",
            limit: scoreBatch.limit,
            status: scoreBatch.statuses.join(","),
            updated: scoreBatch.data.updated,
            picked: scoreBatch.data.picked,
            ts: Date.now(),
          });
          console.log("score pending cron ok", JSON.stringify(scoreBatch.data));
        } catch (e) {
          console.error("gmail poll failed", String(e?.message || e));
        }
      })()
    );
  },
};

/* =========================================================
 * D1 helpers
 * ========================================================= */

async function logEvent_(env, eventType, jobKey, payload) {
  try {
    if (!env.DB) return;
    const id = crypto.randomUUID();
    const ts = Date.now();
    await env.DB.prepare(
      `INSERT INTO events (id, event_type, job_key, payload_json, ts) VALUES (?, ?, ?, ?, ?);`
    )
      .bind(id, eventType, jobKey || null, JSON.stringify(payload || {}), ts)
      .run();
  } catch {
    // ignore logging failures
  }
}

async function getTargetsSchema_(env) {
  try {
    const rows = await env.DB.prepare(`PRAGMA table_info(targets);`).all();
    const names = new Set((rows.results || []).map((r) => String(r.name || "").trim()));
    return {
      hasRejectKeywords: names.has("reject_keywords_json"),
      hasRubricProfile: names.has("rubric_profile"),
    };
  } catch {
    return { hasRejectKeywords: false, hasRubricProfile: false };
  }
}

async function getJobsSchema_(env) {
  try {
    const rows = await env.DB.prepare(`PRAGMA table_info(jobs);`).all();
    const names = new Set((rows.results || []).map((r) => String(r.name || "").trim()));
    return {
      hasChecklistFields:
        names.has("applied_note") &&
        names.has("follow_up_at") &&
        names.has("referral_status"),
    };
  } catch {
    return { hasChecklistFields: false };
  }
}

async function hasJobEvidenceTable_(env) {
  try {
    const row = await env.DB.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'job_evidence'
      LIMIT 1;
    `.trim()).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function hasJobProfilePreferencesTable_(env) {
  try {
    const row = await env.DB.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'job_profile_preferences'
      LIMIT 1;
    `.trim()).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function getJobProfilePreference_(env, jobKey) {
  const key = String(jobKey || "").trim();
  if (!key) return { enabled: false, profile_id: "", updated_at: null };
  const enabled = await hasJobProfilePreferencesTable_(env);
  if (!enabled) return { enabled: false, profile_id: "", updated_at: null };
  const row = await env.DB.prepare(`
    SELECT job_key, profile_id, updated_at
    FROM job_profile_preferences
    WHERE job_key = ?
    LIMIT 1;
  `.trim()).bind(key).first();
  return {
    enabled: true,
    profile_id: String(row?.profile_id || "").trim(),
    updated_at: numOrNull_(row?.updated_at),
  };
}

async function setJobProfilePreference_(env, { jobKey, profileId } = {}) {
  const key = String(jobKey || "").trim();
  const pid = String(profileId || "").trim();
  if (!key) return { ok: false, error: "missing_job_key" };

  const enabled = await hasJobProfilePreferencesTable_(env);
  if (!enabled) {
    return {
      ok: false,
      enabled: false,
      error: "job_profile_preferences_schema_not_enabled",
    };
  }

  if (!pid) {
    await env.DB.prepare(`
      DELETE FROM job_profile_preferences
      WHERE job_key = ?;
    `.trim()).bind(key).run();
    return {
      ok: true,
      enabled: true,
      profile_id: "",
      updated_at: Date.now(),
      cleared: true,
    };
  }

  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO job_profile_preferences (job_key, profile_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(job_key) DO UPDATE SET
      profile_id = excluded.profile_id,
      updated_at = excluded.updated_at;
  `.trim()).bind(key, pid, now, now).run();

  return {
    ok: true,
    enabled: true,
    profile_id: pid,
    updated_at: now,
    cleared: false,
  };
}

async function resolvePreferredProfileForJob_(env, { jobKey, profileIdIn = "" } = {}) {
  const explicit = String(profileIdIn || "").trim();
  const key = String(jobKey || "").trim();
  let selectedProfileId = explicit;
  let source = explicit ? "request" : "default";

  let pref = { enabled: false, profile_id: "", updated_at: null };
  if (!selectedProfileId && key) {
    pref = await getJobProfilePreference_(env, key);
    if (pref.enabled && pref.profile_id) {
      selectedProfileId = pref.profile_id;
      source = "job_preference";
    }
  }

  let profile = null;
  if (selectedProfileId) {
    profile = await env.DB.prepare(`
      SELECT * FROM resume_profiles
      WHERE id = ?
      LIMIT 1;
    `.trim()).bind(selectedProfileId).first();
  }

  if (!profile) {
    profile = await ensurePrimaryProfile_(env);
    selectedProfileId = String(profile?.id || "primary").trim() || "primary";
    if (explicit) source = "request_fallback_primary";
    if (!explicit && source !== "job_preference") source = "primary_fallback";
    if (!explicit && source === "job_preference") source = "job_preference_fallback_primary";
  }

  return {
    profile,
    profile_id: String(selectedProfileId || "").trim(),
    source,
    preference_enabled: Boolean(pref.enabled),
    preference_profile_id: String(pref.profile_id || "").trim(),
  };
}

function rankOutreachChannel_(channel) {
  const ch = normalizeOutreachChannel_(channel || "OTHER");
  if (ch === "LINKEDIN") return 3;
  if (ch === "EMAIL") return 2;
  return 1;
}

function normalizeOutreachTouchpointStatus_(status, fallback = "DRAFT") {
  const s = String(status || "").trim().toUpperCase();
  if (s === "SENT" || s === "REPLIED") return s;
  const fb = String(fallback || "DRAFT").trim().toUpperCase();
  if (fb === "SENT" || fb === "REPLIED") return fb;
  return "DRAFT";
}

function normalizeOutreachContactRow_(row) {
  const src = row && typeof row === "object" ? row : {};
  const id = String(src.id || "").trim();
  if (!id) return null;
  const channel = normalizeOutreachChannel_(
    src.touchpoint_channel ||
    src.channel ||
    (String(src.linkedin_url || "").trim() ? "LINKEDIN" : (String(src.email || "").trim() ? "EMAIL" : "OTHER"))
  );
  return {
    id,
    name: String(src.name || "").trim(),
    title: String(src.title || "").trim() || null,
    company_name: String(src.company_name || "").trim() || null,
    linkedin_url: String(src.linkedin_url || "").trim() || null,
    email: String(src.email || "").trim() || null,
    confidence: clampInt_(src.confidence ?? 0, 0, 100),
    source: String(src.source || "").trim() || null,
    channel,
    status: normalizeOutreachTouchpointStatus_(src.touchpoint_status || src.status || "DRAFT"),
    touchpoint_id: String(src.touchpoint_id || "").trim() || null,
    touchpoint_content: String(src.touchpoint_content || src.content || "").trim() || null,
    touchpoint_updated_at: numOrNull_(src.touchpoint_updated_at ?? src.updated_at),
    linked_to_job: Boolean(src.touchpoint_channel || src.touchpoint_updated_at),
  };
}

function dedupeOutreachContacts_(rows = []) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const normalized = normalizeOutreachContactRow_(row);
    if (!normalized) continue;
    const existing = map.get(normalized.id);
    if (!existing) {
      map.set(normalized.id, {
        ...normalized,
        channels: [normalized.channel],
        channel_statuses: {
          [normalized.channel]: normalized.status,
        },
        channel_touchpoints: normalized.touchpoint_id
          ? { [normalized.channel]: normalized.touchpoint_id }
          : {},
        channel_updated_at: (normalized.touchpoint_updated_at !== null)
          ? { [normalized.channel]: normalized.touchpoint_updated_at }
          : {},
      });
      continue;
    }
    if (!existing.channels.includes(normalized.channel)) {
      existing.channels.push(normalized.channel);
    }
    existing.channel_statuses = {
      ...(existing.channel_statuses && typeof existing.channel_statuses === "object"
        ? existing.channel_statuses
        : {}),
      [normalized.channel]: normalizeOutreachTouchpointStatus_(
        normalized.status,
        existing.channel_statuses?.[normalized.channel] || "DRAFT"
      ),
    };
    if (normalized.touchpoint_id) {
      existing.channel_touchpoints = {
        ...(existing.channel_touchpoints && typeof existing.channel_touchpoints === "object"
          ? existing.channel_touchpoints
          : {}),
        [normalized.channel]: normalized.touchpoint_id,
      };
    }
    if (normalized.touchpoint_updated_at !== null) {
      existing.channel_updated_at = {
        ...(existing.channel_updated_at && typeof existing.channel_updated_at === "object"
          ? existing.channel_updated_at
          : {}),
        [normalized.channel]: normalized.touchpoint_updated_at,
      };
    }
    const existingScore =
      (existing.confidence || 0) +
      rankOutreachChannel_(existing.channel) +
      (existing.linked_to_job ? 2 : 0);
    const nextScore =
      (normalized.confidence || 0) +
      rankOutreachChannel_(normalized.channel) +
      (normalized.linked_to_job ? 2 : 0);
    if (nextScore > existingScore) {
      map.set(normalized.id, {
        ...normalized,
        channels: existing.channels,
        channel_statuses: existing.channel_statuses,
        channel_touchpoints: existing.channel_touchpoints,
        channel_updated_at: existing.channel_updated_at,
      });
      continue;
    }
    if (
      existing.touchpoint_updated_at === null &&
      normalized.touchpoint_updated_at !== null
    ) {
      map.set(normalized.id, {
        ...existing,
        status: normalized.status,
        touchpoint_content: normalized.touchpoint_content,
        touchpoint_updated_at: normalized.touchpoint_updated_at,
        linked_to_job: normalized.linked_to_job,
      });
    }
  }
  const out = Array.from(map.values());
  out.sort((a, b) => {
    const confidenceDiff = (b.confidence || 0) - (a.confidence || 0);
    if (confidenceDiff !== 0) return confidenceDiff;
    const channelDiff = rankOutreachChannel_(b.channel) - rankOutreachChannel_(a.channel);
    if (channelDiff !== 0) return channelDiff;
    const aTs = numOr_(a.touchpoint_updated_at, 0);
    const bTs = numOr_(b.touchpoint_updated_at, 0);
    return bTs - aTs;
  });
  return out;
}

async function listContactsForJobOutreach_(env, input = {}) {
  const jobKey = String(input.job_key || "").trim();
  const company = String(input.company || "").trim();
  const storage = await hasContactsStorage_(env);
  if (!storage?.enabled) {
    return {
      enabled: false,
      error: String(storage?.error || "contacts_storage_unavailable"),
      contacts: [],
    };
  }

  const linked = await env.DB.prepare(`
    SELECT
      c.id,
      c.name,
      c.title,
      c.company_name,
      c.linkedin_url,
      c.email,
      c.confidence,
      c.source,
      ct.id AS touchpoint_id,
      ct.channel AS touchpoint_channel,
      ct.status AS touchpoint_status,
      ct.content AS touchpoint_content,
      ct.updated_at AS touchpoint_updated_at
    FROM contact_touchpoints ct
    INNER JOIN contacts c ON c.id = ct.contact_id
    WHERE ct.job_key = ?
    ORDER BY COALESCE(c.confidence, 0) DESC, ct.updated_at DESC;
  `.trim()).bind(jobKey).all();

  let rows = Array.isArray(linked?.results) ? linked.results : [];
  if (!rows.length && company) {
    const sameCompany = await env.DB.prepare(`
      SELECT
        id,
        name,
        title,
        company_name,
        linkedin_url,
        email,
        confidence,
        source,
        NULL AS touchpoint_channel,
        NULL AS touchpoint_status,
        NULL AS touchpoint_content,
        updated_at AS touchpoint_updated_at
      FROM contacts
      WHERE lower(COALESCE(company_name, '')) = lower(?)
      ORDER BY COALESCE(confidence, 0) DESC, updated_at DESC
      LIMIT 25;
    `.trim()).bind(company).all();
    rows = Array.isArray(sameCompany?.results) ? sameCompany.results : [];
  }

  return {
    enabled: true,
    error: null,
    contacts: dedupeOutreachContacts_(rows),
  };
}

async function loadOutreachEvidenceRows_(env, input = {}) {
  const jobKey = String(input.job_key || "").trim();
  const limit = clampInt_(input.limit || 12, 1, 30);
  if (!jobKey) return [];
  const hasEvidence = await hasJobEvidenceTable_(env);
  if (!hasEvidence) return [];
  const rows = await env.DB.prepare(`
    SELECT
      requirement_text,
      requirement_type,
      evidence_text,
      evidence_source,
      confidence_score,
      updated_at
    FROM job_evidence
    WHERE job_key = ? AND matched = 1
    ORDER BY
      CASE requirement_type
        WHEN 'must' THEN 1
        WHEN 'nice' THEN 2
        ELSE 3
      END ASC,
      confidence_score DESC,
      updated_at DESC
    LIMIT ?;
  `.trim()).bind(jobKey, limit).all();
  return Array.isArray(rows?.results) ? rows.results : [];
}

async function loadOutreachProfileContext_(env, input = {}) {
  const jobKey = String(input.job_key || "").trim();
  const profileIdIn = String(input.profile_id || "").trim();
  let draftRow = null;
  if (profileIdIn) {
    draftRow = await env.DB.prepare(`
      SELECT profile_id, pack_json
      FROM resume_drafts
      WHERE job_key = ? AND profile_id = ?
      ORDER BY updated_at DESC
      LIMIT 1;
    `.trim()).bind(jobKey, profileIdIn).first();
  }
  if (!draftRow) {
    draftRow = await env.DB.prepare(`
      SELECT profile_id, pack_json
      FROM resume_drafts
      WHERE job_key = ?
      ORDER BY updated_at DESC
      LIMIT 1;
    `.trim()).bind(jobKey).first();
  }

  const packJson = safeJsonParse_(draftRow?.pack_json) || {};
  const tailoring = packJson?.tailoring && typeof packJson.tailoring === "object"
    ? packJson.tailoring
    : {};
  const summaryFromPack = String(tailoring.summary || "").trim();
  const bulletsFromPack = Array.isArray(tailoring.bullets)
    ? tailoring.bullets.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const resolvedProfileId = String(
    profileIdIn ||
    draftRow?.profile_id ||
    "primary"
  ).trim() || "primary";

  const profileRow = await env.DB.prepare(`
    SELECT id, name, profile_json
    FROM resume_profiles
    WHERE id = ?
    LIMIT 1;
  `.trim()).bind(resolvedProfileId).first();
  const profileJson = safeJsonParse_(profileRow?.profile_json) || {};
  const basics = profileJson?.basics && typeof profileJson.basics === "object"
    ? profileJson.basics
    : {};

  const senderName = String(
    basics.name ||
    profileJson.name ||
    profileRow?.name ||
    ""
  ).trim();

  const summaryFromProfile = String(
    profileJson.summary ||
    basics.summary ||
    ""
  ).trim();

  return {
    profile_id: resolvedProfileId,
    sender_name: senderName || "Candidate",
    summary: summaryFromPack || summaryFromProfile || bulletsFromPack[0] || "",
    bullets: bulletsFromPack.slice(0, 5),
  };
}

async function upsertOutreachTouchpointDraft_(env, input = {}) {
  const contactId = String(input.contact_id || "").trim();
  const jobKey = String(input.job_key || "").trim();
  const draft = String(input.draft || "").trim();
  const channel = normalizeOutreachChannel_(input.channel || "LINKEDIN");
  if (!contactId || !jobKey || !draft) return null;
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO contact_touchpoints (
      id, contact_id, job_key, channel, status, content, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id, job_key, channel) DO UPDATE SET
      status = excluded.status,
      content = excluded.content,
      updated_at = excluded.updated_at;
  `.trim()).bind(
    crypto.randomUUID(),
    contactId,
    jobKey,
    channel,
    "DRAFT",
    draft,
    now,
    now
  ).run();

  const row = await env.DB.prepare(`
    SELECT
      id,
      contact_id,
      job_key,
      channel,
      status,
      updated_at
    FROM contact_touchpoints
    WHERE contact_id = ? AND job_key = ? AND channel = ?
    LIMIT 1;
  `.trim()).bind(contactId, jobKey, channel).first();

  return row
    ? {
      id: row.id,
      contact_id: row.contact_id,
      job_key: row.job_key,
      channel: row.channel,
      status: row.status,
      updated_at: numOrNull_(row.updated_at),
    }
    : null;
}

async function upsertOutreachTouchpointStatus_(env, input = {}) {
  const contactId = String(input.contact_id || "").trim();
  const jobKey = String(input.job_key || "").trim();
  const channel = normalizeOutreachChannel_(input.channel || "LINKEDIN");
  const status = normalizeOutreachTouchpointStatus_(input.status || "DRAFT");
  const content = String(input.content || "").trim() || null;
  if (!contactId || !jobKey) return null;

  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO contact_touchpoints (
      id, contact_id, job_key, channel, status, content, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id, job_key, channel) DO UPDATE SET
      status = excluded.status,
      content = COALESCE(excluded.content, contact_touchpoints.content),
      updated_at = excluded.updated_at;
  `.trim()).bind(
    crypto.randomUUID(),
    contactId,
    jobKey,
    channel,
    status,
    content,
    now,
    now
  ).run();

  const row = await env.DB.prepare(`
    SELECT
      id,
      contact_id,
      job_key,
      channel,
      status,
      content,
      updated_at
    FROM contact_touchpoints
    WHERE contact_id = ? AND job_key = ? AND channel = ?
    LIMIT 1;
  `.trim()).bind(contactId, jobKey, channel).first();

  return row
    ? {
      id: String(row.id || "").trim(),
      contact_id: String(row.contact_id || "").trim(),
      job_key: String(row.job_key || "").trim(),
      channel: normalizeOutreachChannel_(row.channel || channel),
      status: normalizeOutreachTouchpointStatus_(row.status || status),
      content: String(row.content || "").trim() || null,
      updated_at: numOrNull_(row.updated_at),
    }
    : null;
}

async function draftOutreachForJob_(env, input = {}) {
  const jobKey = String(input.job_key || "").trim();
  if (!jobKey) return { ok: false, status: 400, error: "Missing job_key" };

  const jobRow = await env.DB.prepare(`
    SELECT
      job_key,
      role_title,
      company,
      status,
      reason_top_matches,
      must_have_keywords_json,
      nice_to_have_keywords_json
    FROM jobs
    WHERE job_key = ?
    LIMIT 1;
  `.trim()).bind(jobKey).first();
  if (!jobRow) return { ok: false, status: 404, error: "Not found" };

  const job = {
    job_key: jobRow.job_key,
    role_title: String(jobRow.role_title || "").trim(),
    company: String(jobRow.company || "").trim(),
    status: String(jobRow.status || "").trim().toUpperCase(),
    reason_top_matches: String(jobRow.reason_top_matches || "").trim(),
    must_have_keywords: safeJsonParseArray_(jobRow.must_have_keywords_json).slice(0, 20),
    nice_to_have_keywords: safeJsonParseArray_(jobRow.nice_to_have_keywords_json).slice(0, 20),
  };

  const contactsView = await listContactsForJobOutreach_(env, {
    job_key: jobKey,
    company: job.company,
  });
  if (!contactsView.enabled) {
    return { ok: false, status: 400, error: "Contacts schema not enabled in DB." };
  }

  const contacts = Array.isArray(contactsView.contacts) ? contactsView.contacts : [];
  if (!contacts.length) {
    return {
      ok: false,
      status: 404,
      error: "No contacts found for this job. Run scoring to identify contacts first.",
    };
  }

  const requestedContactId = String(input.contact_id || "").trim();
  let selected = requestedContactId
    ? contacts.find((x) => String(x?.id || "").trim() === requestedContactId)
    : contacts[0];
  if (!selected) {
    return { ok: false, status: 404, error: "Contact not found for this job." };
  }

  const requestedChannel = normalizeOutreachChannel_(input.channel || selected.channel || "LINKEDIN");
  const profile = await loadOutreachProfileContext_(env, {
    job_key: jobKey,
    profile_id: String(input.profile_id || "").trim(),
  });
  const evidenceRows = await loadOutreachEvidenceRows_(env, { job_key: jobKey, limit: 12 });

  const ai = toBool_(input.use_ai, true) ? getAi_(env) : null;
  const drafted = await draftOutreachMessage_({
    ai,
    channel: requestedChannel,
    job,
    contact: selected,
    profile,
    evidence_rows: evidenceRows,
  });
  const draft = String(drafted?.draft || "").trim();
  if (!draft) return { ok: false, status: 500, error: "Draft generation failed." };

  const touchpoint = await upsertOutreachTouchpointDraft_(env, {
    contact_id: selected.id,
    job_key: jobKey,
    channel: requestedChannel,
    draft,
  });

  await logEvent_(env, "OUTREACH_DRAFTED", jobKey, {
    contact_id: selected.id,
    channel: requestedChannel,
    used_ai: Boolean(drafted?.used_ai),
    ai_model: drafted?.model || null,
    contacts_count: contacts.length,
    evidence_count: Array.isArray(drafted?.evidence) ? drafted.evidence.length : 0,
    profile_id: profile.profile_id,
    ts: Date.now(),
  });

  return {
    ok: true,
    status: 200,
    data: {
      job_key: jobKey,
      channel: requestedChannel,
      contacts_count: contacts.length,
      contacts: contacts.map((c) => ({
        ...c,
        selected: c.id === selected.id,
      })),
      selected_contact: {
        ...selected,
        channel: requestedChannel,
      },
      evidence_matches: Array.isArray(drafted?.evidence) ? drafted.evidence : [],
      draft,
      touchpoint,
      used_ai: Boolean(drafted?.used_ai),
      ai_model: drafted?.model || null,
      usage: drafted?.usage || null,
    },
  };
}

async function getResumeDraftSchema_(env) {
  try {
    const rows = await env.DB.prepare(`PRAGMA table_info(resume_drafts);`).all();
    const names = new Set((rows.results || []).map((r) => String(r.name || "").trim()));
    return {
      hasRrPushFields:
        names.has("rr_resume_id") &&
        names.has("rr_last_pushed_at") &&
        names.has("rr_last_push_status") &&
        names.has("rr_last_push_error"),
      hasRrPdfFields:
        names.has("rr_pdf_url") &&
        names.has("rr_pdf_last_exported_at") &&
        names.has("rr_pdf_last_export_status") &&
        names.has("rr_pdf_last_export_error"),
    };
  } catch {
    return { hasRrPushFields: false, hasRrPdfFields: false };
  }
}

async function hasResumeDraftVersions_(env) {
  try {
    const row = await env.DB.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'resume_draft_versions'
      LIMIT 1;
    `.trim()).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function listDraftVersions_(env, { jobKey, profileId = "", limit = 20 } = {}) {
  if (!await hasResumeDraftVersions_(env)) return [];
  const lim = clampInt_(limit || 20, 1, 100);
  const rows = profileId
    ? await env.DB.prepare(`
        SELECT id, version_no, source_action, status, created_at, ats_json
        FROM resume_draft_versions
        WHERE job_key = ? AND profile_id = ?
        ORDER BY created_at DESC
        LIMIT ?;
      `.trim()).bind(jobKey, profileId, lim).all()
    : await env.DB.prepare(`
        SELECT id, version_no, source_action, status, created_at, ats_json
        FROM resume_draft_versions
        WHERE job_key = ?
        ORDER BY created_at DESC
        LIMIT ?;
      `.trim()).bind(jobKey, lim).all();

  return (rows.results || []).map((r) => {
    const ats = safeJsonParse_(r.ats_json) || {};
    return {
      id: r.id,
      version_no: numOrNull_(r.version_no),
      source_action: String(r.source_action || "").trim(),
      status: String(r.status || "").trim(),
      created_at: numOrNull_(r.created_at),
      ats_score: numOrNull_(ats.score),
    };
  });
}

async function insertDraftVersion_(env, {
  jobKey,
  profileId,
  draftId,
  sourceAction,
  packJson,
  atsJson,
  rrExportJson,
  controlsJson,
  status,
  errorText = "",
  createdAt = Date.now(),
} = {}) {
  if (!await hasResumeDraftVersions_(env)) return null;
  const versionId = crypto.randomUUID();
  const created = numOrNull_(createdAt) || Date.now();
  const versionRow = await env.DB.prepare(`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
    FROM resume_draft_versions
    WHERE draft_id = ?;
  `.trim()).bind(draftId).first();
  const versionNo = numOr_(versionRow?.next_version, 1);

  await env.DB.prepare(`
    INSERT INTO resume_draft_versions (
      id, job_key, profile_id, draft_id, version_no, source_action,
      pack_json, ats_json, rr_export_json, controls_json, status, error_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `.trim()).bind(
    versionId,
    String(jobKey || "").trim(),
    String(profileId || "").trim(),
    String(draftId || "").trim(),
    versionNo,
    String(sourceAction || "generate").trim().slice(0, 40) || "generate",
    JSON.stringify(packJson || {}),
    JSON.stringify(atsJson || {}),
    JSON.stringify(rrExportJson || {}),
    JSON.stringify(controlsJson || {}),
    String(status || "CONTENT_REVIEW_REQUIRED").trim().slice(0, 40) || "CONTENT_REVIEW_REQUIRED",
    String(errorText || "").slice(0, 1000),
    created
  ).run();

  return { id: versionId, version_no: versionNo };
}

async function createResumeDraftVersionFromLatest_(env, {
  draftId,
  jobKey,
  profileId,
  sourceAction = "generate",
  controls = {},
} = {}) {
  if (!await hasResumeDraftVersions_(env)) return null;
  const row = await env.DB.prepare(`
    SELECT id, job_key, profile_id, pack_json, ats_json, rr_export_json, status, error_text
    FROM resume_drafts
    WHERE id = ?
    LIMIT 1;
  `.trim()).bind(draftId).first();
  if (!row) return null;
  const packJson = safeJsonParse_(row.pack_json) || {};
  const atsJson = safeJsonParse_(row.ats_json) || {};
  const rrExportJson = safeJsonParse_(row.rr_export_json) || {};
  const controlsJson = (controls && Object.keys(controls).length)
    ? controls
    : ((packJson?.controls && typeof packJson.controls === "object") ? packJson.controls : {});
  return insertDraftVersion_(env, {
    jobKey: String(jobKey || row.job_key || "").trim(),
    profileId: String(profileId || row.profile_id || "").trim(),
    draftId: row.id,
    sourceAction,
    packJson,
    atsJson,
    rrExportJson,
    controlsJson,
    status: row.status,
    errorText: row.error_text || "",
    createdAt: Date.now(),
  });
}

async function restoreDraftVersion_(env, {
  jobKey,
  profileId = "",
  versionId,
} = {}) {
  if (!await hasResumeDraftVersions_(env)) return null;
  const row = profileId
    ? await env.DB.prepare(`
        SELECT *
        FROM resume_draft_versions
        WHERE id = ? AND job_key = ? AND profile_id = ?
        LIMIT 1;
      `.trim()).bind(versionId, jobKey, profileId).first()
    : await env.DB.prepare(`
        SELECT *
        FROM resume_draft_versions
        WHERE id = ? AND job_key = ?
        LIMIT 1;
      `.trim()).bind(versionId, jobKey).first();
  if (!row) return null;

  const now = Date.now();
  const draft = await env.DB.prepare(`
    SELECT id
    FROM resume_drafts
    WHERE id = ?
    LIMIT 1;
  `.trim()).bind(row.draft_id).first();
  if (!draft?.id) return null;

  await env.DB.prepare(`
    UPDATE resume_drafts
    SET pack_json = ?, ats_json = ?, rr_export_json = ?, status = ?, error_text = ?, updated_at = ?
    WHERE id = ?;
  `.trim()).bind(
    row.pack_json,
    row.ats_json,
    row.rr_export_json,
    String(row.status || "CONTENT_REVIEW_REQUIRED"),
    String(row.error_text || "").slice(0, 1000),
    now,
    row.draft_id
  ).run();

  const controls = safeJsonParse_(row.controls_json) || {};
  controls.reverted_from_version_id = versionId;
  const inserted = await insertDraftVersion_(env, {
    jobKey: row.job_key,
    profileId: row.profile_id,
    draftId: row.draft_id,
    sourceAction: "revert",
    packJson: safeJsonParse_(row.pack_json) || {},
    atsJson: safeJsonParse_(row.ats_json) || {},
    rrExportJson: safeJsonParse_(row.rr_export_json) || {},
    controlsJson: controls,
    status: String(row.status || "CONTENT_REVIEW_REQUIRED"),
    errorText: String(row.error_text || ""),
    createdAt: now,
  });

  return {
    job_key: row.job_key,
    profile_id: row.profile_id,
    draft_id: row.draft_id,
    restored_from_version_id: versionId,
    status: String(row.status || "CONTENT_REVIEW_REQUIRED"),
    version_id: inserted?.id || null,
    version_no: inserted?.version_no || null,
  };
}

function applyOnePageCaps_(summaryIn, bulletsIn) {
  const summary = trimTextToMaxChars_(String(summaryIn || "").trim(), 320);
  const bullets = (Array.isArray(bulletsIn) ? bulletsIn : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  return { summary, bullets };
}

function trimTextToMaxChars_(text, maxChars = 320) {
  const s = String(text || "").trim();
  const max = Number.isFinite(Number(maxChars)) ? Math.max(80, Number(maxChars)) : 320;
  if (!s || s.length <= max) return s;
  const clipped = s.slice(0, max);
  const lastSentence = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("! "), clipped.lastIndexOf("? "));
  if (lastSentence >= 120) return clipped.slice(0, lastSentence + 1).trim();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= 80) return `${clipped.slice(0, lastSpace).trim()}...`;
  return `${clipped.trim()}...`;
}

function recomputeReviewedAts_(packJson, prevAts) {
  const pack = packJson && typeof packJson === "object" ? packJson : {};
  const atsPrev = prevAts && typeof prevAts === "object" ? prevAts : {};
  const must = normalizeKeywordArray_(pack?.tailoring?.must_keywords || []);
  const nice = normalizeKeywordArray_(pack?.tailoring?.nice_keywords || []);
  const summary = String(pack?.tailoring?.summary || "").trim();
  const bullets = Array.isArray(pack?.tailoring?.bullets) ? pack.tailoring.bullets.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const coverage = computeCoverageFromText_(must, nice, `${summary}\n${bullets.join("\n")}`);
  return {
    ...atsPrev,
    score: coverage.score,
    missing_keywords: coverage.missing,
    coverage: coverage.coverage,
    notes: coverage.notes,
  };
}

function computeCoverageFromText_(mustList, niceList, text) {
  const must = normalizeKeywordArray_(mustList);
  const nice = normalizeKeywordArray_(niceList);
  const low = String(text || "").toLowerCase();
  const mustHit = must.filter((k) => low.includes(k.toLowerCase()));
  const niceHit = nice.filter((k) => low.includes(k.toLowerCase()));
  const missing = must.filter((k) => !mustHit.includes(k));
  const mustScore = must.length ? Math.round((mustHit.length / must.length) * 100) : 100;
  const niceScore = nice.length ? Math.round((niceHit.length / nice.length) * 100) : 60;
  const score = clampInt_(Math.round((mustScore * 0.7) + (niceScore * 0.3)), 0, 100);
  return {
    score,
    missing,
    coverage: {
      must_total: must.length,
      must_hit: mustHit.length,
      nice_total: nice.length,
      nice_hit: niceHit.length,
    },
    notes: missing.length ? `Add evidence for: ${missing.slice(0, 8).join(", ")}` : "Good keyword coverage",
  };
}

function normalizeKeywordArray_(v) {
  return unique_((Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean));
}

function normalizeOnePageMode_(v) {
  const raw = String(v || "").trim().toLowerCase();
  if (raw === "hard" || raw === "soft") return raw;
  return "";
}

function resolveDefaultOnePageMode_(job) {
  const status = String(job?.status || "").trim().toUpperCase();
  const score = Number(job?.final_score);
  if (status === "SHORTLISTED" || status === "APPLIED") return "hard";
  if (Number.isFinite(score) && score >= 75) return "hard";
  return "soft";
}

async function loadTargets_(env) {
  const targetSchema = await getTargetsSchema_(env);
  const rejectSelect = targetSchema.hasRejectKeywords ? "reject_keywords_json" : "'[]' AS reject_keywords_json";
  const rubricSelect = targetSchema.hasRubricProfile ? "rubric_profile" : "'auto' AS rubric_profile";
  const res = await env.DB.prepare(`
    SELECT id, name, primary_role, seniority_pref, location_pref,
           must_keywords_json, nice_keywords_json, ${rejectSelect}, ${rubricSelect}
    FROM targets
    ORDER BY updated_at DESC;
  `.trim()).all();

  const rows = res.results || [];
  return rows.map((t) => ({
    id: String(t.id || "").trim(),
    name: String(t.name || "").trim(),
    primaryRole: String(t.primary_role || "").trim(),
    seniorityPref: String(t.seniority_pref || "").trim(),
    locationPref: String(t.location_pref || "").trim(),
    rubricProfile: normalizeRubricProfile_(t.rubric_profile || "auto"),
    rubric_profile: normalizeRubricProfile_(t.rubric_profile || "auto"),
    must: safeJsonParseArray_(t.must_keywords_json),
    nice: safeJsonParseArray_(t.nice_keywords_json),
    reject: safeJsonParseArray_(t.reject_keywords_json),
  })).filter((t) => t.id);
}

async function loadSysCfg_(env) {
  // Optional sys_cfg table support; safe defaults if missing
  // columns: key TEXT PRIMARY KEY, value TEXT
  const defaults = { SCORE_THRESHOLD_SHORTLIST: 75, SCORE_THRESHOLD_ARCHIVE: 55, DEFAULT_TARGET_ID: "TGT-001" };
  try {
    const rows = await env.DB.prepare(`SELECT key, value FROM sys_cfg;`).all();
    const cfg = { ...defaults };
    for (const r of (rows.results || [])) {
      const k = String(r.key || "").trim();
      const v = String(r.value || "").trim();
      if (!k) continue;
      if (k === "SCORE_THRESHOLD_SHORTLIST" || k === "SCORE_THRESHOLD_ARCHIVE") cfg[k] = numOr_(v, cfg[k]);
      if (k === "DEFAULT_TARGET_ID") cfg[k] = v || cfg[k];
    }
    return cfg;
  } catch {
    return defaults;
  }
}

function loadScoringHeuristicCfg_(env) {
  return {
    min_jd_chars: clampInt_(env?.SCORING_MIN_JD_CHARS ?? 120, 60, 2000),
    min_target_signal: clampInt_(env?.SCORING_MIN_TARGET_SIGNAL ?? 8, 0, 100),
  };
}

async function loadLatestResumeTailoringForEvidence_(env, jobKey) {
  try {
    const row = await env.DB.prepare(`
      SELECT pack_json
      FROM resume_drafts
      WHERE job_key = ?
      ORDER BY updated_at DESC
      LIMIT 1;
    `.trim()).bind(jobKey).first();
    const pack = safeJsonParse_(row?.pack_json) || {};
    const tailoring = (pack?.tailoring && typeof pack.tailoring === "object") ? pack.tailoring : {};
    return {
      summary: String(tailoring.summary || "").trim(),
      bullets: Array.isArray(tailoring.bullets)
        ? tailoring.bullets.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
    };
  } catch {
    return { summary: "", bullets: [] };
  }
}

async function loadMatchedEvidenceForPack_(env, jobKey, limitIn = 12) {
  const jobKeySafe = String(jobKey || "").trim();
  if (!jobKeySafe) return [];
  const limit = clampInt_(limitIn || 12, 1, 30);
  try {
    const hasEvidenceTable = await hasJobEvidenceTable_(env);
    if (!hasEvidenceTable) return [];
    const res = await env.DB.prepare(`
      SELECT
        requirement_text,
        requirement_type,
        evidence_text,
        confidence_score,
        updated_at
      FROM job_evidence
      WHERE job_key = ? AND matched = 1
      ORDER BY
        CASE requirement_type
          WHEN 'must' THEN 1
          WHEN 'nice' THEN 2
          WHEN 'constraint' THEN 3
          WHEN 'reject' THEN 4
          ELSE 9
        END ASC,
        confidence_score DESC,
        updated_at DESC
      LIMIT ?;
    `.trim()).bind(jobKeySafe, limit).all();
    return (res.results || []).map((row) => ({
      requirement_text: String(row.requirement_text || "").trim(),
      requirement_type: String(row.requirement_type || "").trim().toLowerCase(),
      evidence_text: String(row.evidence_text || "").trim(),
      confidence_score: clampInt_(row.confidence_score, 0, 100),
      updated_at: numOrNull_(row.updated_at) || null,
    })).filter((row) => row.requirement_text);
  } catch {
    return [];
  }
}

function collectEvidenceBulletsFromProfile_(profileObj) {
  const p = profileObj && typeof profileObj === "object" ? profileObj : {};
  const out = [];
  const pushText = (v) => {
    const s = String(v || "").trim();
    if (s) out.push(s);
  };
  const pushMany = (arr) => {
    for (const x of (Array.isArray(arr) ? arr : [])) pushText(x);
  };

  pushMany(p.highlights);
  pushMany(p.bullets);

  for (const exp of (Array.isArray(p.experience) ? p.experience : [])) {
    if (!exp || typeof exp !== "object") continue;
    pushText(exp.title);
    pushText(exp.company);
    pushText(exp.summary || exp.description);
    pushMany(exp.bullets);
    pushMany(exp.highlights);
    pushMany(exp.responsibilities);
    pushMany(exp.accomplishments);
  }

  for (const proj of (Array.isArray(p.projects) ? p.projects : [])) {
    if (!proj || typeof proj !== "object") continue;
    pushText(proj.name);
    pushText(proj.summary || proj.description);
    pushMany(proj.highlights);
    pushMany(proj.bullets);
  }

  return unique_(out).slice(0, 120);
}

function resumeProfileToEvidenceInput_(profileObj) {
  const p = profileObj && typeof profileObj === "object" ? profileObj : {};
  const summary =
    String(
      p.summary ||
      p?.basics?.summary ||
      p?.basics?.headline ||
      ""
    ).trim();

  return {
    summary,
    bullets: collectEvidenceBulletsFromProfile_(p),
  };
}

async function loadResumeProfileForEvidence_(env, profileId = "primary") {
  const pid = String(profileId || "primary").trim() || "primary";
  try {
    let row = await env.DB.prepare(`
      SELECT id, profile_json
      FROM resume_profiles
      WHERE id = ?
      LIMIT 1;
    `.trim()).bind(pid).first();

    if (!row) {
      row = await env.DB.prepare(`
        SELECT id, profile_json
        FROM resume_profiles
        ORDER BY updated_at DESC
        LIMIT 1;
      `.trim()).first();
    }

    if (!row) return { profile_id: null, summary: "", bullets: [] };
    const profileJson = safeJsonParse_(row.profile_json) || {};
    const evidenceInput = resumeProfileToEvidenceInput_(profileJson);
    return {
      profile_id: String(row.id || "").trim() || null,
      summary: evidenceInput.summary,
      bullets: evidenceInput.bullets,
    };
  } catch {
    return { profile_id: null, summary: "", bullets: [] };
  }
}

async function fetchExistingEvidenceJobKeys_(env, jobKeys) {
  const keys = unique_((Array.isArray(jobKeys) ? jobKeys : []).map((k) => String(k || "").trim()).filter(Boolean));
  if (!keys.length) return new Set();

  const placeholders = keys.map(() => "?").join(", ");
  const res = await env.DB.prepare(`
    SELECT DISTINCT job_key
    FROM job_evidence
    WHERE job_key IN (${placeholders});
  `.trim()).bind(...keys).all();

  return new Set((res.results || []).map((r) => String(r.job_key || "").trim()).filter(Boolean));
}

async function bulkRebuildArchivedEvidence_(env, ai, opts = {}) {
  const modeRaw = String(opts.mode || "retry_failed").trim().toLowerCase();
  const mode = (modeRaw === "all_archived" || modeRaw === "retry_failed") ? modeRaw : "retry_failed";
  const limit = clampInt_(opts.limit || 3, 1, 10);
  const delayMs = mode === "retry_failed" ? 2000 : clampInt_(opts.delayMs || 2000, 0, 2000);
  const force = toBool_(opts.force, false);
  const profileId = String(opts.profileId || "primary").trim() || "primary";
  const profileOnly = opts.profileOnly === undefined ? true : toBool_(opts.profileOnly, true);
  const maxTokens = clampInt_(opts.maxTokens || 500, 128, 700);
  const cursorJobKey = String(opts.cursorJobKey || "").trim();

  if (!ai) throw new Error("Missing Workers AI binding (env.AI or AI_BINDING)");
  const hasEvidenceTable = await hasJobEvidenceTable_(env);
  if (!hasEvidenceTable) throw new Error("Evidence schema not enabled in DB");

  let cursorUpdatedAt = null;
  if (cursorJobKey) {
    const cursorRow = await env.DB.prepare(`
      SELECT updated_at
      FROM jobs
      WHERE job_key = ?
      LIMIT 1;
    `.trim()).bind(cursorJobKey).first();
    cursorUpdatedAt = numOrNull_(cursorRow?.updated_at);
  }

  const whereParts = [`UPPER(COALESCE(j.status, '')) = 'ARCHIVED'`];
  const binds = [];
  if (mode === "retry_failed") {
    whereParts.push(`NOT EXISTS (SELECT 1 FROM job_evidence e WHERE e.job_key = j.job_key)`);
  }
  if (cursorJobKey && cursorUpdatedAt !== null) {
    whereParts.push(`(j.updated_at < ? OR (j.updated_at = ? AND j.job_key < ?))`);
    binds.push(cursorUpdatedAt, cursorUpdatedAt, cursorJobKey);
  }

  const sql = `
    SELECT j.job_key, j.job_url, j.source_domain, j.jd_text_clean, j.updated_at
    FROM jobs j
    WHERE ${whereParts.join(" AND ")}
    ORDER BY j.updated_at DESC, j.job_key DESC
    LIMIT ?;
  `.trim();

  const candidatesRes = await env.DB.prepare(sql).bind(...binds, limit + 1).all();
  const candidateRows = (candidatesRes.results || []).map((r) => ({
    job_key: String(r.job_key || "").trim(),
    job_url: String(r.job_url || "").trim(),
    source_domain: String(r.source_domain || "").trim(),
    jd_text_clean: String(r.jd_text_clean || "").trim(),
    updated_at: numOrNull_(r.updated_at) || 0,
  })).filter((r) => r.job_key);

  const hasMore = candidateRows.length > limit;
  const targetJobs = hasMore ? candidateRows.slice(0, limit) : candidateRows;
  const nextCursorJobKey = hasMore && targetJobs.length ? String(targetJobs[targetJobs.length - 1].job_key || "").trim() : null;

  const archivedTotalRow = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM jobs
    WHERE UPPER(COALESCE(status, '')) = 'ARCHIVED';
  `.trim()).first();
  const archivedTotal = Number(archivedTotalRow?.n || 0);

  if (!targetJobs.length) {
    return {
      archived_total: archivedTotal,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped_existing: 0,
      skipped_no_jd: 0,
      rows_created: 0,
      matched_count: 0,
      unmatched_count: 0,
      next_cursor_job_key: null,
      has_more: false,
      max_tokens_used: maxTokens,
      delay_ms_used: delayMs,
      profile_id: null,
      mode,
      forced: force,
      profile_only: profileOnly,
      jobs_processed: 0,
      jobs_skipped_existing: 0,
      jobs_skipped_no_jd: 0,
      jobs_ai_failed: 0,
    };
  }

  const existingEvidenceKeys = (force || mode === "retry_failed")
    ? new Set()
    : await fetchExistingEvidenceJobKeys_(env, targetJobs.map((j) => j.job_key));

  const resumeInput = await loadResumeProfileForEvidence_(env, profileId);
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedExisting = 0;
  let skippedNoJd = 0;
  const allEvidenceRows = [];

  for (const job of targetJobs) {
    const jobKey = String(job.job_key || "").trim();
    if (!jobKey) continue;

    if (!force && mode !== "retry_failed" && existingEvidenceKeys.has(jobKey)) {
      skippedExisting++;
      continue;
    }

    const jdText = cleanJdText_(job.jd_text_clean);
    if (jdText.length < 120) {
      skippedNoJd++;
      continue;
    }

    if (attempted > 0 && delayMs > 0) {
      await sleepMs_(delayMs);
    }
    attempted++;

    try {
      const extracted = sanitizeExtracted_(
        await extractJdWithModel_(ai, jdText, { maxTokens }),
        jdText,
        {
          job_url: job.job_url,
          source_domain: job.source_domain,
          email_subject: "",
        }
      );

      const evidenceRows = buildEvidenceRows_({
        jobKey,
        extractedJd: {
          must_have_keywords: Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : [],
          nice_to_have_keywords: Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : [],
          reject_keywords: Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : [],
          constraints: [],
          jd_text: profileOnly ? "" : jdText,
        },
        resumeJson: resumeInput,
        now: Date.now(),
      });

      if (evidenceRows.length) allEvidenceRows.push(...evidenceRows);
      succeeded++;
    } catch (e) {
      failed++;
      await logEvent_(env, "AI_FAILED", jobKey, {
        route: "bulk-evidence-rebuild-archived-retry",
        error: String(e?.message || e || "unknown").slice(0, 300),
        max_tokens: maxTokens,
        ts: Date.now(),
      });
    }
  }

  const writeResult = allEvidenceRows.length
    ? await upsertJobEvidence_(env, "", allEvidenceRows)
    : { rows_written: 0, matched_count: 0, unmatched_count: 0 };

  return {
    archived_total: archivedTotal,
    attempted,
    succeeded,
    failed,
    skipped_existing: skippedExisting,
    skipped_no_jd: skippedNoJd,
    rows_created: writeResult.rows_written,
    matched_count: writeResult.matched_count,
    unmatched_count: writeResult.unmatched_count,
    next_cursor_job_key: nextCursorJobKey,
    has_more: hasMore,
    max_tokens_used: maxTokens,
    delay_ms_used: delayMs,
    profile_id: resumeInput.profile_id,
    mode,
    forced: force,
    profile_only: profileOnly,
    jobs_processed: succeeded,
    jobs_skipped_existing: skippedExisting,
    jobs_skipped_no_jd: skippedNoJd,
    jobs_ai_failed: failed,
  };
}

function normalizeGapToken_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function synonymsForRequirement_(requirementText) {
  const req = normalizeGapToken_(requirementText);
  if (!req) return [];

  // Prefer exact map key first.
  for (const [key, values] of Object.entries(SYNONYM_MAP)) {
    if (normalizeGapToken_(key) === req) {
      return unique_((values || []).map((x) => String(x || "").trim()).filter(Boolean));
    }
  }

  // Fallback: fuzzy bucket by overlapping key terms.
  const out = [];
  for (const [key, values] of Object.entries(SYNONYM_MAP)) {
    const keyNorm = normalizeGapToken_(key);
    if (!keyNorm) continue;
    const keyWords = keyNorm.split(" ").filter(Boolean);
    const overlap = keyWords.some((w) => req.includes(w));
    if (overlap) out.push(...values);
  }

  if (req.includes("cross functional")) out.push(...(SYNONYM_MAP["Cross-functional Collaboration"] || []));
  if (req.includes("lead")) out.push(...(SYNONYM_MAP["Leadership"] || []));
  if (req.includes("strategy")) out.push(...(SYNONYM_MAP["Business Strategy"] || []));
  if (req.includes("project")) out.push(...(SYNONYM_MAP["Project Management"] || []));
  if (req.includes("process")) out.push(...(SYNONYM_MAP["Process Optimization"] || []));
  if (req.includes("cloud")) out.push(...(SYNONYM_MAP["Cloud Infrastructure"] || []));
  if (req.includes("data")) out.push(...(SYNONYM_MAP["Data Analysis"] || []));
  if (req.includes("ai")) out.push(...(SYNONYM_MAP["AI Integration"] || []));

  return unique_(out.map((x) => String(x || "").trim()).filter(Boolean));
}

function tokenInCorpus_(corpusText, token) {
  const corpus = String(corpusText || "").trim();
  const q = String(token || "").trim();
  if (!corpus || !q) return false;
  const escaped = escapeRegex_(q);
  const useWordBoundary = /^[A-Za-z0-9_][A-Za-z0-9_ ]*[A-Za-z0-9_]$/.test(q);
  const pattern = useWordBoundary ? `\\b${escaped}\\b` : escaped;
  return new RegExp(pattern, "i").test(corpus);
}

function buildSuggestedRewrite_(requirementText, synonymHits, classification) {
  const req = String(requirementText || "").trim();
  if (!req) return "";

  const key = normalizeGapToken_(req);
  if (classification === "vocabulary_gap") {
    const found = Array.isArray(synonymHits) && synonymHits.length ? synonymHits[0] : "";
    if (key === normalizeGapToken_("Leadership")) {
      return `Exercised Leadership by managing a high-performing team of 5 developers and delivering measurable outcomes.${found ? ` Replace "${found}" with "Leadership" where relevant.` : ""}`;
    }
    if (key === normalizeGapToken_("Business Strategy")) {
      return `Defined and executed the Business Strategy and product roadmap for a priority business area.${found ? ` Replace "${found}" with "Business Strategy" where relevant.` : ""}`;
    }
    if (key === normalizeGapToken_("Cross-functional Collaboration")) {
      return `Drove Cross-functional Collaboration with Sales and Engineering to achieve shared delivery goals.${found ? ` Replace "${found}" with "Cross-functional Collaboration" where relevant.` : ""}`;
    }
    return found
      ? `Replace "${found}" with "${req}" in your profile to trigger the ATS filter.`
      : `Use the exact keyword "${req}" in a quantified bullet to trigger ATS matching.`;
  }
  if (classification === "true_gap") {
    return `Acquire or document "${req}" experience. This is a recurring bottleneck in your archive.`;
  }
  return `Keep "${req}" explicit in summary/bullets where relevant.`;
}

function classifyGap_(requirementText, profileCorpusText) {
  const requirement = String(requirementText || "").trim();
  const corpus = String(profileCorpusText || "").trim();
  if (!requirement || !corpus) {
    return {
      status: "true_gap",
      synonym_hits: [],
      suggestion: `Acquire or document "${requirement}" experience. This is a recurring bottleneck in your archive.`,
    };
  }

  const exactHit = tokenInCorpus_(corpus, requirement);
  if (exactHit) {
    return { status: "matched", synonym_hits: [], suggestion: null };
  }

  const synonyms = synonymsForRequirement_(requirement);
  const synonymHits = synonyms.filter((s) => tokenInCorpus_(corpus, s));
  if (synonymHits.length > 0) {
    return {
      status: "vocabulary_gap",
      synonym_hits: synonymHits,
      suggestion: buildSuggestedRewrite_(requirement, synonymHits, "vocabulary_gap"),
    };
  }

  return {
    status: "true_gap",
    synonym_hits: [],
    suggestion: buildSuggestedRewrite_(requirement, [], "true_gap"),
  };
}

async function loadProfileCorpusForGap_(env, profileId = "primary") {
  const pid = String(profileId || "primary").trim() || "primary";
  const tableOrder = ["profiles", "resume_profiles"];

  for (const table of tableOrder) {
    for (const strategy of ["by_id", "latest"]) {
      try {
        const row = strategy === "by_id"
          ? await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1;`).bind(pid).first()
          : await env.DB.prepare(`SELECT * FROM ${table} ORDER BY updated_at DESC LIMIT 1;`).first();
        if (!row) continue;

        const rawProfileJson =
          row.profile_json ??
          row.resume_json ??
          row.profile ??
          row.data_json ??
          row.data ??
          "";

        const parsed = safeJsonParse_(rawProfileJson);
        const evidenceInput = resumeProfileToEvidenceInput_(parsed && typeof parsed === "object" ? parsed : {});

        const rawStrings = Object.entries(row)
          .filter(([k, v]) => typeof v === "string" && !["id", "name", "created_at", "updated_at"].includes(k))
          .map(([, v]) => String(v || "").trim())
          .filter(Boolean);

        const corpus = unique_([
          evidenceInput.summary,
          ...(Array.isArray(evidenceInput.bullets) ? evidenceInput.bullets : []),
          ...rawStrings,
        ].map((x) => String(x || "").trim()).filter(Boolean)).join("\n");

        return {
          profile_id: String(row.id || pid).trim() || pid,
          source_table: table,
          corpus: normalizeEvidenceText_(corpus),
        };
      } catch {
        // Table may not exist in this environment; continue.
      }
    }
  }

  return { profile_id: null, source_table: null, corpus: "" };
}

async function getEvidenceGapReport_(env, opts = {}) {
  const status = String(opts.status || "ARCHIVED").trim().toUpperCase() || "ARCHIVED";
  const top = clampInt_(opts.top || 5, 1, 20);
  const minMissed = clampInt_(opts.minMissed || 1, 1, 1000);
  const profileId = String(opts.profileId || "primary").trim() || "primary";

  const topRes = await env.DB.prepare(`
    SELECT requirement_text, COUNT(*) AS missed_count
    FROM job_evidence
    WHERE matched = 0
      AND LOWER(COALESCE(requirement_type, '')) = 'must'
      AND job_key IN (
        SELECT job_key
        FROM jobs
        WHERE UPPER(COALESCE(status, '')) = ?
      )
      AND TRIM(COALESCE(requirement_text, '')) <> ''
    GROUP BY requirement_text
    HAVING COUNT(*) >= ?
    ORDER BY missed_count DESC, requirement_text ASC
    LIMIT ?;
  `.trim()).bind(status, minMissed, top).all();
  const topMissing = (topRes.results || []).map((r) => ({
    requirement_text: String(r.requirement_text || "").trim(),
    missed_count: Number(r.missed_count || 0),
  })).filter((r) => r.requirement_text && r.missed_count > 0);

  const profileCorpus = await loadProfileCorpusForGap_(env, profileId);
  const corpus = String(profileCorpus.corpus || "");

  const vocabularyGapCandidates = topMissing.map((row) => {
    const requirement = row.requirement_text;
    const gap = classifyGap_(requirement, corpus);

    return {
      requirement_text: requirement,
      missed_count: row.missed_count,
      synonym_hits: Array.isArray(gap.synonym_hits) ? gap.synonym_hits : [],
      suggested_rewrite: gap.suggestion,
      classification: String(gap.status || "unknown"),
    };
  });

  const totalRow = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM jobs
    WHERE UPPER(COALESCE(status, '')) = ?;
  `.trim()).bind(status).first();

  const withEvidenceRow = await env.DB.prepare(`
    SELECT COUNT(DISTINCT j.job_key) AS n
    FROM jobs j
    JOIN job_evidence e ON e.job_key = j.job_key
    WHERE UPPER(COALESCE(j.status, '')) = ?;
  `.trim()).bind(status).first();

  const analyzedJobsRow = await env.DB.prepare(`
    SELECT COUNT(DISTINCT e.job_key) AS n
    FROM job_evidence e
    JOIN jobs j ON j.job_key = e.job_key
    WHERE UPPER(COALESCE(j.status, '')) = ?
      AND LOWER(COALESCE(e.requirement_type, '')) = 'must';
  `.trim()).bind(status).first();

  return {
    top_missing_must: topMissing,
    vocabulary_gap_candidates: vocabularyGapCandidates,
    coverage_meta: {
      archived_total: Number(totalRow?.n || 0),
      archived_with_evidence: Number(withEvidenceRow?.n || 0),
      analyzed_jobs: Number(analyzedJobsRow?.n || 0),
    },
    status,
    top,
    min_missed: minMissed,
    profile_id: profileCorpus.profile_id,
    profile_source_table: profileCorpus.source_table,
  };
}

function buildEvidenceRows_({ jobKey, extractedJd, resumeJson, now } = {}) {
  const ts = numOrNull_(now) || Date.now();
  const ej = extractedJd && typeof extractedJd === "object" ? extractedJd : {};
  const rj = resumeJson && typeof resumeJson === "object" ? resumeJson : {};

  const summary = String(rj.summary || "").trim();
  const bullets = Array.isArray(rj.bullets) ? rj.bullets.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const jdText = String(ej.jd_text || ej.jd_clean || "").trim();

  const groups = [
    { type: "must", items: normalizeKeywords_(ej.must_have_keywords || []) },
    { type: "nice", items: normalizeKeywords_(ej.nice_to_have_keywords || []) },
    { type: "reject", items: normalizeKeywords_(ej.reject_keywords || []) },
    { type: "constraint", items: normalizeKeywords_(ej.constraints || []) },
  ];

  const rows = [];
  const seen = new Set();
  for (const g of groups) {
    for (const req of (g.items || [])) {
      const requirementText = String(req || "").trim();
      if (!requirementText) continue;
      const dedupeKey = `${g.type}::${requirementText.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const reqNorm = normalizeEvidenceText_(requirementText);
      let matched = 0;
      let confidence = 0;
      let source = "none";
      let evidenceText = "";

      const summaryHit = findEvidence_(summary, requirementText, 220);
      if (summaryHit) {
        matched = 1;
        confidence = 95;
        source = "resume_summary";
        evidenceText = summaryHit;
      } else {
        const bulletHit = bullets.find((b) => findEvidence_(b, requirementText, 220));
        const bulletSnippet = bulletHit ? findEvidence_(bulletHit, requirementText, 220) : null;
        if (bulletSnippet) {
          matched = 1;
          confidence = 88;
          source = "resume_bullets";
          evidenceText = bulletSnippet;
        }
      }

      if (!matched) {
        const jdHit = findEvidence_(jdText, requirementText, 220);
        if (jdHit) {
          matched = 1;
          confidence = 70;
          source = "jd_text";
          evidenceText = jdHit;
        }
      }

      // Fallback for special keyword/token edge cases after regex pass.
      if (!matched && reqNorm) {
        const summaryNorm = normalizeEvidenceText_(summary);
        const bulletsNorm = normalizeEvidenceText_(bullets.join("\n"));
        const jdNorm = normalizeEvidenceText_(jdText);
        if (summaryNorm.includes(reqNorm)) {
          matched = 1;
          confidence = 95;
          source = "resume_summary";
          evidenceText = cappedEvidenceSnippet_(summary, requirementText, 220);
        } else if (bulletsNorm.includes(reqNorm)) {
          matched = 1;
          confidence = 88;
          source = "resume_bullets";
          const bulletFallback = bullets.find((b) => normalizeEvidenceText_(b).includes(reqNorm)) || "";
          evidenceText = cappedEvidenceSnippet_(bulletFallback, requirementText, 220);
        } else if (jdNorm.includes(reqNorm)) {
          matched = 1;
          confidence = 70;
          source = "jd_text";
          evidenceText = cappedEvidenceSnippet_(jdText, requirementText, 220);
        }
      }

      rows.push({
        id: crypto.randomUUID(),
        job_key: String(jobKey || "").trim(),
        requirement_text: requirementText,
        requirement_type: g.type,
        evidence_text: String(evidenceText || "").slice(0, 220),
        evidence_source: source,
        confidence_score: confidence,
        matched,
        notes: matched ? "" : "No deterministic match in summary/bullets/JD",
        created_at: ts,
        updated_at: ts,
      });
    }
  }

  return rows;
}

async function upsertJobEvidence_(env, jobKey, evidenceRows) {
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];
  if (!rows.length) {
    return { rows_written: 0, matched_count: 0, unmatched_count: 0 };
  }

  const statements = rows.map((row) => env.DB.prepare(`
    INSERT INTO job_evidence (
      id, job_key, requirement_text, requirement_type,
      evidence_text, evidence_source, confidence_score, matched,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_key, requirement_text, requirement_type) DO UPDATE SET
      evidence_text = excluded.evidence_text,
      evidence_source = excluded.evidence_source,
      confidence_score = excluded.confidence_score,
      matched = excluded.matched,
      notes = excluded.notes,
      updated_at = excluded.updated_at;
  `.trim()).bind(
    String(row.id || crypto.randomUUID()),
    String(jobKey || row.job_key || "").trim(),
    String(row.requirement_text || "").trim(),
    String(row.requirement_type || "").trim(),
    String(row.evidence_text || "").slice(0, 220),
    String(row.evidence_source || "none"),
    clampInt_(row.confidence_score, 0, 100),
    toBool_(row.matched, false) ? 1 : 0,
    String(row.notes || "").slice(0, 500),
    numOrNull_(row.created_at) || Date.now(),
    numOrNull_(row.updated_at) || Date.now()
  ));

  await env.DB.batch(statements);
  const matchedCount = rows.filter((x) => toBool_(x.matched, false)).length;
  return {
    rows_written: rows.length,
    matched_count: matchedCount,
    unmatched_count: rows.length - matchedCount,
  };
}

function normalizeEvidenceText_(v) {
  return String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function findEvidence_(text, keyword, maxLen = 220) {
  const hay = String(text || "").replace(/\s+/g, " ").trim();
  const q = String(keyword || "").trim();
  if (!hay || !q) return null;

  const escaped = escapeRegex_(q);
  const useWordBoundary = /^[A-Za-z0-9_][A-Za-z0-9_ ]*[A-Za-z0-9_]$/.test(q);
  const pattern = useWordBoundary ? `\\b${escaped}\\b` : escaped;
  const regex = new RegExp(pattern, "i");
  const match = regex.exec(hay);
  if (!match) return null;

  const idx = Number(match.index || 0);
  const len = Math.max(1, String(match[0] || q).length);
  return snippetWindow_(hay, idx, len, maxLen);
}

function escapeRegex_(keyword) {
  return String(keyword || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetWindow_(text, index, matchLen, maxLen = 220) {
  const src = String(text || "");
  const max = clampInt_(maxLen, 40, 1000);
  const idx = clampInt_(index, 0, src.length);
  const mlen = clampInt_(matchLen, 1, max);
  const left = Math.max(0, idx - Math.floor((max - mlen) / 2));
  const right = Math.min(src.length, left + max);
  const snippet = src.substring(left, right).trim();
  if (!snippet) return "";
  const prefix = left > 0 ? "..." : "";
  const suffix = right < src.length ? "..." : "";
  return `${prefix}${snippet}${suffix}`;
}

function cappedEvidenceSnippet_(text, needle, maxLen = 220) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  const max = clampInt_(maxLen, 40, 1000);
  if (!src) return "";
  if (!needle) return src.slice(0, max);

  const low = src.toLowerCase();
  const q = String(needle || "").toLowerCase().trim();
  const idx = low.indexOf(q);
  if (idx < 0) return src.slice(0, max);

  const left = Math.max(0, idx - Math.floor((max - q.length) / 2));
  const right = Math.min(src.length, left + max);
  return src.slice(left, right);
}

function decorateJobRow_(row) {
  row.skills = safeJsonParseArray_(row.skills_json);
  row.must_have_keywords = safeJsonParseArray_(row.must_have_keywords_json);
  row.nice_to_have_keywords = safeJsonParseArray_(row.nice_to_have_keywords_json);
  row.reject_keywords = safeJsonParseArray_(row.reject_keywords_json);
  row.reject_reasons = safeJsonParseArray_(row.reject_reasons_json);
  row.fetch_debug = safeJsonParse_(row.fetch_debug_json) || {};
  row.ingest_channel = normalizeIngestChannel_(row.fetch_debug?.ingest_channel) || null;
  row.jd_confidence = String(row.fetch_debug?.jd_confidence || "").trim().toLowerCase() || null;
  const display = computeDisplayFields_(row);
  row.display_title = display.display_title;
  row.display_company = display.display_company;
}

function applyLatestTouchpointToJobRow_(row, touchpoint, nowMs = Date.now()) {
  const r = (row && typeof row === "object") ? row : {};
  const tp = (touchpoint && typeof touchpoint === "object") ? touchpoint : {};
  const touchAt = normalizeEpochMs_(tp.last_touchpoint_at);
  const touchStatus = String(tp.last_touchpoint_status || "").trim().toUpperCase() || null;
  const touchChannel = String(tp.last_touchpoint_channel || "").trim().toUpperCase() || null;
  let daysSince = null;
  if (touchAt && Number.isFinite(nowMs) && nowMs >= touchAt) {
    daysSince = Math.floor((nowMs - touchAt) / (24 * 60 * 60 * 1000));
  }
  r.last_touchpoint_at = touchAt;
  r.last_touchpoint_status = touchStatus;
  r.last_touchpoint_channel = touchChannel;
  r.days_since_touchpoint = Number.isFinite(daysSince) ? Math.max(0, daysSince) : null;
  return r;
}

async function loadLatestTouchpointsByJobKey_(env, jobKeys = []) {
  const keys = unique_((jobKeys || []).map((x) => String(x || "").trim()).filter(Boolean)).slice(0, 500);
  if (!keys.length) return {};

  const storage = await hasContactsStorage_(env);
  if (!storage?.enabled) return {};

  const placeholders = keys.map(() => "?").join(", ");
  const rowTsExpr = "COALESCE(ct.updated_at, ct.created_at, 0)";
  const sql = `
    SELECT
      ct.job_key,
      upper(COALESCE(ct.status, 'DRAFT')) AS status,
      upper(COALESCE(ct.channel, 'OTHER')) AS channel,
      CASE
        WHEN ${rowTsExpr} < 100000000000 THEN ${rowTsExpr} * 1000
        ELSE ${rowTsExpr}
      END AS updated_at_ms
    FROM contact_touchpoints ct
    INNER JOIN (
      SELECT
        job_key,
        MAX(COALESCE(updated_at, created_at, 0)) AS latest_ts
      FROM contact_touchpoints
      WHERE job_key IN (${placeholders})
      GROUP BY job_key
    ) latest
      ON latest.job_key = ct.job_key
      AND COALESCE(ct.updated_at, ct.created_at, 0) = latest.latest_ts
    ORDER BY ct.job_key ASC, ct.id DESC;
  `.trim();

  try {
    const res = await env.DB.prepare(sql).bind(...keys).all();
    const out = {};
    for (const row of (res.results || [])) {
      const jobKey = String(row?.job_key || "").trim();
      if (!jobKey || out[jobKey]) continue;
      out[jobKey] = {
        last_touchpoint_at: normalizeEpochMs_(row?.updated_at_ms),
        last_touchpoint_status: String(row?.status || "").trim().toUpperCase() || null,
        last_touchpoint_channel: String(row?.channel || "").trim().toUpperCase() || null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function loadUiMetrics_(env) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const statusDefaults = {
    NEW: 0,
    SCORED: 0,
    SHORTLISTED: 0,
    APPLIED: 0,
    REJECTED: 0,
    ARCHIVED: 0,
    LINK_ONLY: 0,
  };
  const systemDefaults = {
    NEEDS_MANUAL_JD: 0,
    AI_UNAVAILABLE: 0,
  };

  const statusRows = await env.DB.prepare(`
    SELECT UPPER(COALESCE(status, 'UNKNOWN')) AS k, COUNT(*) AS c
    FROM jobs
    GROUP BY UPPER(COALESCE(status, 'UNKNOWN'));
  `.trim()).all();
  for (const r of (statusRows.results || [])) {
    const key = String(r.k || "UNKNOWN").toUpperCase();
    statusDefaults[key] = Number(r.c || 0);
  }

  const systemRows = await env.DB.prepare(`
    SELECT UPPER(TRIM(system_status)) AS k, COUNT(*) AS c
    FROM jobs
    WHERE TRIM(COALESCE(system_status, '')) != ''
    GROUP BY UPPER(TRIM(system_status));
  `.trim()).all();
  for (const r of (systemRows.results || [])) {
    const key = String(r.k || "").toUpperCase();
    if (!key) continue;
    systemDefaults[key] = Number(r.c || 0);
  }

  const sourceRows = await env.DB.prepare(`
    SELECT LOWER(COALESCE(source_domain, 'unknown')) AS source, COUNT(*) AS c
    FROM jobs
    GROUP BY LOWER(COALESCE(source_domain, 'unknown'))
    ORDER BY c DESC;
  `.trim()).all();

  const totals = await env.DB.prepare(`
    SELECT
      COUNT(*) AS jobs_total,
      SUM(CASE WHEN final_score IS NOT NULL THEN 1 ELSE 0 END) AS scored_jobs,
      AVG(CASE WHEN final_score IS NOT NULL THEN final_score END) AS avg_final_score
    FROM jobs;
  `.trim()).first();

  const pollRows = await env.DB.prepare(`
    SELECT payload_json, ts
    FROM events
    WHERE event_type = 'GMAIL_POLL' AND ts >= ?
    ORDER BY ts DESC
    LIMIT 300;
  `.trim()).bind(dayAgo).all();

  const latestPollRow = await env.DB.prepare(`
    SELECT payload_json, ts
    FROM events
    WHERE event_type = 'GMAIL_POLL'
    ORDER BY ts DESC
    LIMIT 1;
  `.trim()).first();

  const poll24 = {
    poll_runs: 0,
    scanned: 0,
    processed: 0,
    skipped_existing: 0,
    inserted_or_updated: 0,
    inserted_count: 0,
    updated_count: 0,
    link_only: 0,
    ignored: 0,
    skipped_promotional: 0,
  };
  for (const r of (pollRows.results || [])) {
    const p = safeJsonParse_(r.payload_json) || {};
    poll24.poll_runs += 1;
    poll24.scanned += numOr_(p.scanned, 0);
    poll24.processed += numOr_(p.processed, 0);
    poll24.skipped_existing += numOr_(p.skipped_existing ?? p.skipped_already_ingested, 0);
    poll24.inserted_or_updated += numOr_(p.inserted_or_updated, 0);
    poll24.inserted_count += numOr_(p.inserted_count, 0);
    poll24.updated_count += numOr_(p.updated_count, 0);
    poll24.link_only += numOr_(p.link_only, 0);
    poll24.ignored += numOr_(p.ignored, 0);
    poll24.skipped_promotional += numOr_(p.skipped_promotional, 0);
  }

  const latestPayload = safeJsonParse_(latestPollRow?.payload_json) || {};
  const latestPoll = {
    ts: numOrNull_(latestPollRow?.ts),
    query_used: String(latestPayload.query_used || ""),
    scanned: numOr_(latestPayload.scanned, 0),
    processed: numOr_(latestPayload.processed, 0),
    skipped_existing: numOr_(latestPayload.skipped_existing ?? latestPayload.skipped_already_ingested, 0),
    inserted_or_updated: numOr_(latestPayload.inserted_or_updated, 0),
    inserted_count: numOr_(latestPayload.inserted_count, 0),
    updated_count: numOr_(latestPayload.updated_count, 0),
    link_only: numOr_(latestPayload.link_only, 0),
    ignored: numOr_(latestPayload.ignored, 0),
    skipped_promotional: numOr_(latestPayload.skipped_promotional, 0),
  };

  const eventRows = await env.DB.prepare(`
    SELECT event_type, COUNT(*) AS c
    FROM events
    WHERE ts >= ?
    GROUP BY event_type
    ORDER BY c DESC
    LIMIT 30;
  `.trim()).bind(dayAgo).all();

  return {
    generated_at: now,
    statuses: statusDefaults,
    systems: systemDefaults,
    sources: (sourceRows.results || []).map((r) => ({
      source: String(r.source || "unknown"),
      count: Number(r.c || 0),
    })),
    totals: {
      jobs_total: Number(totals?.jobs_total || 0),
      scored_jobs: Number(totals?.scored_jobs || 0),
      avg_final_score: Number.isFinite(Number(totals?.avg_final_score))
        ? Math.round(Number(totals.avg_final_score) * 10) / 10
        : null,
    },
    gmail: {
      latest: latestPoll,
      last_24h: poll24,
    },
    events_last_24h: (eventRows.results || []).map((r) => ({
      event_type: String(r.event_type || ""),
      count: Number(r.c || 0),
    })),
  };
}

function computeDisplayFields_(row) {
  const roleTitle = cleanHumanLabel_(row?.role_title);
  const company = cleanHumanLabel_(row?.company);
  const systemStatus = String(row?.system_status || "").trim().toUpperCase();
  const inferredTitle = inferDisplayTitleFromUrl_(row?.job_url, row?.source_domain);

  const displayTitle = roleTitle
    ? roleTitle
    : (company
      ? company
      : (inferredTitle
        ? inferredTitle
      : (systemStatus === "AI_UNAVAILABLE"
        ? "(Needs AI)"
        : (systemStatus === "NEEDS_MANUAL_JD" ? "(Needs JD)" : "(Untitled)"))));

  return {
    display_title: displayTitle,
    display_company: company || "",
  };
}

function inferDisplayTitleFromUrl_(jobUrl, sourceDomain) {
  const source = String(sourceDomain || "").toLowerCase();
  const urlStr = String(jobUrl || "").trim();
  if (!urlStr) return "";
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return "";
  }

  const segs = u.pathname.split("/").filter(Boolean);
  const last = decodeURIComponent(String(segs[segs.length - 1] || "")).toLowerCase();
  if (!last) return "";

  // LinkedIn /jobs/view/<id>/ cannot provide role text, so keep explicit placeholder.
  if (source === "linkedin") return "";

  // IIMJobs: /j/<slug>-<digits>
  if (source === "iimjobs") {
    let slug = last.replace(/-\d+$/i, "");
    slug = slug.replace(/^[a-z0-9]+com-/i, ""); // drop obvious company prefix (e.g., cardekhocom-)
    slug = slug
      .replace(/-\d+-\d+-yrs?$/i, "")
      .replace(/-yrs?$/i, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return titleCaseMaybe_(slug);
  }

  // Naukri: often /job-listings-<slug>-<digits>
  if (source === "naukri") {
    let slug = last.replace(/-\d+$/i, "");
    slug = slug.replace(/^job-listings-/i, "");
    slug = slug
      .replace(/-yrs?-experience.*$/i, "")
      .replace(/-in-[a-z-]+$/i, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return titleCaseMaybe_(slug);
  }

  return "";
}

function titleCaseMaybe_(s) {
  const raw = String(s || "").trim();
  const txt = raw.replace(/[_=;]+/g, " ").replace(/\s+/g, " ").trim();
  if (!txt) return "";
  if (/^\d{4,}\b/.test(txt)) return "";

  // Reject obvious tracking/token noise from malformed URL slugs.
  const words = txt.split(" ").filter(Boolean);
  const letters = (txt.match(/[a-z]/gi) || []).length;
  const digits = (txt.match(/\d/g) || []).length;
  const hasNoiseChars = /[=;]/.test(raw);
  const looksLikeSingleTokenNoise = words.length === 1 && words[0].length > 24;
  const looksLikeQueryNoise = /\b(utm|trk|token|session|redirect|clickid|fbclid|gclid)\b/i.test(raw);
  if (hasNoiseChars || looksLikeSingleTokenNoise || looksLikeQueryNoise || letters < 3 || digits > letters) {
    return "";
  }

  const out = txt
    .split(" ")
    .map((w) => (w ? (w[0].toUpperCase() + w.slice(1)) : ""))
    .join(" ")
    .trim();
  if (!out) return "";
  return out.length > 90 ? `${out.slice(0, 87)}...` : out;
}

function cleanHumanLabel_(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const txt = raw
    .replace(/[|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!txt) return "";

  const letters = (txt.match(/[a-z]/gi) || []).length;
  const digits = (txt.match(/\d/g) || []).length;
  const words = txt.split(" ").filter(Boolean);
  const maxWordLen = words.reduce((m, w) => Math.max(m, w.length), 0);

  const hasUrlish = /https?:\/\//i.test(raw) || /www\./i.test(raw);
  const hasNoiseChars = /[=;{}<>]/.test(raw);
  const hasTrackingWords = /\b(utm|trk|token|session|redirect|clickid|fbclid|gclid)\b/i.test(raw);
  const startsWithLongId = /^\d{4,}\b/.test(txt);
  const looksLikeSingleOpaqueToken =
    words.length === 1 &&
    /^[a-z0-9._-]+$/i.test(words[0]) &&
    (maxWordLen >= 28 || (digits >= 6 && digits > letters));
  const tooNumeric = (letters < 3 && digits >= 3) || (digits > letters && digits >= 8);

  if (hasUrlish || hasNoiseChars || hasTrackingWords || startsWithLongId || looksLikeSingleOpaqueToken || tooNumeric) {
    return "";
  }

  return txt.length > 140 ? `${txt.slice(0, 137)}...` : txt;
}

function cleanRoleTitle_(value) {
  let t = cleanHumanLabel_(value);
  if (!t) return "";
  t = t
    .replace(/\b\d+\s*[-to]+\s*\d+\s*(?:yrs?|years?)\b/gi, "")
    .replace(/\b\d+\+?\s*(?:yrs?|years?)\b/gi, "")
    .replace(/\b(?:yrs?|years?)\b/gi, "")
    .replace(/^[a-z0-9._-]*com\b[\s\-:]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleanHumanLabel_(t);
}

function isNoisyRoleTitle_(value) {
  const t = String(value || "").trim();
  if (!t) return true;
  if (/^[a-z0-9._-]*com\b/i.test(t)) return true;
  if (/\b\d+\s*[-to]+\s*\d+\s*(?:yrs?|years?)\b/i.test(t)) return true;
  if (/\b\d+\+?\s*(?:yrs?|years?)\b/i.test(t)) return true;
  if (/\b(?:yrs?|years?)\b/i.test(t)) return true;
  return false;
}

function isLikelyCompanyName_(value) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (s.length < 2 || s.length > 80) return false;
  const words = s.split(" ").filter(Boolean);
  if (words.length > 8) return false;
  if (!/[a-z]/i.test(s)) return false;
  if (/\b(we|you|our|your|role|job|opportunity|responsibilities|requirements|experience|team|pace|defined|work|skills)\b/i.test(s)) return false;
  if (/[:;{}<>/=]/.test(s)) return false;
  return true;
}

/* =========================================================
 * AI helpers
 * ========================================================= */

async function hasScoringRunsTable_(env) {
  try {
    const row = await env.DB.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'scoring_runs'
      LIMIT 1;
    `.trim()).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function collectHeuristicBlockedKeywords_(targets) {
  const out = [];
  for (const target of (Array.isArray(targets) ? targets : [])) {
    const reject = Array.isArray(target?.reject) ? target.reject : [];
    for (const kw of reject) {
      const v = String(kw || "").trim();
      if (v) out.push(v);
    }
  }
  return unique_(out).slice(0, 250);
}

async function persistScoringRun_(env, input = {}) {
  if (!env?.DB) return false;
  const enabled = await hasScoringRunsTable_(env);
  if (!enabled) return false;

  const stages = input?.stages && typeof input.stages === "object" ? input.stages : {};
  const aiStage = stages.ai_reason && typeof stages.ai_reason === "object" ? stages.ai_reason : {};
  const createdAt = numOrNull_(input.created_at) || Date.now();

  try {
    await env.DB.prepare(`
      INSERT INTO scoring_runs (
        id,
        job_key,
        source,
        final_status,
        heuristic_passed,
        heuristic_reasons_json,
        stage_metrics_json,
        ai_model,
        ai_tokens_in,
        ai_tokens_out,
        ai_tokens_total,
        ai_latency_ms,
        total_latency_ms,
        final_score,
        reject_triggered,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `.trim()).bind(
      crypto.randomUUID(),
      String(input.job_key || "").trim(),
      String(input.source || "unknown").trim().toLowerCase(),
      String(input.final_status || "COMPLETED").trim().toUpperCase(),
      input.heuristic_passed ? 1 : 0,
      JSON.stringify(Array.isArray(input.heuristic_reasons) ? input.heuristic_reasons : []),
      JSON.stringify(stages),
      String(input.ai_model || "").trim() || null,
      clampInt_(aiStage.tokens_in, 0, 5_000_000),
      clampInt_(aiStage.tokens_out, 0, 5_000_000),
      clampInt_(aiStage.tokens_total, 0, 5_000_000),
      clampInt_(aiStage.latency_ms, 0, 900_000),
      clampInt_(input.total_latency_ms, 0, 900_000),
      numOrNull_(input.final_score),
      toBool_(input.reject_triggered, false) ? 1 : 0,
      createdAt
    ).run();
    return true;
  } catch {
    return false;
  }
}

async function buildScoringRunsEfficiencyReport_(env, input = {}) {
  if (!env?.DB) return { enabled: false, error: "Missing D1 binding env.DB" };

  const enabled = await hasScoringRunsTable_(env);
  const heuristicConfig = loadScoringHeuristicCfg_(env);
  const now = Date.now();
  const windowDays = clampInt_(input.window_days ?? input.windowDays ?? 14, 1, 180);
  const trendDays = clampInt_(input.trend_days ?? input.trendDays ?? Math.min(windowDays, 30), 1, 180);
  const stageSampleLimit = clampInt_(input.stage_sample_limit ?? input.stageSampleLimit ?? 1500, 50, 5000);
  const source = String(input.source || "").trim().toLowerCase();
  const windowStart = now - (windowDays * 24 * 60 * 60 * 1000);
  const trendStart = now - (trendDays * 24 * 60 * 60 * 1000);

  if (!enabled) {
    return {
      enabled: false,
      source: source || null,
      heuristic_config: heuristicConfig,
      window: { days: windowDays, start_at: windowStart, end_at: now },
      trend: { days: trendDays, start_at: trendStart, end_at: now },
      totals: {
        total_runs: 0,
        heuristic_passed_runs: 0,
        heuristic_rejected_runs: 0,
      },
      heuristic_reject_rate: { ratio: 0, percent: 0 },
      latency_ms: {
        avg_total_latency_ms: 0,
        avg_ai_latency_ms: 0,
        stage_sample_limit: stageSampleLimit,
        stage_rows_scanned: 0,
        stage_avg_latency_ms: {},
      },
      token_spend: {
        ai_tokens_total_sum: 0,
        ai_tokens_total_avg_per_run: 0,
        trend_by_day: [],
      },
    };
  }

  const where = ["created_at >= ?"];
  const binds = [windowStart];
  if (source) {
    where.push("source = ?");
    binds.push(source);
  }
  const whereSql = where.join(" AND ");

  const summary = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN heuristic_passed = 1 THEN 1 ELSE 0 END) AS heuristic_passed_runs,
      SUM(CASE WHEN heuristic_passed = 0 THEN 1 ELSE 0 END) AS heuristic_rejected_runs,
      AVG(total_latency_ms) AS avg_total_latency_ms,
      AVG(ai_latency_ms) AS avg_ai_latency_ms,
      AVG(ai_tokens_total) AS avg_ai_tokens_total,
      SUM(ai_tokens_total) AS sum_ai_tokens_total
    FROM scoring_runs
    WHERE ${whereSql};
  `.trim()).bind(...binds).first();

  const stageRows = await env.DB.prepare(`
    SELECT stage_metrics_json
    FROM scoring_runs
    WHERE ${whereSql}
    ORDER BY created_at DESC
    LIMIT ?;
  `.trim()).bind(...binds, stageSampleLimit).all();

  const stageAgg = {};
  for (const row of (stageRows?.results || [])) {
    const stageMetrics = safeJsonParse_(row?.stage_metrics_json) || {};
    if (!stageMetrics || typeof stageMetrics !== "object") continue;
    for (const [stageName, metricRaw] of Object.entries(stageMetrics)) {
      const stage = String(stageName || "").trim();
      if (!stage) continue;
      const metric = metricRaw && typeof metricRaw === "object" ? metricRaw : {};
      if (!stageAgg[stage]) {
        stageAgg[stage] = {
          stage,
          runs_seen: 0,
          latency_samples: 0,
          latency_sum_ms: 0,
          status_counts: {},
        };
      }
      const slot = stageAgg[stage];
      slot.runs_seen += 1;

      const latencyMs = numOrNull_(metric.latency_ms);
      if (latencyMs !== null && latencyMs >= 0) {
        slot.latency_samples += 1;
        slot.latency_sum_ms += latencyMs;
      }

      const status = String(metric.status || "unknown").trim().toLowerCase() || "unknown";
      slot.status_counts[status] = (slot.status_counts[status] || 0) + 1;
    }
  }

  const stageAvgLatency = {};
  for (const stage of Object.keys(stageAgg).sort((a, b) => a.localeCompare(b))) {
    const slot = stageAgg[stage];
    const avgLatency = slot.latency_samples > 0
      ? (slot.latency_sum_ms / slot.latency_samples)
      : 0;
    stageAvgLatency[stage] = {
      runs_seen: slot.runs_seen,
      latency_samples: slot.latency_samples,
      avg_latency_ms: Number(avgLatency.toFixed(2)),
      status_counts: slot.status_counts,
    };
  }

  const trendWhere = ["created_at >= ?"];
  const trendBinds = [trendStart];
  if (source) {
    trendWhere.push("source = ?");
    trendBinds.push(source);
  }
  const trendSql = trendWhere.join(" AND ");

  const trendRows = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', (created_at / 1000), 'unixepoch') AS day,
      COUNT(*) AS run_count,
      SUM(CASE WHEN heuristic_passed = 0 THEN 1 ELSE 0 END) AS heuristic_rejected_runs,
      SUM(ai_tokens_in) AS ai_tokens_in,
      SUM(ai_tokens_out) AS ai_tokens_out,
      SUM(ai_tokens_total) AS ai_tokens_total,
      AVG(total_latency_ms) AS avg_total_latency_ms
    FROM scoring_runs
    WHERE ${trendSql}
    GROUP BY day
    ORDER BY day ASC;
  `.trim()).bind(...trendBinds).all();

  const trendByDay = (trendRows?.results || []).map((row) => {
    const runCount = Math.max(0, Math.round(numOr_(row?.run_count, 0)));
    const rejected = Math.max(0, Math.round(numOr_(row?.heuristic_rejected_runs, 0)));
    return {
      day: String(row?.day || "").trim(),
      run_count: runCount,
      heuristic_rejected_runs: rejected,
      heuristic_reject_rate_percent: runCount > 0
        ? Number(((rejected / runCount) * 100).toFixed(2))
        : 0,
      ai_tokens_in: Math.max(0, Math.round(numOr_(row?.ai_tokens_in, 0))),
      ai_tokens_out: Math.max(0, Math.round(numOr_(row?.ai_tokens_out, 0))),
      ai_tokens_total: Math.max(0, Math.round(numOr_(row?.ai_tokens_total, 0))),
      avg_total_latency_ms: Number(numOr_(row?.avg_total_latency_ms, 0).toFixed(2)),
    };
  });

  const totalRuns = Math.max(0, Math.round(numOr_(summary?.total_runs, 0)));
  const heuristicPassedRuns = Math.max(0, Math.round(numOr_(summary?.heuristic_passed_runs, 0)));
  const heuristicRejectedRuns = Math.max(0, Math.round(numOr_(summary?.heuristic_rejected_runs, 0)));

  const sourceRows = await env.DB.prepare(`
    SELECT
      source,
      COUNT(*) AS run_count,
      SUM(CASE WHEN heuristic_passed = 0 THEN 1 ELSE 0 END) AS heuristic_rejected_runs,
      AVG(final_score) AS avg_final_score,
      AVG(total_latency_ms) AS avg_total_latency_ms,
      SUM(ai_tokens_total) AS ai_tokens_total
    FROM scoring_runs
    WHERE ${whereSql}
    GROUP BY source
    ORDER BY run_count DESC, source ASC;
  `.trim()).bind(...binds).all();

  const sourceBreakdown = (sourceRows?.results || []).map((row) => {
    const runCount = Math.max(0, Math.round(numOr_(row?.run_count, 0)));
    const rejected = Math.max(0, Math.round(numOr_(row?.heuristic_rejected_runs, 0)));
    return {
      source: String(row?.source || "unknown").trim().toLowerCase() || "unknown",
      run_count: runCount,
      heuristic_rejected_runs: rejected,
      heuristic_reject_rate_percent: runCount > 0
        ? Number(((rejected / runCount) * 100).toFixed(2))
        : 0,
      avg_final_score: Number(numOr_(row?.avg_final_score, 0).toFixed(2)),
      avg_total_latency_ms: Number(numOr_(row?.avg_total_latency_ms, 0).toFixed(2)),
      ai_tokens_total: Math.max(0, Math.round(numOr_(row?.ai_tokens_total, 0))),
    };
  });

  const profilePrefEnabled = await hasJobProfilePreferencesTable_(env);
  let profileBreakdown = [];
  let sourceProfileBreakdown = [];
  if (profilePrefEnabled) {
    const profileRows = await env.DB.prepare(`
      SELECT
        COALESCE(jpp.profile_id, 'primary') AS profile_id,
        COUNT(*) AS jobs_count,
        AVG(j.final_score) AS avg_final_score,
        SUM(CASE WHEN upper(COALESCE(j.status, '')) = 'APPLIED' THEN 1 ELSE 0 END) AS applied_jobs
      FROM jobs j
      LEFT JOIN job_profile_preferences jpp ON jpp.job_key = j.job_key
      WHERE COALESCE(j.last_scored_at, j.updated_at, j.created_at) >= ?
        AND j.final_score IS NOT NULL
      GROUP BY COALESCE(jpp.profile_id, 'primary')
      ORDER BY avg_final_score DESC, jobs_count DESC, profile_id ASC;
    `.trim()).bind(windowStart).all();
    profileBreakdown = (profileRows?.results || []).map((row) => ({
      profile_id: String(row?.profile_id || "primary").trim() || "primary",
      jobs_count: Math.max(0, Math.round(numOr_(row?.jobs_count, 0))),
      avg_final_score: Number(numOr_(row?.avg_final_score, 0).toFixed(2)),
      applied_jobs: Math.max(0, Math.round(numOr_(row?.applied_jobs, 0))),
    }));

    const sourceProfileRows = await env.DB.prepare(`
      SELECT
        sr.source AS source,
        COALESCE(jpp.profile_id, 'primary') AS profile_id,
        COUNT(*) AS run_count,
        AVG(sr.final_score) AS avg_final_score,
        SUM(CASE WHEN sr.heuristic_passed = 0 THEN 1 ELSE 0 END) AS heuristic_rejected_runs
      FROM scoring_runs sr
      LEFT JOIN job_profile_preferences jpp ON jpp.job_key = sr.job_key
      WHERE sr.created_at >= ?
        ${source ? "AND sr.source = ?" : ""}
      GROUP BY sr.source, COALESCE(jpp.profile_id, 'primary')
      ORDER BY avg_final_score DESC, run_count DESC;
    `.trim()).bind(...(source ? [windowStart, source] : [windowStart])).all();
    sourceProfileBreakdown = (sourceProfileRows?.results || []).map((row) => {
      const runCount = Math.max(0, Math.round(numOr_(row?.run_count, 0)));
      const rejected = Math.max(0, Math.round(numOr_(row?.heuristic_rejected_runs, 0)));
      return {
        source: String(row?.source || "unknown").trim().toLowerCase() || "unknown",
        profile_id: String(row?.profile_id || "primary").trim() || "primary",
        run_count: runCount,
        avg_final_score: Number(numOr_(row?.avg_final_score, 0).toFixed(2)),
        heuristic_rejected_runs: rejected,
        heuristic_reject_rate_percent: runCount > 0
          ? Number(((rejected / runCount) * 100).toFixed(2))
          : 0,
      };
    });
  }

  const contactsStorage = await hasContactsStorage_(env);
  const touchpointEnabled = Boolean(contactsStorage?.enabled);
  let touchpointOverall = {
    sent: 0,
    replied: 0,
    sent_or_replied: 0,
    reply_rate_percent: 0,
  };
  let touchpointByChannel = [];
  if (touchpointEnabled) {
    const tpUpdatedAtExpr = "CASE WHEN updated_at < 100000000000 THEN updated_at * 1000 ELSE updated_at END";
    const tpOverallRow = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN upper(COALESCE(status, '')) = 'SENT' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN upper(COALESCE(status, '')) = 'REPLIED' THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN upper(COALESCE(status, '')) IN ('SENT', 'REPLIED') THEN 1 ELSE 0 END) AS sent_or_replied
      FROM contact_touchpoints
      WHERE ${tpUpdatedAtExpr} >= ?;
    `.trim()).bind(windowStart).first();
    const sent = Math.max(0, Math.round(numOr_(tpOverallRow?.sent, 0)));
    const replied = Math.max(0, Math.round(numOr_(tpOverallRow?.replied, 0)));
    const sentOrReplied = Math.max(0, Math.round(numOr_(tpOverallRow?.sent_or_replied, 0)));
    touchpointOverall = {
      sent,
      replied,
      sent_or_replied: sentOrReplied,
      reply_rate_percent: sentOrReplied > 0
        ? Number(((replied / sentOrReplied) * 100).toFixed(2))
        : 0,
    };

    const tpChannelRows = await env.DB.prepare(`
      SELECT
        upper(COALESCE(channel, 'OTHER')) AS channel,
        SUM(CASE WHEN upper(COALESCE(status, '')) = 'SENT' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN upper(COALESCE(status, '')) = 'REPLIED' THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN upper(COALESCE(status, '')) IN ('SENT', 'REPLIED') THEN 1 ELSE 0 END) AS sent_or_replied
      FROM contact_touchpoints
      WHERE ${tpUpdatedAtExpr} >= ?
      GROUP BY upper(COALESCE(channel, 'OTHER'))
      ORDER BY channel ASC;
    `.trim()).bind(windowStart).all();
    touchpointByChannel = (tpChannelRows?.results || []).map((row) => {
      const chSent = Math.max(0, Math.round(numOr_(row?.sent, 0)));
      const chReplied = Math.max(0, Math.round(numOr_(row?.replied, 0)));
      const chSentOrReplied = Math.max(0, Math.round(numOr_(row?.sent_or_replied, 0)));
      return {
        channel: String(row?.channel || "OTHER").trim().toUpperCase() || "OTHER",
        sent: chSent,
        replied: chReplied,
        sent_or_replied: chSentOrReplied,
        reply_rate_percent: chSentOrReplied > 0
          ? Number(((chReplied / chSentOrReplied) * 100).toFixed(2))
          : 0,
      };
    });
  }

  return {
    enabled: true,
    source: source || null,
    heuristic_config: heuristicConfig,
    window: { days: windowDays, start_at: windowStart, end_at: now },
    trend: { days: trendDays, start_at: trendStart, end_at: now },
    totals: {
      total_runs: totalRuns,
      heuristic_passed_runs: heuristicPassedRuns,
      heuristic_rejected_runs: heuristicRejectedRuns,
    },
    heuristic_reject_rate: {
      ratio: totalRuns > 0 ? Number((heuristicRejectedRuns / totalRuns).toFixed(4)) : 0,
      percent: totalRuns > 0 ? Number(((heuristicRejectedRuns / totalRuns) * 100).toFixed(2)) : 0,
    },
    latency_ms: {
      avg_total_latency_ms: Number(numOr_(summary?.avg_total_latency_ms, 0).toFixed(2)),
      avg_ai_latency_ms: Number(numOr_(summary?.avg_ai_latency_ms, 0).toFixed(2)),
      stage_sample_limit: stageSampleLimit,
      stage_rows_scanned: Array.isArray(stageRows?.results) ? stageRows.results.length : 0,
      stage_avg_latency_ms: stageAvgLatency,
    },
    token_spend: {
      ai_tokens_total_sum: Math.max(0, Math.round(numOr_(summary?.sum_ai_tokens_total, 0))),
      ai_tokens_total_avg_per_run: Number(numOr_(summary?.avg_ai_tokens_total, 0).toFixed(2)),
      trend_by_day: trendByDay,
    },
    funnel: {
      source_breakdown: sourceBreakdown,
      profile_breakdown: profileBreakdown,
      source_profile_breakdown: sourceProfileBreakdown,
      touchpoint_conversion: {
        enabled: touchpointEnabled,
        window_days: windowDays,
        overall: touchpointOverall,
        by_channel: touchpointByChannel,
      },
    },
  };
}

function normalizeEpochMs_(value) {
  const n = numOrNull_(value);
  if (n === null || n <= 0) return null;
  return n < 100000000000 ? Math.round(n * 1000) : Math.round(n);
}

function buildTriagePriority_(status, daysInStage, staleDays) {
  const s = String(status || "").trim().toUpperCase();
  const d = Math.max(0, Math.round(numOr_(daysInStage, 0)));
  const stale = Math.max(1, Math.round(numOr_(staleDays, 3)));

  if (s === "REPLIED") {
    return {
      priority: d >= stale ? "RESPONSE_PENDING_HIGH" : "RESPONSE_PENDING",
      priority_score: 300 + Math.min(d, 60),
      action_label: "Respond",
      queue: "reply_pending",
    };
  }

  if (s === "SENT") {
    if (d >= (stale * 2)) {
      return {
        priority: "FOLLOW_UP_URGENT",
        priority_score: 220 + Math.min(d, 60),
        action_label: "Follow Up",
        queue: "follow_up_overdue",
      };
    }
    return {
      priority: "FOLLOW_UP_DUE",
      priority_score: 150 + Math.min(d, 60),
      action_label: "Follow Up",
      queue: "follow_up_overdue",
    };
  }

  return {
    priority: "NORMAL",
    priority_score: 100,
    action_label: "Review",
    queue: "general",
  };
}

async function buildDashboardTriageReport_(env, input = {}) {
  const now = Date.now();
  const staleDays = clampInt_(input.stale_days ?? input.staleDays ?? 3, 1, 21);
  const limit = clampInt_(input.limit ?? 80, 5, 200);
  const goldLimit = clampInt_(input.gold_limit ?? input.goldLimit ?? 3, 1, 10);
  const staleCutoffMs = now - (staleDays * 24 * 60 * 60 * 1000);
  const repliesCutoffMs = now - (7 * 24 * 60 * 60 * 1000);

  const contactsStorage = await hasContactsStorage_(env);
  const enabled = Boolean(contactsStorage?.enabled);
  const empty = {
    enabled,
    stale_days: staleDays,
    generated_at: now,
    pulse: {
      gold_leads_count: 0,
      replies_7d_count: 0,
      stale_followups_count: 0,
      reply_pending_count: 0,
    },
    queues: {
      reply_pending: [],
      follow_up_overdue: [],
      all: [],
    },
    gold_leads: [],
  };
  if (!enabled) {
    return {
      ...empty,
      error: contactsStorage?.error || "contacts_storage_unavailable",
      touchpoint_conversion: {
        enabled: false,
        overall: { sent: 0, replied: 0, sent_or_replied: 0, reply_rate_percent: 0 },
      },
    };
  }

  const tpUpdatedAtExpr = "CASE WHEN ct.updated_at < 100000000000 THEN ct.updated_at * 1000 ELSE ct.updated_at END";
  const tpCreatedAtExpr = "CASE WHEN ct.created_at < 100000000000 THEN ct.created_at * 1000 ELSE ct.created_at END";

  const triageRows = await env.DB.prepare(`
    SELECT
      ct.id AS touchpoint_id,
      ct.contact_id,
      ct.job_key,
      upper(COALESCE(ct.channel, 'OTHER')) AS channel,
      upper(COALESCE(ct.status, 'DRAFT')) AS status,
      ct.content AS touchpoint_content,
      ${tpUpdatedAtExpr} AS touchpoint_updated_at,
      ${tpCreatedAtExpr} AS touchpoint_created_at,
      c.name AS contact_name,
      c.title AS contact_title,
      c.company_name AS contact_company,
      c.linkedin_url,
      c.email,
      j.role_title,
      j.company,
      upper(COALESCE(j.status, 'NEW')) AS job_status,
      j.final_score,
      CASE
        WHEN COALESCE(j.updated_at, 0) < 100000000000 THEN COALESCE(j.updated_at, 0) * 1000
        ELSE COALESCE(j.updated_at, 0)
      END AS job_updated_at
    FROM contact_touchpoints ct
    INNER JOIN contacts c ON c.id = ct.contact_id
    INNER JOIN jobs j ON j.job_key = ct.job_key
    WHERE upper(COALESCE(j.status, '')) NOT IN ('REJECTED', 'ARCHIVED')
      AND (
        upper(COALESCE(ct.status, '')) = 'REPLIED'
        OR (
          upper(COALESCE(ct.status, '')) = 'SENT'
          AND (${tpUpdatedAtExpr}) <= ?
        )
      )
    ORDER BY ${tpUpdatedAtExpr} ASC
    LIMIT ?;
  `.trim()).bind(staleCutoffMs, limit).all();

  const triageItems = (triageRows?.results || []).map((row) => {
    const updatedAt = normalizeEpochMs_(row?.touchpoint_updated_at);
    const createdAt = normalizeEpochMs_(row?.touchpoint_created_at);
    const stageAt = updatedAt || createdAt || now;
    const ageMs = Math.max(0, now - stageAt);
    const daysInStage = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const priority = buildTriagePriority_(row?.status, daysInStage, staleDays);
    return {
      touchpoint_id: String(row?.touchpoint_id || "").trim(),
      contact_id: String(row?.contact_id || "").trim(),
      job_key: String(row?.job_key || "").trim(),
      channel: String(row?.channel || "OTHER").trim().toUpperCase() || "OTHER",
      status: String(row?.status || "DRAFT").trim().toUpperCase() || "DRAFT",
      touchpoint_content: String(row?.touchpoint_content || "").trim(),
      touchpoint_updated_at: stageAt,
      days_in_stage: daysInStage,
      contact_name: String(row?.contact_name || "").trim() || "Unknown Contact",
      contact_title: String(row?.contact_title || "").trim() || "",
      contact_company: String(row?.contact_company || row?.company || "").trim() || "",
      linkedin_url: String(row?.linkedin_url || "").trim() || "",
      email: String(row?.email || "").trim() || "",
      role_title: String(row?.role_title || "").trim() || "",
      company: String(row?.company || row?.contact_company || "").trim() || "",
      job_status: String(row?.job_status || "").trim().toUpperCase() || "NEW",
      final_score: numOrNull_(row?.final_score),
      job_updated_at: normalizeEpochMs_(row?.job_updated_at),
      priority: priority.priority,
      priority_score: priority.priority_score,
      action_label: priority.action_label,
      queue: priority.queue,
    };
  }).sort((a, b) => {
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    if (b.days_in_stage !== a.days_in_stage) return b.days_in_stage - a.days_in_stage;
    return String(a.contact_name || "").localeCompare(String(b.contact_name || ""));
  });

  const replyPending = triageItems.filter((x) => x.queue === "reply_pending");
  const staleFollowups = triageItems.filter((x) => x.queue === "follow_up_overdue");

  const replies7dRow = await env.DB.prepare(`
    SELECT COUNT(*) AS replied_7d
    FROM contact_touchpoints
    WHERE upper(COALESCE(status, '')) = 'REPLIED'
      AND (CASE WHEN updated_at < 100000000000 THEN updated_at * 1000 ELSE updated_at END) >= ?;
  `.trim()).bind(repliesCutoffMs).first();
  const replies7dCount = Math.max(0, Math.round(numOr_(replies7dRow?.replied_7d, 0)));

  const touchpointConvRow = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN upper(COALESCE(status, '')) = 'SENT' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN upper(COALESCE(status, '')) = 'REPLIED' THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN upper(COALESCE(status, '')) IN ('SENT', 'REPLIED') THEN 1 ELSE 0 END) AS sent_or_replied
    FROM contact_touchpoints;
  `.trim()).first();
  const sentCount = Math.max(0, Math.round(numOr_(touchpointConvRow?.sent, 0)));
  const repliedCount = Math.max(0, Math.round(numOr_(touchpointConvRow?.replied, 0)));
  const sentOrRepliedCount = Math.max(0, Math.round(numOr_(touchpointConvRow?.sent_or_replied, 0)));

  const prefEnabled = await hasJobProfilePreferencesTable_(env);
  const goldRows = prefEnabled
    ? await env.DB.prepare(`
        SELECT
          j.job_key,
          j.role_title,
          j.company,
          upper(COALESCE(j.status, 'NEW')) AS status,
          j.final_score,
          COALESCE(jpp.profile_id, 'primary') AS profile_id,
          CASE
            WHEN COALESCE(j.updated_at, 0) < 100000000000 THEN COALESCE(j.updated_at, 0) * 1000
            ELSE COALESCE(j.updated_at, 0)
          END AS updated_at
        FROM jobs j
        LEFT JOIN job_profile_preferences jpp ON jpp.job_key = j.job_key
        WHERE j.final_score IS NOT NULL
          AND upper(COALESCE(j.status, '')) NOT IN ('APPLIED', 'REJECTED', 'ARCHIVED')
          AND NOT EXISTS (
            SELECT 1
            FROM resume_drafts rd
            WHERE rd.job_key = j.job_key
              AND upper(COALESCE(rd.status, '')) = 'READY_TO_APPLY'
          )
        ORDER BY j.final_score DESC, updated_at DESC
        LIMIT ?;
      `.trim()).bind(goldLimit).all()
    : await env.DB.prepare(`
        SELECT
          j.job_key,
          j.role_title,
          j.company,
          upper(COALESCE(j.status, 'NEW')) AS status,
          j.final_score,
          'primary' AS profile_id,
          CASE
            WHEN COALESCE(j.updated_at, 0) < 100000000000 THEN COALESCE(j.updated_at, 0) * 1000
            ELSE COALESCE(j.updated_at, 0)
          END AS updated_at
        FROM jobs j
        WHERE j.final_score IS NOT NULL
          AND upper(COALESCE(j.status, '')) NOT IN ('APPLIED', 'REJECTED', 'ARCHIVED')
          AND NOT EXISTS (
            SELECT 1
            FROM resume_drafts rd
            WHERE rd.job_key = j.job_key
              AND upper(COALESCE(rd.status, '')) = 'READY_TO_APPLY'
          )
        ORDER BY j.final_score DESC, updated_at DESC
        LIMIT ?;
      `.trim()).bind(goldLimit).all();

  const goldLeads = (goldRows?.results || []).map((row) => ({
    job_key: String(row?.job_key || "").trim(),
    role_title: String(row?.role_title || "").trim() || "",
    company: String(row?.company || "").trim() || "",
    status: String(row?.status || "").trim().toUpperCase() || "NEW",
    final_score: numOrNull_(row?.final_score),
    profile_id: String(row?.profile_id || "primary").trim() || "primary",
    updated_at: normalizeEpochMs_(row?.updated_at),
  }));

  return {
    enabled: true,
    stale_days: staleDays,
    generated_at: now,
    pulse: {
      gold_leads_count: goldLeads.length,
      replies_7d_count: replies7dCount,
      stale_followups_count: staleFollowups.length,
      reply_pending_count: replyPending.length,
    },
    queues: {
      reply_pending: replyPending,
      follow_up_overdue: staleFollowups,
      all: triageItems,
    },
    gold_leads: goldLeads,
    touchpoint_conversion: {
      enabled: true,
      overall: {
        sent: sentCount,
        replied: repliedCount,
        sent_or_replied: sentOrRepliedCount,
        reply_rate_percent: sentOrRepliedCount > 0
          ? Number(((repliedCount / sentOrRepliedCount) * 100).toFixed(2))
          : 0,
      },
    },
    meta: {
      contacts_storage_error: contactsStorage?.error || null,
      profile_preferences_enabled: prefEnabled,
      limit,
      gold_limit: goldLimit,
    },
  };
}

async function runScoringPipelineForJob_(env, input = {}) {
  const source = String(input.source || "unknown").trim().toLowerCase();
  const jobKey = String(input.job_key || "").trim();
  const existingJob = input.existing_job && typeof input.existing_job === "object" ? input.existing_job : null;
  const ai = input.ai || null;
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const cfg = input.cfg || { DEFAULT_TARGET_ID: "TGT-001", SCORE_THRESHOLD_SHORTLIST: 75, SCORE_THRESHOLD_ARCHIVE: 55 };

  if (!ai) throw new Error("Missing Workers AI binding (env.AI or AI_BINDING)");
  if (!targets.length) throw new Error("No targets configured");

  const jdClean = String(input.jd_clean || "").trim();
  const roleTitle = String(input.role_title || "").trim();
  const company = String(input.company || "").trim();
  const location = String(input.location || "").trim();
  const seniority = String(input.seniority || "").trim();
  const blockedKeywords = collectHeuristicBlockedKeywords_(targets);
  const heuristicCfg = loadScoringHeuristicCfg_(env);

  const pipeline = await runDomainScoringPipeline_({
    company,
    role_title: roleTitle,
    location,
    seniority,
    jd_clean: jdClean,
    targets,
    blocked_keywords: blockedKeywords,
    min_jd_chars: heuristicCfg.min_jd_chars,
    min_target_signal: heuristicCfg.min_target_signal,
    onAiReason: async () => {
      const scoring = await scoreJobWithModel_(ai, {
        company,
        role_title: roleTitle,
        location,
        seniority,
        jd_clean: jdClean,
      }, targets, cfg);
      return { data: scoring, usage: scoring?._meta?.usage || null, meta: scoring?._meta || null };
    },
  });

  if (pipeline.short_circuit) {
    const heuristicReasons = Array.isArray(pipeline?.heuristic?.reasons) ? pipeline.heuristic.reasons : [];
    const transition = applyStatusTransition_(existingJob, "heuristic_rejected");
    const reasonTopMatches = `Heuristic reject: ${heuristicReasons.join("; ")}`.slice(0, 1000);
    const out = {
      pipeline,
      heuristic_rejected: true,
      transition,
      primary_target_id: String(pipeline?.heuristic?.best_target_id || cfg.DEFAULT_TARGET_ID || "").trim() || null,
      score_must: 0,
      score_nice: 0,
      final_score: 0,
      reject_triggered: true,
      reject_reasons: heuristicReasons,
      reject_evidence: "",
      reason_top_matches: reasonTopMatches,
      potential_contacts: [],
      contacts_persist: {
        enabled: false,
        upserted: 0,
        touchpoints_linked: 0,
        skipped: 0,
      },
    };

    await persistScoringRun_(env, {
      job_key: jobKey,
      source,
      final_status: "REJECTED_HEURISTIC",
      heuristic_passed: false,
      heuristic_reasons: heuristicReasons,
      stages: pipeline.stages,
      ai_model: null,
      total_latency_ms: pipeline.total_latency_ms,
      final_score: 0,
      reject_triggered: true,
      created_at: Date.now(),
    });
    return out;
  }

  const scoring = pipeline?.scoring && typeof pipeline.scoring === "object" ? pipeline.scoring : {};
  const potentialContacts = Array.isArray(scoring.potential_contacts) ? scoring.potential_contacts : [];
  const rejectFromTargets = computeTargetReject_(jdClean, scoring.primary_target_id, targets);
  const mergedRejectTriggered = Boolean(scoring.reject_triggered || rejectFromTargets.triggered || hasRejectMarker_(jdClean));
  const rejectReasons = [];
  if (hasRejectMarker_(jdClean)) rejectReasons.push("Contains 'Reject:' marker in JD");
  if (scoring.reject_triggered) rejectReasons.push("AI flagged reject_triggered=true");
  if (rejectFromTargets.triggered) rejectReasons.push(`Target reject keywords: ${rejectFromTargets.matches.join(", ")}`);

  const finalScore = mergedRejectTriggered ? 0 : clampInt_(scoring.final_score, 0, 100);
  const transition = applyStatusTransition_(existingJob, "scored", {
    final_score: finalScore,
    reject_triggered: mergedRejectTriggered,
    cfg,
  });

  await persistScoringRun_(env, {
    job_key: jobKey,
    source,
    final_status: "COMPLETED",
    heuristic_passed: true,
    heuristic_reasons: [],
    stages: pipeline.stages,
    ai_model: String(scoring?._meta?.model || "").trim() || null,
    total_latency_ms: pipeline.total_latency_ms,
    final_score: finalScore,
    reject_triggered: mergedRejectTriggered,
    created_at: Date.now(),
  });

  let contactsPersist = {
    enabled: false,
    upserted: 0,
    touchpoints_linked: 0,
    skipped: 0,
    error: null,
  };
  if (potentialContacts.length) {
    const persisted = await upsertPotentialContactsForJob_(env, {
      job_key: jobKey,
      company,
      contacts: potentialContacts,
      source,
    });
    contactsPersist = {
      enabled: Boolean(persisted?.enabled),
      upserted: numOr_(persisted?.upserted, 0),
      touchpoints_linked: numOr_(persisted?.touchpoints_linked, 0),
      skipped: numOr_(persisted?.skipped, 0),
      error: String(persisted?.error || "").trim() || null,
    };

    await logEvent_(env, "POTENTIAL_CONTACTS_IDENTIFIED", jobKey, {
      source,
      count: potentialContacts.length,
      contacts: potentialContacts,
      persistence: contactsPersist,
      ts: Date.now(),
    });
  }

  return {
    pipeline,
    heuristic_rejected: false,
    transition,
    primary_target_id: String(scoring.primary_target_id || cfg.DEFAULT_TARGET_ID || "").trim() || null,
    score_must: clampInt_(scoring.score_must, 0, 100),
    score_nice: clampInt_(scoring.score_nice, 0, 100),
    final_score: finalScore,
    reject_triggered: mergedRejectTriggered,
    reject_reasons: rejectReasons,
    reject_evidence: mergedRejectTriggered ? extractRejectEvidence_(jdClean) : "",
    reason_top_matches: String(scoring.reason_top_matches || "").slice(0, 1000),
    potential_contacts: potentialContacts,
    contacts_persist: contactsPersist,
  };
}

async function extractJdWithModel_(ai, text, opts = {}) {
  // Governance: JD extraction is pinned to deterministic runtime controls.
  const maxTokens = clampInt_(opts.maxTokens || 500, 128, 700);
  const prompt = `
You are an information extraction engine.
Return STRICT JSON only. No markdown. No commentary.

Extract fields from this job description text.

Return JSON exactly in this format:
{
  "company": string|null,
  "role_title": string|null,
  "location": string|null,
  "work_mode": "Onsite"|"Hybrid"|"Remote"|null,
  "experience_years_min": number|null,
  "experience_years_max": number|null,
  "must_have_keywords": string[],
  "nice_to_have_keywords": string[],
  "reject_keywords": string[],
  "skills": string[],
  "seniority": "Intern"|"Junior"|"Mid"|"Senior"|"Lead"|"Manager"|"Director"|"VP"|null,
  "company_industry": string|null
}

Rules:
- Do not invent company or role if unclear.
- Extract only explicit information.
- If missing, return null or empty array.

TEXT:
${text}
`.trim();

  const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: maxTokens,
  });

  const raw = pickModelText_(result);
  const parsed = safeJsonParse_(raw);
  if (!parsed) throw new Error("Model returned invalid JSON");
  // normalize arrays
  parsed.must_have_keywords = Array.isArray(parsed.must_have_keywords) ? parsed.must_have_keywords : [];
  parsed.nice_to_have_keywords = Array.isArray(parsed.nice_to_have_keywords) ? parsed.nice_to_have_keywords : [];
  parsed.reject_keywords = Array.isArray(parsed.reject_keywords) ? parsed.reject_keywords : [];
  parsed.skills = Array.isArray(parsed.skills) ? parsed.skills : [];
  return parsed;
}

function deriveRoleFromJobUrl_(jobUrl, sourceDomain = "") {
  const source = normalizeSourceDomainName_(sourceDomain || sourceDomainFromUrl_(jobUrl));
  const url = String(jobUrl || "").trim();
  if (!url) return "";

  try {
    const u = new URL(url);
    const path = String(u.pathname || "");
    let slug = "";
    if (source === "iimjobs") {
      const m = path.match(/\/j\/([^/?#]+)/i);
      slug = m && m[1] ? m[1] : "";
    } else if (source === "naukri") {
      const m = path.match(/\/job-listings-([^/?#]+)/i);
      slug = m && m[1] ? m[1] : "";
    }
    if (!slug) return "";
    slug = slug.replace(/-\d{4,}$/i, "");
    slug = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    slug = slug
      .replace(/\b\d+\s*[-to]+\s*\d+\s*(?:yrs?|years?)\b/gi, "")
      .replace(/\b\d+\s*(?:yrs?|years?)\b/gi, "")
      .replace(/\b(?:yrs?|years?)\b/gi, "")
      .replace(/\b(?:experience|exp)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    const words = slug.split(" ").filter(Boolean);
    if (words.length >= 4 && /(?:com|in|net|org)$/i.test(words[0])) words.shift();
    if (words.length && /^(iimjobs|naukri|linkedin)$/i.test(words[0])) words.shift();
    slug = words.join(" ").trim();

    return cleanRoleTitle_(slug);
  } catch {
    return "";
  }
}

function deriveCompanyFromText_(text, emailSubject = "") {
  const src = `${String(emailSubject || "")}\n${String(text || "")}`;
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40);
  for (const line of lines) {
    let m =
      line.match(/^\s*about\s+([A-Za-z][A-Za-z0-9&.,'()\- ]{2,80})$/i) ||
      line.match(/^\s*company\s*[:\-]\s*([A-Za-z][A-Za-z0-9&.,'()\- ]{2,80})/i) ||
      line.match(/(?:^|\s)at\s+([A-Za-z][A-Za-z0-9&.,'()\- ]{2,50})(?:\s*[\-|]|$)/i);
    if (!m || !m[1]) continue;
    const cleaned = cleanHumanLabel_(String(m[1] || "").trim());
    if (isLikelyCompanyName_(cleaned)) return cleaned;
  }
  return "";
}

function sanitizeExtracted_(raw, jdText, ctx = {}) {
  if (!raw || typeof raw !== "object") return null;
  const out = { ...raw };
  const txt = String(jdText || "");
  const jobUrl = String(ctx?.job_url || "").trim();
  const sourceDomain = String(ctx?.source_domain || sourceDomainFromUrl_(jobUrl)).trim();
  const emailSubject = String(ctx?.email_subject || "").trim();

  const badLabels = new Set(["startup", "company", "organization", "introduction", "role", "job"]);
  const normalize = (v) => String(v || "").replace(/\s+/g, " ").trim();

  out.company = cleanHumanLabel_(normalize(out.company));
  out.role_title = cleanRoleTitle_(normalize(out.role_title));
  out.location = normalize(out.location);
  out.seniority = normalize(out.seniority);
  out.work_mode = normalize(out.work_mode);

  if (badLabels.has(out.company.toLowerCase())) out.company = "";
  if (badLabels.has(out.role_title.toLowerCase())) out.role_title = "";
  if (out.company && !isLikelyCompanyName_(out.company)) out.company = "";

  if (!out.role_title || out.role_title.length < 3) {
    const m =
      txt.match(/as a\s+([^\n,]{3,140})[,.:]/i) ||
      txt.match(/role(?:\s+and\s+responsibilities)?\s*[:\-]\s*([^\n]{3,140})/i);
    if (m && m[1]) out.role_title = cleanRoleTitle_(normalize(m[1]));
  }

  if (!out.role_title || out.role_title.length < 3) {
    const fromUrl = deriveRoleFromJobUrl_(jobUrl, sourceDomain);
    if (fromUrl) out.role_title = fromUrl;
  }

  if (!out.company || out.company.length < 2) {
    const fromText = deriveCompanyFromText_(txt, emailSubject);
    if (fromText) out.company = fromText;
  }

  if (!Array.isArray(out.skills)) out.skills = [];
  if (!Array.isArray(out.must_have_keywords)) out.must_have_keywords = [];
  if (!Array.isArray(out.nice_to_have_keywords)) out.nice_to_have_keywords = [];
  if (!Array.isArray(out.reject_keywords)) out.reject_keywords = [];

  return out;
}

function sanitizePotentialContacts_(rawContacts, ctx = {}) {
  const seedCompany = cleanHumanLabel_(String(ctx?.company || "").trim()).slice(0, 120);
  const contacts = Array.isArray(rawContacts) ? rawContacts : [];
  const out = [];
  const seen = new Set();
  const bannedNames = new Set([
    "hiring manager",
    "hiring team",
    "head of engineering",
    "head of product",
    "head of marketing",
    "talent acquisition",
    "recruiter",
    "hr team",
  ]);

  for (const row of contacts) {
    const item = row && typeof row === "object" ? row : {};
    const rawName = typeof row === "string"
      ? row
      : (item.name ?? item.full_name ?? item.person_name ?? item.contact_name ?? "");
    const rawTitle = item.title ?? item.role ?? item.designation ?? "";
    const rawContext = item.context_snippet ?? item.context ?? item.snippet ?? "";
    const rawCompany = item.company ?? item.company_name ?? seedCompany;

    const name = cleanHumanLabel_(String(rawName || "").trim()).slice(0, 120);
    if (!name) continue;
    if (name.length < 3) continue;
    if (/\d/.test(name)) continue;
    if (bannedNames.has(name.toLowerCase())) continue;

    const tokenCount = name.split(/\s+/g).filter(Boolean).length;
    if (tokenCount < 2 && !/^[A-Z][a-z]{3,}$/.test(name)) continue;

    const title = cleanHumanLabel_(String(rawTitle || "").trim()).slice(0, 160);
    const contextSnippet = String(rawContext || "").replace(/\s+/g, " ").trim().slice(0, 280);
    const company = cleanHumanLabel_(String(rawCompany || "").trim()).slice(0, 120);
    const confidence = clampInt_(item.confidence ?? item.score ?? 70, 0, 100);

    const dedupeKey = `${name.toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      name,
      title,
      company: company || seedCompany || "",
      context_snippet: contextSnippet,
      confidence,
      source: "jd_mention",
    });

    if (out.length >= 5) break;
  }

  return out;
}

async function scoreJobWithModel_(ai, job, targets, cfg) {
  const roleTitle = String(job.role_title || "").trim();
  const company = String(job.company || "").trim();
  const location = String(job.location || "").trim();
  const seniority = String(job.seniority || "").trim();
  const jdClean = String(job.jd_clean || "").trim();

  const scoringPrompt = `
You are a job scoring engine.
Return STRICT JSON only. No markdown. No commentary.

Task:
Given 1 job and a list of targets, pick the best target and score the job fit.

OUTPUT JSON EXACTLY IN THIS FORMAT:
{
  "primary_target_id": string,
  "score_must": number,       // 0-100
  "score_nice": number,       // 0-100
  "final_score": number,      // 0-100
  "reject_triggered": boolean,
  "reason_top_matches": string,
  "potential_contacts": [
    {
      "name": string,
      "title": string,
      "context_snippet": string,
      "confidence": number
    }
  ]
}

Rules:
- score_must: job.role_title vs target.primaryRole/target.name.
- score_nice: seniority + location fit (use job.seniority and job.location and jd_clean).
- final_score integer 0-100 (round). Use:
    final = score_must*0.40 + score_nice*0.35 + signal_score*0.25
  where signal_score (0-100) measures JD clarity/structure.
- Do not invent facts; base only on provided text.
- If you see explicit disqualifiers, set reject_triggered=true and mention why in reason_top_matches.
- potential_contacts:
  - include only people explicitly mentioned in JD/company context
  - if no specific person is mentioned, return []
  - never fabricate names

JOB:
{
  "company": ${jsonString_(company)},
  "role_title": ${jsonString_(roleTitle)},
  "location": ${jsonString_(location)},
  "seniority": ${jsonString_(seniority)},
  "jd_clean": ${jsonString_(jdClean)}
}

TARGETS:
${JSON.stringify(targets.map(t => ({
  id: t.id,
  name: t.name,
  primaryRole: t.primaryRole,
  seniorityPref: t.seniorityPref,
  locationPref: t.locationPref
})), null, 2)}
`.trim();

  const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: scoringPrompt }],
    temperature: 0,
  });

  const raw = pickModelText_(result);
  const parsed = safeJsonParse_(raw);
  if (!parsed) throw new Error("Model returned invalid JSON");
  const usage = pickModelUsage_(result);
  const potentialContacts = sanitizePotentialContacts_(parsed.potential_contacts, { company });

  return {
    primary_target_id: String(parsed.primary_target_id || "").trim() || cfg.DEFAULT_TARGET_ID,
    score_must: clampInt_(parsed.score_must, 0, 100),
    score_nice: clampInt_(parsed.score_nice, 0, 100),
    final_score: clampInt_(parsed.final_score, 0, 100),
    reject_triggered: Boolean(parsed.reject_triggered),
    reason_top_matches: String(parsed.reason_top_matches || "").slice(0, 1000),
    potential_contacts: potentialContacts,
    _meta: {
      model: "@cf/meta/llama-3.1-8b-instruct",
      usage,
    },
  };
}

/* =========================================================
 * URL normalization
 * ========================================================= */

async function normalizeJobUrl_(rawUrl) {
  const normalizedInput = unwrapKnownTrackingUrl_(String(rawUrl || "").trim());
  let u;
  try {
    u = new URL(normalizedInput);
  } catch {
    return { ignored: true };
  }

  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();

  // Ignore inbox pages
  if (host.includes("naukri.com") && path.includes("/mnjuser/inbox")) return { ignored: true };

  const strip = (url) => {
    const x = new URL(url);
    x.search = "";
    x.hash = "";
    return x.toString().replace(/\/+$/, "");
  };

  const sha1Hex = async (s) => {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  if (host.includes("linkedin.com")) {
    const id =
      u.searchParams.get("currentJobId") ||
      u.searchParams.get("currentjobid") ||
      (u.pathname.match(/\/jobs\/view\/(\d+)/i)?.[1] || "");

    if (id && /^\d+$/.test(id)) {
      const canonical = `https://www.linkedin.com/jobs/view/${id}/`;
      return { ignored: false, source_domain: "linkedin", job_id: id, job_url: canonical, job_key: await sha1Hex(`linkedin|${id}`) };
    }
    // Ignore non-job LinkedIn links (collections/search/share/tracking without concrete job id).
    return { ignored: true };
  }

  if (host.includes("iimjobs.com")) {
    if (!/^\/j\//i.test(path)) return { ignored: true };
    const canonical = strip(normalizedInput).replace(/\.html$/i, "");
    const last = canonical.split("/").filter(Boolean).pop() || "";
    const id = last.match(/-(\d+)(?:\.html)?$/i)?.[1] || null;
    return {
      ignored: false,
      source_domain: "iimjobs",
      job_id: id,
      job_url: canonical,
      job_key: await sha1Hex(id ? `iimjobs|${id}` : `url|${canonical}`)
    };
  }

  if (host.includes("naukri.com")) {
    if (!path.includes("/job-listings-")) return { ignored: true };
    const canonical = strip(normalizedInput);
    const last = canonical.split("/").filter(Boolean).pop() || "";
    const id = last.match(/-(\d+)(?:$|[^0-9])/i)?.[1] || null;
    return {
      ignored: false,
      source_domain: "naukri",
      job_id: id,
      job_url: canonical,
      job_key: await sha1Hex(id ? `naukri|${id}` : `url|${canonical}`)
    };
  }

  const canonical = strip(normalizedInput);
  return { ignored: false, source_domain: host, job_id: null, job_url: canonical, job_key: await sha1Hex(`url|${canonical}`) };
}

function unwrapKnownTrackingUrl_(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  // IIMJobs postoffice wrapper format:
  // https://postoffice.iimjobs.com/CL0/<encoded-target-url>/<...>
  const cl0Match = input.match(/\/CL0\/(https?:%2F%2F.*?)(?:\/\d+\/|$)/i);
  if (cl0Match?.[1]) {
    const decoded = decodeUrlSafely_(cl0Match[1]);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }

  let u;
  try {
    u = new URL(input);
  } catch {
    return input;
  }

  const redirectParams = [
    "url",
    "u",
    "q",
    "redirect",
    "redirect_url",
    "redirectUrl",
    "target",
    "dest",
    "destination",
    "to",
    "r",
    "href",
    "next",
  ];

  for (const key of redirectParams) {
    const val = u.searchParams.get(key);
    if (!val) continue;
    const decoded = decodeUrlSafely_(val);
    const decodedTwice = decodeUrlSafely_(decoded);
    if (/^https?:\/\//i.test(decodedTwice)) return decodedTwice;
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }

  return input;
}

function decodeUrlSafely_(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  try {
    return decodeURIComponent(s.replace(/\+/g, "%20"));
  } catch {
    return s;
  }
}

/* =========================================================
 * JD resolution (fetch + email fallback + window extraction)
 * ========================================================= */

async function resolveJd_(env, jobUrl, { emailHtml, emailText, emailSubject, emailFrom }) {
  const out = { jd_text_clean: "", jd_source: "none", fetch_status: "failed", debug: { jd_confidence: "low", jd_length: 0 } };
  const sourceDomain = sourceDomainFromUrl_(jobUrl);
  const sourceName = normalizeSourceDomainName_(sourceDomain);

  // Strict LinkedIn policy: avoid slow/blocked fetch loops and go to manual/email path.
  if (sourceName === "linkedin") {
    out.fetch_status = "blocked";
    out.debug.skipped_fetch = "strict_linkedin_manual";
  } else {
    // Try fetch first
    const fetchTimeoutMs = clampInt_(env?.JD_FETCH_TIMEOUT_MS || 7000, 1500, 15000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("jd_fetch_timeout"), fetchTimeoutMs);
    try {
      const res = await fetch(jobUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      out.debug.http_status = res.status;

      if ([401, 403, 429].includes(res.status)) {
        out.fetch_status = "blocked";
      } else if (!res.ok) {
        out.fetch_status = "failed";
      } else {
        const html = await res.text();
        const text = htmlToText_(html);
        const cleanedAll = cleanJdText_(text);
        const cleaned = extractJdWindow_(cleanedAll);

        if (isLowQualityJd_(cleaned, sourceDomain)) {
          out.fetch_status = "blocked";
          out.debug.low_quality = true;
          out.debug.jd_confidence = "low";
          out.debug.jd_length = cleaned.length;
        } else if (cleaned.length >= 260) {
          const confidence = computeJdConfidence_(cleaned);
          out.jd_text_clean = cleaned.slice(0, 12000);
          out.jd_source = "fetched";
          out.fetch_status = "ok";
          out.debug.jd_confidence = confidence;
          out.debug.jd_length = cleaned.length;
          return out;
        } else {
          out.fetch_status = out.fetch_status === "blocked" ? "blocked" : "failed";
          out.debug.jd_confidence = "low";
          out.debug.jd_length = cleaned.length;
        }
      }
    } catch (e) {
      const err = String(e?.message || e || "");
      if (err.toLowerCase().includes("abort") || err.toLowerCase().includes("timeout")) {
        out.fetch_status = "failed";
        out.debug.fetch_timeout_ms = fetchTimeoutMs;
      } else {
        out.fetch_status = "blocked";
      }
      out.debug.fetch_error = err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Email fallback
  const fallback = extractJdFromEmail_(emailHtml, emailText, emailSubject, emailFrom);
  if (fallback && fallback.length >= 180) {
    const confidence = computeJdConfidence_(fallback);
    const priorFetchStatus = out.fetch_status;
    out.jd_text_clean = fallback.slice(0, 12000);
    out.jd_source = "email";
    // Fallback content is now the source of truth for scoring readiness.
    out.fetch_status = "ok";
    out.debug.used_email_fallback = true;
    out.debug.fetch_status_before_fallback = priorFetchStatus;
    out.debug.jd_confidence = confidence;
    out.debug.jd_length = fallback.length;
    return out;
  }

  return out;
}

function sourceDomainFromUrl_(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeSourceDomainName_(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw.includes("linkedin")) return "linkedin";
  if (raw.includes("iimjobs")) return "iimjobs";
  if (raw.includes("naukri")) return "naukri";
  return raw.replace(/^www\./, "");
}

function normalizeIngestChannel_(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("rss")) return "rss";
  if (raw.startsWith("gmail")) return "gmail";
  if (raw.startsWith("recover")) return "recover";
  if (raw.startsWith("ui")) return "ui";
  if (raw.startsWith("manual")) return "manual";
  if (raw.startsWith("api")) return "api";
  return raw.replace(/[^a-z0-9_-]/g, "").slice(0, 24);
}

function summarizeRecoveryResultsBySource_(rows) {
  const summary = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const source = normalizeSourceDomainName_(
      row?.source_domain || sourceDomainFromUrl_(row?.job_url || row?.raw_url || "")
    );
    const item = summary.get(source) || {
      source_domain: source,
      total: 0,
      recovered: 0,
      manual_needed: 0,
      needs_ai: 0,
      blocked: 0,
      low_quality: 0,
      link_only: 0,
      ignored: 0,
      inserted: 0,
      updated: 0,
    };
    item.total += 1;

    const action = String(row?.action || "").toLowerCase();
    const status = String(row?.status || "").toUpperCase();
    const systemStatus = String(row?.system_status || "").toUpperCase();
    const fetchStatus = String(row?.fetch_status || "").toLowerCase();
    const fallbackReason = String(row?.fallback_reason || "").toLowerCase();

    if (action === "inserted") item.inserted += 1;
    if (action === "updated") item.updated += 1;
    if (action === "ignored") item.ignored += 1;
    const linkOnlyFlag = status === "LINK_ONLY" || action === "link_only";
    const manualFlag = systemStatus === "NEEDS_MANUAL_JD" || linkOnlyFlag || fallbackReason === "manual_required";
    const needsAiFlag = systemStatus === "AI_UNAVAILABLE" || fetchStatus === "ai_unavailable";
    const blockedFlag = fetchStatus === "blocked" || fetchStatus === "low_quality" || fallbackReason === "blocked";
    const lowQualityFlag = fetchStatus === "low_quality" || fallbackReason === "low_quality";

    if (linkOnlyFlag) item.link_only += 1;
    if (manualFlag) item.manual_needed += 1;
    if (needsAiFlag) item.needs_ai += 1;
    if (blockedFlag) item.blocked += 1;
    if (lowQualityFlag) item.low_quality += 1;
    if (action !== "ignored" && status !== "LINK_ONLY") item.recovered += 1;

    summary.set(source, item);
  }
  return Array.from(summary.values()).sort((a, b) => {
    if (b.recovered !== a.recovered) return b.recovered - a.recovered;
    return b.total - a.total;
  });
}

function isLowQualityJd_(text, sourceDomain) {
  const cleaned = cleanJdText_(text);
  const low = cleaned.toLowerCase();
  if (cleaned.length < 220) return true;

  if (low.includes("linkedin respects your privacy")) return true;
  if (low.includes("enable javascript")) return true;

  const cookieMentions = (low.match(/cookie/g) || []).length;
  const privacyMentions = (low.match(/privacy/g) || []).length;
  const linkedInShell = String(sourceDomain || "").includes("linkedin.com");
  if ((cookieMentions + privacyMentions >= 6) || (linkedInShell && cookieMentions + privacyMentions >= 3)) return true;

  return false;
}

function getSourceFallbackPolicy_(sourceDomain) {
  const source = normalizeSourceDomainName_(sourceDomain);
  if (source === "linkedin") {
    return {
      source_domain: "linkedin",
      min_chars: 280,
      require_high_confidence_for_fetched: true,
      allow_low_confidence_email: false,
      label: "strict_linkedin",
    };
  }
  if (source === "iimjobs") {
    return {
      source_domain: "iimjobs",
      min_chars: 220,
      require_high_confidence_for_fetched: false,
      allow_low_confidence_email: false,
      label: "standard_iimjobs",
    };
  }
  if (source === "naukri") {
    return {
      source_domain: "naukri",
      min_chars: 220,
      require_high_confidence_for_fetched: false,
      allow_low_confidence_email: false,
      label: "standard_naukri",
    };
  }
  if (source === "whatsapp.vonage.local") {
    return {
      source_domain: "whatsapp.vonage.local",
      min_chars: 120,
      require_high_confidence_for_fetched: false,
      allow_low_confidence_email: true,
      label: "whatsapp_media_email_fallback",
    };
  }
  return {
    source_domain: source || "unknown",
    min_chars: 220,
    require_high_confidence_for_fetched: false,
    allow_low_confidence_email: false,
    label: "default",
  };
}

function computeFallbackDecision_(sourceDomain, resolved, jdText, aiAvailable) {
  const policy = getSourceFallbackPolicy_(sourceDomain);
  const jdSource = String(resolved?.jd_source || "").toLowerCase();
  const fetchStatus = String(resolved?.fetch_status || "").toLowerCase();
  const confidence = String(resolved?.debug?.jd_confidence || "").toLowerCase();
  const len = String(jdText || "").trim().length;
  const allowLowConfidence = Boolean(policy?.allow_low_confidence_email && jdSource === "email" && len >= policy.min_chars);
  const hasUsableEmailFallback = jdSource === "email" && len >= policy.min_chars;

  let reason = "none";
  if (!aiAvailable) {
    reason = "manual_required";
  } else if (fetchStatus === "blocked" && !hasUsableEmailFallback) {
    reason = "blocked";
  } else if (fetchStatus === "low_quality" && !hasUsableEmailFallback) {
    reason = "low_quality";
  } else if (jdSource !== "email" && jdSource !== "fetched") {
    reason = "manual_required";
  } else if (len < policy.min_chars) {
    reason = "low_quality";
  } else if (confidence === "low" && !allowLowConfidence) {
    reason = "low_quality";
  } else if (policy.require_high_confidence_for_fetched && jdSource === "fetched" && confidence !== "high") {
    reason = "low_quality";
  }

  return {
    needs_manual: reason !== "none",
    reason,
    policy,
    jd_source: jdSource,
    fetch_status: fetchStatus,
    confidence,
    jd_length: len,
  };
}

function computeJdConfidence_(text) {
  const t = cleanJdText_(text);
  const low = t.toLowerCase();
  const len = t.length;
  if (len < 220) return "low";
  if (isLowQualityJd_(t, "")) return "low";

  let score = 0;
  if (len >= 450) score += 1;
  if (len >= 900) score += 1;
  if (/\b(responsibilities|key responsibilities)\b/i.test(low)) score += 1;
  if (/\b(qualifications|requirements|required skills)\b/i.test(low)) score += 1;
  if (/\b(preferred|nice to have|good to have)\b/i.test(low)) score += 1;

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function extractJdWindow_(t) {
  const s = String(t || "");
  const low = s.toLowerCase();

  const startAnchors = ["description:", "role overview", "job description", "key responsibilities", "responsibilities:"];
  const endAnchors = ["\napply", "\nsave", "similar jobs", "report this job", "copyright", "unsubscribe"];

  let start = -1;
  for (const a of startAnchors) {
    const i = low.indexOf(a);
    if (i !== -1) { start = i; break; }
  }

  let slice = start !== -1 ? s.slice(start) : s;

  const low2 = slice.toLowerCase();
  let end = -1;
  for (const a of endAnchors) {
    const i = low2.indexOf(a);
    if (i !== -1) { end = i; break; }
  }
  if (end !== -1) slice = slice.slice(0, end);

  return slice.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function extractJdFromEmail_(emailHtml, emailText, emailSubject, emailFrom) {
  const textFromHtml = emailHtml ? htmlToText_(emailHtml) : "";
  const subjectLine = String(emailSubject || "").trim();
  const fromLine = String(emailFrom || "").trim();
  const metadata = [];
  if (subjectLine) metadata.push(`Subject: ${subjectLine}`);
  if (fromLine) metadata.push(`From: ${fromLine}`);
  const combined = [metadata.join("\n"), String(emailText || ""), String(textFromHtml || "")]
    .filter(Boolean)
    .join("\n\n");
  const t = combined.replace(/\r/g, "").trim();
  if (!t) return "";

  const anchors = [
    "job description",
    "description",
    "role overview",
    "responsibilities",
    "key responsibilities",
    "what are we looking for",
    "skills",
    "qualifications",
    "preferred candidate profile",
  ];

  const low = t.toLowerCase();
  let startIdx = -1;
  for (const a of anchors) {
    const i = low.indexOf(a);
    if (i !== -1) { startIdx = i; break; }
  }

  let snippet = startIdx !== -1 ? t.slice(startIdx) : t;

  snippet = snippet
    .replace(/unsubscribe[\s\S]*$/i, "")
    .replace(/copyright[\s\S]*$/i, "")
    .replace(/all rights reserved[\s\S]*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleanJdText_(extractJdWindow_(snippet));
}

function htmlToText_(html) {
  const s = String(html || "");
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanJdText_(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* =========================================================
 * Reject helpers
 * ========================================================= */

function hasRejectMarker_(text) {
  return String(text || "").toLowerCase().includes("reject:");
}

function extractRejectEvidence_(text) {
  const t = String(text || "");
  const low = t.toLowerCase();
  const i = low.indexOf("reject:");
  if (i === -1) return "";
  return t.slice(i, Math.min(i + 220, t.length)).replace(/\s+/g, " ").trim();
}

function computeTargetReject_(jd, targetId, targets) {
  const t = targets.find((x) => x.id === targetId);
  const list = Array.isArray(t?.reject) ? t.reject : [];
  if (!list.length) return { triggered: false, matches: [] };

  const low = String(jd || "").toLowerCase();
  const matches = [];
  for (const kw of list) {
    const k = String(kw || "").trim().toLowerCase();
    if (!k) continue;
    if (low.includes(k)) matches.push(k);
  }
  return { triggered: matches.length > 0, matches: unique_(matches).slice(0, 10) };
}

function computeSystemStatus_(finalScore, rejectTriggered, cfg) {
  if (rejectTriggered) return "REJECTED";
  if (finalScore >= cfg.SCORE_THRESHOLD_SHORTLIST) return "SHORTLISTED";
  if (finalScore < cfg.SCORE_THRESHOLD_ARCHIVE) return "ARCHIVED";
  return "SCORED";
}

function applyStatusTransition_(job, reason, opts = {}) {
  if (reason === "ingest_ready") {
    return { status: "NEW", system_status: null, next_status: null };
  }
  if (reason === "ingest_needs_manual") {
    return { status: "LINK_ONLY", system_status: "NEEDS_MANUAL_JD", next_status: null };
  }
  if (reason === "ingest_ai_unavailable") {
    return { status: "LINK_ONLY", system_status: "AI_UNAVAILABLE", next_status: null };
  }
  if (reason === "manual_saved_no_ai") {
    return {
      status: String(job?.status || "LINK_ONLY").trim() || "LINK_ONLY",
      system_status: "AI_UNAVAILABLE",
      next_status: null,
    };
  }
  if (reason === "heuristic_rejected") {
    return { status: "REJECTED", system_status: "REJECTED_HEURISTIC", next_status: null };
  }
  if (reason === "scored") {
    const cfg = opts.cfg || { SCORE_THRESHOLD_SHORTLIST: 75, SCORE_THRESHOLD_ARCHIVE: 55 };
    const status = computeSystemStatus_(
      clampInt_(opts.final_score, 0, 100),
      Boolean(opts.reject_triggered),
      cfg
    );
    return { status, system_status: null, next_status: null };
  }
  return {
    status: String(job?.status || "NEW").trim() || "NEW",
    system_status: job?.system_status ?? null,
    next_status: job?.next_status ?? null,
  };
}

/* =========================================================
 * Common helpers
 * ========================================================= */

function getAi_(env) {
  if (env && env.AI) return env.AI;
  const name = env && env.AI_BINDING ? String(env.AI_BINDING).trim() : "";
  if (name && env && env[name]) return env[name];
  return null;
}

async function ingestRawUrls_(env, { rawUrls, emailText, emailHtml, emailSubject, emailFrom, ingestChannel }) {
  const now = Date.now();
  const results = [];
  let insertedOrUpdated = 0;
  let insertedCount = 0;
  let updatedCount = 0;
  let ignored = 0;
  let linkOnly = 0;

  const aiForIngest = getAi_(env);
  const aiAvailable = Boolean(aiForIngest);
  let targets = [];
  let cfg = null;
  if (aiAvailable) {
    try {
      targets = await loadTargets_(env);
      if (targets.length) cfg = await loadSysCfg_(env);
    } catch {
      targets = [];
      cfg = null;
    }
  }
  const canAutoScore = aiAvailable && targets.length > 0 && !!cfg;
  const channel = normalizeIngestChannel_(ingestChannel) || "ui";

  for (const rawUrl of rawUrls || []) {
    const norm = await normalizeJobUrl_(String(rawUrl || "").trim());
    if (!norm || norm.ignored) {
      ignored += 1;
      results.push({
        raw_url: rawUrl,
        source_domain: normalizeSourceDomainName_(sourceDomainFromUrl_(rawUrl)),
        was_existing: false,
        action: "ignored",
      });
      continue;
    }

    const existing = await env.DB.prepare(
      `SELECT 1 AS ok FROM jobs WHERE job_key = ? LIMIT 1;`
    ).bind(norm.job_key).first();
    const wasExisting = Boolean(existing && existing.ok === 1);

    const resolved = await resolveJd_(env, norm.job_url, { emailHtml, emailText, emailSubject, emailFrom });

    const jdText = String(resolved.jd_text_clean || "").trim();
    const fallbackDecision = computeFallbackDecision_(norm.source_domain, resolved, jdText, aiAvailable);
    const needsManual = fallbackDecision.needs_manual;
    let extracted = null;
    if (!needsManual && jdText && jdText.length >= 180) {
      extracted = await extractJdWithModel_(aiForIngest, jdText)
        .then((x) => sanitizeExtracted_(x, jdText, {
          job_url: norm?.job_url,
          source_domain: norm?.source_domain,
          email_subject: emailSubject,
        }))
        .catch(() => null);
    }

    const company = extracted?.company ?? null;
    const roleTitle = extracted?.role_title ?? null;
    const location = extracted?.location ?? null;
    const workMode = extracted?.work_mode ?? null;
    const seniority = extracted?.seniority ?? null;

    const skills = Array.isArray(extracted?.skills) ? extracted.skills : [];
    const must = Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : [];
    const nice = Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : [];
    const reject = Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : [];

    let pipelineResult = null;
    let finalScore = null;
    if (!needsManual && canAutoScore && jdText && jdText.length >= 180) {
      const roleTitleForScore = String(extracted?.role_title || "").trim();
      const locationForScore = String(extracted?.location || "").trim();
      const seniorityForScore = String(extracted?.seniority || "").trim();
      if (roleTitleForScore || jdText) {
        pipelineResult = await runScoringPipelineForJob_(env, {
          source: `ingest-${channel}`,
          job_key: norm.job_key,
          existing_job: null,
          ai: aiForIngest,
          targets,
          cfg,
          jd_clean: jdText,
          company: String(extracted?.company || "").trim(),
          role_title: roleTitleForScore,
          location: locationForScore,
          seniority: seniorityForScore,
        }).catch(() => null);
      }

      if (pipelineResult) {
        finalScore = pipelineResult.final_score;
      }
    }

    let effectiveFetchStatus = aiAvailable ? String(resolved.fetch_status || "failed") : "ai_unavailable";
    if (aiAvailable && fallbackDecision.reason === "low_quality" && effectiveFetchStatus !== "blocked") {
      effectiveFetchStatus = "low_quality";
    }
    if (!aiAvailable) {
      effectiveFetchStatus = "ai_unavailable";
    }
    const fetchDebug = {
      ...(resolved.debug || {}),
      ai_available: aiAvailable,
      ingest_channel: channel,
      fallback_reason: fallbackDecision.reason,
      fallback_policy: fallbackDecision.policy?.label || "default",
      source_policy_domain: fallbackDecision.policy?.source_domain || normalizeSourceDomainName_(norm.source_domain),
    };
    let transition = !aiAvailable
      ? applyStatusTransition_(null, "ingest_ai_unavailable")
      : (needsManual
        ? applyStatusTransition_(null, "ingest_needs_manual")
        : applyStatusTransition_(null, "ingest_ready"));
    if (pipelineResult) {
      transition = pipelineResult.transition;
    }

    const r = await env.DB.prepare(`
      INSERT INTO jobs (
        job_key, job_url, job_url_raw, source_domain, job_id,
        company, role_title, location, work_mode, seniority,
        experience_years_min, experience_years_max,
        skills_json, must_have_keywords_json, nice_to_have_keywords_json, reject_keywords_json,
        jd_text_clean, jd_source, fetch_status, fetch_debug_json,
        status, next_status, system_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_key) DO UPDATE SET
        job_url = excluded.job_url,
        job_url_raw = excluded.job_url_raw,
        source_domain = excluded.source_domain,
        job_id = excluded.job_id,
        company = COALESCE(excluded.company, jobs.company),
        role_title = COALESCE(excluded.role_title, jobs.role_title),
        location = COALESCE(excluded.location, jobs.location),
        work_mode = COALESCE(excluded.work_mode, jobs.work_mode),
        seniority = COALESCE(excluded.seniority, jobs.seniority),
        experience_years_min = COALESCE(excluded.experience_years_min, jobs.experience_years_min),
        experience_years_max = COALESCE(excluded.experience_years_max, jobs.experience_years_max),
        skills_json = CASE WHEN excluded.skills_json != '[]' THEN excluded.skills_json ELSE jobs.skills_json END,
        must_have_keywords_json = CASE WHEN excluded.must_have_keywords_json != '[]' THEN excluded.must_have_keywords_json ELSE jobs.must_have_keywords_json END,
        nice_to_have_keywords_json = CASE WHEN excluded.nice_to_have_keywords_json != '[]' THEN excluded.nice_to_have_keywords_json ELSE jobs.nice_to_have_keywords_json END,
        reject_keywords_json = CASE WHEN excluded.reject_keywords_json != '[]' THEN excluded.reject_keywords_json ELSE jobs.reject_keywords_json END,
        jd_text_clean = CASE WHEN excluded.jd_text_clean != '' THEN excluded.jd_text_clean ELSE jobs.jd_text_clean END,
        jd_source = COALESCE(excluded.jd_source, jobs.jd_source),
        fetch_status = COALESCE(excluded.fetch_status, jobs.fetch_status),
        fetch_debug_json = COALESCE(excluded.fetch_debug_json, jobs.fetch_debug_json),
        status = CASE
          WHEN jobs.status IN ('READY_TO_APPLY', 'APPLIED', 'REJECTED', 'ARCHIVED') THEN jobs.status
          WHEN excluded.status = 'LINK_ONLY' AND jobs.status IN ('NEW', 'LINK_ONLY') THEN 'LINK_ONLY'
          ELSE jobs.status
        END,
        next_status = CASE
          WHEN excluded.status = 'LINK_ONLY' AND jobs.status = 'SCORED' THEN jobs.next_status
          ELSE excluded.next_status
        END,
        system_status = CASE
          WHEN excluded.status = 'LINK_ONLY' AND jobs.status = 'SCORED' THEN jobs.system_status
          ELSE excluded.system_status
        END,
        updated_at = excluded.updated_at;
    `.trim()).bind(
      norm.job_key,
      norm.job_url,
      rawUrl,
      norm.source_domain,
      norm.job_id,
      company,
      roleTitle,
      location,
      workMode,
      seniority,
      numOrNull_(extracted?.experience_years_min),
      numOrNull_(extracted?.experience_years_max),
      JSON.stringify(skills),
      JSON.stringify(must),
      JSON.stringify(nice),
      JSON.stringify(reject),
      jdText.slice(0, 12000),
      resolved.jd_source,
      effectiveFetchStatus,
      JSON.stringify(fetchDebug),
      transition.status,
      transition.next_status,
      transition.system_status,
      now,
      now
    ).run();

    if (pipelineResult) {
      const scoreNow = Date.now();
      await env.DB.prepare(`
        UPDATE jobs SET
          primary_target_id = ?,
          score_must = ?,
          score_nice = ?,
          final_score = ?,
          reject_triggered = ?,
          reject_reasons_json = ?,
          reject_evidence = ?,
          reason_top_matches = ?,
          status = CASE
            WHEN status IN ('READY_TO_APPLY', 'APPLIED', 'REJECTED', 'ARCHIVED') THEN status
            ELSE ?
          END,
          system_status = CASE
            WHEN status IN ('READY_TO_APPLY', 'APPLIED', 'REJECTED', 'ARCHIVED') THEN system_status
            ELSE ?
          END,
          next_status = CASE
            WHEN status IN ('READY_TO_APPLY', 'APPLIED', 'REJECTED', 'ARCHIVED') THEN next_status
            ELSE ?
          END,
          last_scored_at = ?,
          updated_at = ?
        WHERE job_key = ?;
      `.trim()).bind(
        pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
        clampInt_(pipelineResult.score_must, 0, 100),
        clampInt_(pipelineResult.score_nice, 0, 100),
        finalScore,
        pipelineResult.reject_triggered ? 1 : 0,
        JSON.stringify(pipelineResult.reject_reasons || []),
        String(pipelineResult.reject_evidence || "").slice(0, 220),
        String(pipelineResult.reason_top_matches || "").slice(0, 1000),
        transition.status,
        transition.system_status,
        transition.next_status,
        scoreNow,
        scoreNow,
        norm.job_key
      ).run();
    }

    if (r.success) insertedOrUpdated += 1;
    if (transition.status === "LINK_ONLY") linkOnly += 1;

    let action = wasExisting ? "updated" : "inserted";
    if (transition.status === "LINK_ONLY" && aiAvailable) action = "link_only";

    if (action === "inserted") insertedCount += 1;
    if (action === "updated") updatedCount += 1;

    if (needsManual) {
      await logEvent_(env, "INGEST_FALLBACK", norm.job_key, {
        source_domain: normalizeSourceDomainName_(norm.source_domain),
        fallback_reason: fallbackDecision.reason,
        fallback_policy: fallbackDecision.policy?.label || "default",
        fetch_status: effectiveFetchStatus,
        jd_source: String(resolved.jd_source || "").trim().toLowerCase() || "none",
        jd_confidence: String(resolved?.debug?.jd_confidence || "").trim().toLowerCase() || "low",
        ai_available: aiAvailable,
        ts: Date.now(),
      });
    }

    results.push({
      raw_url: rawUrl,
      job_key: norm.job_key,
      job_url: norm.job_url,
      source_domain: normalizeSourceDomainName_(norm.source_domain),
      ingest_channel: channel,
      was_existing: wasExisting,
      action,
      status: transition.status,
      jd_source: resolved.jd_source,
      fetch_status: effectiveFetchStatus,
      system_status: transition.system_status,
      fallback_reason: fallbackDecision.reason,
      fallback_policy: fallbackDecision.policy?.label || "default",
      final_score: finalScore,
      primary_target_id: pipelineResult?.primary_target_id || null,
      potential_contacts: Array.isArray(pipelineResult?.potential_contacts) ? pipelineResult.potential_contacts : [],
    });
  }

  return {
    count_in: Array.isArray(rawUrls) ? rawUrls.length : 0,
    inserted_or_updated: insertedOrUpdated,
    inserted_count: insertedCount,
    updated_count: updatedCount,
    ignored,
    link_only: linkOnly,
    source_summary: summarizeRecoveryResultsBySource_(results),
    results,
  };
}

function mergeIngestBatchResults_(parts) {
  const rows = Array.isArray(parts) ? parts : [];
  const merged = {
    count_in: 0,
    inserted_or_updated: 0,
    inserted_count: 0,
    updated_count: 0,
    ignored: 0,
    link_only: 0,
    source_summary: [],
    results: [],
  };
  for (const p of rows) {
    merged.count_in += numOr_(p?.count_in, 0);
    merged.inserted_or_updated += numOr_(p?.inserted_or_updated, 0);
    merged.inserted_count += numOr_(p?.inserted_count, 0);
    merged.updated_count += numOr_(p?.updated_count, 0);
    merged.ignored += numOr_(p?.ignored, 0);
    merged.link_only += numOr_(p?.link_only, 0);
    if (Array.isArray(p?.results)) merged.results.push(...p.results);
  }
  merged.source_summary = summarizeRecoveryResultsBySource_(merged.results);
  return merged;
}

async function runIngestBatchConcurrent_(env, opts = {}) {
  const urls = Array.isArray(opts.rawUrls)
    ? opts.rawUrls.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const concurrency = clampInt_(opts.concurrency || 1, 1, 6);
  if (!urls.length) return mergeIngestBatchResults_([]);
  if (concurrency <= 1 || urls.length === 1) {
    return ingestRawUrls_(env, {
      rawUrls: urls,
      emailText: opts.emailText,
      emailHtml: opts.emailHtml,
      emailSubject: opts.emailSubject,
      emailFrom: opts.emailFrom,
      ingestChannel: opts.ingestChannel,
    });
  }

  let idx = 0;
  const parts = [];
  const workerCount = Math.min(concurrency, urls.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (idx >= urls.length) break;
      const i = idx;
      idx += 1;
      const raw = urls[i];
      try {
        const part = await ingestRawUrls_(env, {
          rawUrls: [raw],
          emailText: opts.emailText,
          emailHtml: opts.emailHtml,
          emailSubject: opts.emailSubject,
          emailFrom: opts.emailFrom,
          ingestChannel: opts.ingestChannel,
        });
        parts.push(part);
      } catch (e) {
        parts.push({
          count_in: 1,
          inserted_or_updated: 0,
          inserted_count: 0,
          updated_count: 0,
          ignored: 1,
          link_only: 0,
          source_summary: [],
          results: [{
            raw_url: raw,
            source_domain: normalizeSourceDomainName_(sourceDomainFromUrl_(raw)),
            action: "ignored",
            error: String(e?.message || e),
          }],
        });
      }
    }
  });

  await Promise.all(workers);
  return mergeIngestBatchResults_(parts);
}

async function runScorePending_(env, ai, body = {}, opts = {}) {
  const defaultStatuses = Array.isArray(opts.defaultStatuses) && opts.defaultStatuses.length
    ? opts.defaultStatuses
    : ["NEW"];
  const allowedStatuses = new Set(
    Array.isArray(opts.allowedStatuses) && opts.allowedStatuses.length
      ? opts.allowedStatuses.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
      : ["NEW", "SCORED"]
  );
  const requireJd = Boolean(opts.requireJd);
  const limit = clampInt_(body.limit || 30, 1, 200);

  const statusIn = body.status;
  const requestedStatuses = Array.isArray(statusIn)
    ? statusIn
    : String(statusIn || "").split(",");
  const normalized = requestedStatuses
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
  const statuses = (normalized.length ? normalized : defaultStatuses).filter((s) => allowedStatuses.has(s));

  if (!statuses.length) {
    return { ok: false, status: 400, error: `Invalid status filter. Allowed: ${Array.from(allowedStatuses).join(",")}` };
  }
  if (!ai) {
    return { ok: false, status: 500, error: "Missing Workers AI binding (env.AI or AI_BINDING)" };
  }

  const targets = await loadTargets_(env);
  if (!targets.length) return { ok: false, status: 400, error: "No targets configured" };
  const cfg = await loadSysCfg_(env);

  const placeholders = statuses.map(() => "?").join(",");
  const jdWhere = requireJd ? "AND COALESCE(TRIM(jd_text_clean), '') != ''" : "";
  const rows = await env.DB.prepare(`
    SELECT * FROM jobs
    WHERE status IN (${placeholders})
    ${jdWhere}
    ORDER BY updated_at ASC
    LIMIT ?;
  `.trim()).bind(...statuses, limit).all();

  const jobs = rows.results || [];
  let updated = 0;
  const results = [];

  for (const j of jobs) {
    try {
      const jdClean = String(j.jd_text_clean || "").trim();
      let roleTitle = String(j.role_title || "").trim();
      let location = String(j.location || "").trim();
      let seniority = String(j.seniority || "").trim();
      let company = String(j.company || "").trim();
      let extracted = null;

      if (!jdClean && !roleTitle) {
        results.push({ job_key: j.job_key, ok: false, error: "missing_jd_and_title" });
        continue;
      }

      if (jdClean.length >= 180) {
        extracted = await extractJdWithModel_(ai, jdClean)
          .then((x) => sanitizeExtracted_(x, jdClean, {
            job_url: j?.job_url,
            source_domain: j?.source_domain,
            email_subject: "",
          }))
          .catch(() => null);
        if (extracted) {
          roleTitle = String(extracted.role_title || roleTitle || "").trim();
          location = String(extracted.location || location || "").trim();
          seniority = String(extracted.seniority || seniority || "").trim();
          company = String(extracted.company || company || "").trim();
        }
      }

      const pipelineResult = await runScoringPipelineForJob_(env, {
        source: "score-pending",
        job_key: j.job_key,
        existing_job: j,
        ai,
        targets,
        cfg,
        jd_clean: jdClean,
        company,
        role_title: roleTitle,
        location,
        seniority,
      });
      const finalScore = pipelineResult.final_score;
      const transition = pipelineResult.transition;

      const now = Date.now();
      const r = await env.DB.prepare(`
        UPDATE jobs SET
          company = COALESCE(?, company),
          role_title = COALESCE(?, role_title),
          location = COALESCE(?, location),
          work_mode = COALESCE(?, work_mode),
          seniority = COALESCE(?, seniority),
          experience_years_min = COALESCE(?, experience_years_min),
          experience_years_max = COALESCE(?, experience_years_max),
          skills_json = CASE WHEN ? != '[]' THEN ? ELSE skills_json END,
          must_have_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE must_have_keywords_json END,
          nice_to_have_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE nice_to_have_keywords_json END,
          reject_keywords_json = CASE WHEN ? != '[]' THEN ? ELSE reject_keywords_json END,
          primary_target_id = ?,
          score_must = ?,
          score_nice = ?,
          final_score = ?,
          reject_triggered = ?,
          reject_reasons_json = ?,
          reject_evidence = ?,
          reason_top_matches = ?,
          next_status = ?,
          system_status = ?,
          status = ?,
          updated_at = ?,
          last_scored_at = ?
        WHERE job_key = ?;
      `.trim()).bind(
        extracted?.company ?? null,
        extracted?.role_title ?? null,
        extracted?.location ?? null,
        extracted?.work_mode ?? null,
        extracted?.seniority ?? null,
        numOrNull_(extracted?.experience_years_min),
        numOrNull_(extracted?.experience_years_max),
        JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
        JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
        JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
        JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
        pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
        clampInt_(pipelineResult.score_must, 0, 100),
        clampInt_(pipelineResult.score_nice, 0, 100),
        finalScore,
        pipelineResult.reject_triggered ? 1 : 0,
        JSON.stringify(pipelineResult.reject_reasons || []),
        String(pipelineResult.reject_evidence || "").slice(0, 220),
        String(pipelineResult.reason_top_matches || "").slice(0, 1000),
        transition.next_status,
        transition.system_status,
        transition.status,
        now,
        now,
        j.job_key
      ).run();

      if (r.success && r.changes) updated += 1;
      results.push({
        job_key: j.job_key,
        ok: true,
        final_score: finalScore,
        status: transition.status,
        primary_target_id: pipelineResult.primary_target_id || cfg.DEFAULT_TARGET_ID,
        potential_contacts: Array.isArray(pipelineResult.potential_contacts) ? pipelineResult.potential_contacts : [],
      });
    } catch (e) {
      results.push({ job_key: j.job_key, ok: false, error: String(e?.message || e) });
    }
  }

  return {
    ok: true,
    status: 200,
    limit,
    statuses,
    data: {
      picked: jobs.length,
      updated,
      jobs: results,
    },
  };
}

async function runBackfillMissing_(env, limitIn = 30) {
  const limit = clampInt_(limitIn || 30, 1, 200);

  const pickedRes = await env.DB.prepare(`
    SELECT job_key, job_url
    FROM jobs
    WHERE
      status NOT IN ('APPLIED', 'REJECTED', 'ARCHIVED')
      AND (
        status = 'LINK_ONLY'
        OR COALESCE(TRIM(role_title), '') = ''
        OR COALESCE(TRIM(company), '') = ''
        OR COALESCE(TRIM(system_status), '') IN ('AI_UNAVAILABLE', 'NEEDS_MANUAL_JD')
      )
    ORDER BY updated_at DESC
    LIMIT ?;
  `.trim()).bind(limit).all();

  const picked = Array.isArray(pickedRes?.results) ? pickedRes.results : [];
  const rawUrls = [];
  const skippedNoUrl = [];
  for (const row of picked) {
    const u = String(row?.job_url || "").trim();
    if (!u) {
      skippedNoUrl.push(String(row?.job_key || "").trim());
      continue;
    }
    rawUrls.push(u);
  }

  if (!rawUrls.length) {
    return {
      picked: picked.length,
      processed: 0,
      skipped_no_url: skippedNoUrl.length,
      skipped_job_keys: skippedNoUrl,
      inserted_or_updated: 0,
      inserted_count: 0,
      updated_count: 0,
      ignored: 0,
      link_only: 0,
      source_summary: [],
      results: [],
    };
  }

  const recoverConcurrency = clampInt_(env.RECOVER_CONCURRENCY || 3, 1, 6);
  const ingestData = await runIngestBatchConcurrent_(env, {
    rawUrls,
    emailText: "",
    emailHtml: "",
    emailSubject: "",
    emailFrom: "",
    ingestChannel: "recover",
    concurrency: recoverConcurrency,
  });

  return {
    picked: picked.length,
    processed: rawUrls.length,
    skipped_no_url: skippedNoUrl.length,
    skipped_job_keys: skippedNoUrl,
    inserted_or_updated: ingestData?.inserted_or_updated || 0,
    inserted_count: ingestData?.inserted_count || 0,
    updated_count: ingestData?.updated_count || 0,
    ignored: ingestData?.ignored || 0,
    link_only: ingestData?.link_only || 0,
    source_summary: Array.isArray(ingestData?.source_summary) ? ingestData.source_summary : [],
    results: Array.isArray(ingestData?.results) ? ingestData.results : [],
  };
}

async function runRecoverMissingFields_(env, ai, limitIn = 30) {
  const limit = clampInt_(limitIn || 30, 1, 200);
  if (!ai) return { picked: 0, updated: 0, skipped: 0, errors: 0, results: [] };

  const rows = await env.DB.prepare(`
    SELECT *
    FROM jobs
    WHERE
      status NOT IN ('REJECTED', 'ARCHIVED')
      AND COALESCE(TRIM(jd_text_clean), '') != ''
      AND (
        COALESCE(TRIM(role_title), '') = ''
        OR COALESCE(TRIM(company), '') = ''
        OR LENGTH(TRIM(COALESCE(company, ''))) > 55
      )
    ORDER BY updated_at ASC
    LIMIT ?;
  `.trim()).bind(limit).all();

  const jobs = Array.isArray(rows?.results) ? rows.results : [];
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const results = [];

  for (const j of jobs) {
    try {
      const jd = String(j?.jd_text_clean || "").trim();
      if (jd.length < 180) {
        skipped += 1;
        results.push({ job_key: j?.job_key, ok: false, reason: "jd_too_short" });
        continue;
      }

      const fallbackRole = deriveRoleFromJobUrl_(String(j?.job_url || ""), String(j?.source_domain || ""));
      const extracted = await extractJdWithModel_(ai, jd)
        .then((x) => sanitizeExtracted_(x, jd, {
          job_url: j?.job_url,
          source_domain: j?.source_domain,
          email_subject: "",
        }))
        .catch(() => null);

      const currentRole = String(j?.role_title || "").trim();
      const currentCompany = String(j?.company || "").trim();
      const currentLocation = String(j?.location || "").trim();
      const currentWorkMode = String(j?.work_mode || "").trim();
      const currentSeniority = String(j?.seniority || "").trim();
      const currentRoleNoisy = isNoisyRoleTitle_(currentRole);
      const currentCompanyValid = isLikelyCompanyName_(currentCompany);
      const extractedRole = String(extracted?.role_title || "").trim();
      const extractedCompany = String(extracted?.company || "").trim();
      const extractedLocation = String(extracted?.location || "").trim();
      const extractedWorkMode = String(extracted?.work_mode || "").trim();
      const extractedSeniority = String(extracted?.seniority || "").trim();

      const nextRole = currentRole && !currentRoleNoisy
        ? currentRole
        : cleanRoleTitle_(extractedRole || fallbackRole || currentRole);
      const nextCompany = currentCompanyValid
        ? currentCompany
        : (isLikelyCompanyName_(extractedCompany) ? extractedCompany : "");
      const nextLocation = currentLocation || extractedLocation;
      const nextWorkMode = currentWorkMode || extractedWorkMode;
      const nextSeniority = currentSeniority || extractedSeniority;
      const clearInvalidCompany = !currentCompanyValid && !nextCompany;

      const changed =
        nextRole !== currentRole ||
        nextCompany !== currentCompany ||
        clearInvalidCompany ||
        nextLocation !== currentLocation ||
        nextWorkMode !== currentWorkMode ||
        nextSeniority !== currentSeniority;

      if (!changed) {
        skipped += 1;
        results.push({
          job_key: j?.job_key,
          ok: false,
          reason: extracted ? "no_changes" : "extract_failed",
        });
        continue;
      }

      const now = Date.now();
      await env.DB.prepare(`
        UPDATE jobs SET
          role_title = COALESCE(NULLIF(?, ''), role_title),
          company = CASE
            WHEN ? = 1 THEN NULLIF(?, '')
            ELSE COALESCE(NULLIF(?, ''), company)
          END,
          location = COALESCE(NULLIF(?, ''), location),
          work_mode = COALESCE(NULLIF(?, ''), work_mode),
          seniority = COALESCE(NULLIF(?, ''), seniority),
          skills_json = CASE WHEN COALESCE(TRIM(skills_json), '') IN ('', '[]') AND ? != '[]' THEN ? ELSE skills_json END,
          must_have_keywords_json = CASE WHEN COALESCE(TRIM(must_have_keywords_json), '') IN ('', '[]') AND ? != '[]' THEN ? ELSE must_have_keywords_json END,
          nice_to_have_keywords_json = CASE WHEN COALESCE(TRIM(nice_to_have_keywords_json), '') IN ('', '[]') AND ? != '[]' THEN ? ELSE nice_to_have_keywords_json END,
          reject_keywords_json = CASE WHEN COALESCE(TRIM(reject_keywords_json), '') IN ('', '[]') AND ? != '[]' THEN ? ELSE reject_keywords_json END,
          updated_at = ?
        WHERE job_key = ?;
      `.trim()).bind(
        nextRole,
        clearInvalidCompany ? 1 : 0,
        nextCompany,
        nextCompany,
        nextLocation,
        nextWorkMode,
        nextSeniority,
        JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
        JSON.stringify(Array.isArray(extracted?.skills) ? extracted.skills : []),
        JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.must_have_keywords) ? extracted.must_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.nice_to_have_keywords) ? extracted.nice_to_have_keywords : []),
        JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
        JSON.stringify(Array.isArray(extracted?.reject_keywords) ? extracted.reject_keywords : []),
        now,
        j.job_key
      ).run();

      updated += 1;
      results.push({
        job_key: j?.job_key,
        ok: true,
        role_title: nextRole || null,
        company: nextCompany || null,
      });
    } catch (e) {
      errors += 1;
      results.push({ job_key: j?.job_key, ok: false, reason: "error", error: String(e?.message || e) });
    }
  }

  return {
    picked: jobs.length,
    updated,
    skipped,
    errors,
    results,
  };
}

async function runCanonicalizeTitles_(env, opts = {}) {
  const limit = clampInt_(opts.limit || 200, 1, 1000);
  const onlyMissing = opts.onlyMissing !== false;
  const dryRun = opts.dryRun === true;

  const rows = await env.DB.prepare(`
    SELECT job_key, role_title, job_url, source_domain, status, system_status
    FROM jobs
    WHERE (
      ? = 0
      OR COALESCE(TRIM(role_title), '') = ''
      OR role_title LIKE '%=%'
      OR role_title LIKE '%;%'
      OR status = 'LINK_ONLY'
      OR COALESCE(TRIM(system_status), '') IN ('NEEDS_MANUAL_JD', 'AI_UNAVAILABLE')
    )
    ORDER BY updated_at DESC
    LIMIT ?;
  `.trim()).bind(onlyMissing ? 1 : 0, limit).all();

  const jobs = Array.isArray(rows?.results) ? rows.results : [];
  const now = Date.now();
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const samples = [];

  for (const row of jobs) {
    scanned += 1;
    const jobKey = String(row?.job_key || "").trim();
    const currentRoleRaw = String(row?.role_title || "").trim();
    const status = String(row?.status || "").trim().toUpperCase();
    if (!jobKey) {
      skipped += 1;
      continue;
    }

    const currentRoleClean = cleanRoleTitle_(currentRoleRaw);
    const currentRoleInvalid = Boolean(currentRoleRaw) && !currentRoleClean;
    const shouldProcess = !onlyMissing
      || !currentRoleRaw
      || currentRoleInvalid
      || currentRoleClean !== currentRoleRaw
      || isNoisyRoleTitle_(currentRoleRaw)
      || status === "LINK_ONLY";

    if (!shouldProcess) {
      skipped += 1;
      continue;
    }

    const roleFromUrl = cleanRoleTitle_(
      deriveRoleFromJobUrl_(String(row?.job_url || ""), String(row?.source_domain || ""))
    );
    const roleFromDisplay = cleanRoleTitle_(
      inferDisplayTitleFromUrl_(String(row?.job_url || ""), String(row?.source_domain || ""))
    );

    const nextRole = currentRoleClean || roleFromUrl || roleFromDisplay || "";
    try {
      if (!nextRole) {
        if (currentRoleInvalid) {
          if (!dryRun) {
            await env.DB.prepare(`
              UPDATE jobs
              SET role_title = NULL, updated_at = ?
              WHERE job_key = ?;
            `.trim()).bind(now, jobKey).run();
          }
          updated += 1;
          if (samples.length < 25) {
            samples.push({
              job_key: jobKey,
              from: currentRoleRaw || null,
              to: null,
            });
          }
        } else {
          skipped += 1;
        }
        continue;
      }

      if (nextRole === currentRoleRaw) {
        skipped += 1;
        continue;
      }

      if (!dryRun) {
        await env.DB.prepare(`
          UPDATE jobs
          SET role_title = ?, updated_at = ?
          WHERE job_key = ?;
        `.trim()).bind(nextRole, now, jobKey).run();
      }
      updated += 1;
      if (samples.length < 25) {
        samples.push({
          job_key: jobKey,
          from: currentRoleRaw || null,
          to: nextRole,
        });
      }
    } catch (e) {
      errors += 1;
      if (samples.length < 25) {
        samples.push({
          job_key: jobKey,
          error: String(e?.message || e),
        });
      }
    }
  }

  return {
    limit,
    only_missing: onlyMissing,
    dry_run: dryRun,
    scanned,
    updated,
    skipped,
    errors,
    samples,
  };
}

async function runCleanupTrackedUrls_(env, opts = {}) {
  const limit = clampInt_(opts.limit || 200, 1, 1000);
  const archiveInvalid = opts.archiveInvalid !== false;
  const archiveDuplicates = opts.archiveDuplicates !== false;
  const now = Date.now();

  const rows = await env.DB.prepare(`
    SELECT job_key, job_url, source_domain, status
    FROM jobs
    WHERE COALESCE(TRIM(job_url), '') != ''
    ORDER BY updated_at DESC
    LIMIT ?;
  `.trim()).bind(limit).all();

  const jobs = Array.isArray(rows?.results) ? rows.results : [];
  let scanned = 0;
  let canonicalized = 0;
  let archivedInvalid = 0;
  let archivedDuplicates = 0;
  let unchanged = 0;
  let errors = 0;
  const samples = [];

  for (const row of jobs) {
    scanned += 1;
    const jobKey = String(row?.job_key || "").trim();
    const rawUrl = String(row?.job_url || "").trim();
    const sourceDomainCurrent = normalizeSourceDomainName_(row?.source_domain);
    const statusCurrent = String(row?.status || "").trim().toUpperCase();

    if (!jobKey || !rawUrl) {
      unchanged += 1;
      continue;
    }

    let norm = null;
    try {
      norm = await normalizeJobUrl_(rawUrl);
    } catch {
      errors += 1;
      continue;
    }

    if (!norm || norm.ignored || !norm.job_url) {
      if (archiveInvalid && isOpenJobStatus_(statusCurrent)) {
        await env.DB.prepare(`
          UPDATE jobs
          SET
            status = 'ARCHIVED',
            next_status = 'ARCHIVED',
            system_status = 'INVALID_URL',
            archived_at = COALESCE(archived_at, ?),
            updated_at = ?
          WHERE job_key = ?;
        `.trim()).bind(now, now, jobKey).run();
        archivedInvalid += 1;
        if (samples.length < 25) samples.push({ job_key: jobKey, action: "archived_invalid" });
      } else {
        unchanged += 1;
      }
      continue;
    }

    const canonicalUrl = String(norm.job_url || "").trim();
    const canonicalSource = normalizeSourceDomainName_(norm.source_domain);
    const canonicalKey = String(norm.job_key || "").trim();

    if (archiveDuplicates && canonicalKey && canonicalKey !== jobKey) {
      const existingCanonical = await env.DB.prepare(`
        SELECT job_key
        FROM jobs
        WHERE job_key = ?
        LIMIT 1;
      `.trim()).bind(canonicalKey).first();

      if (existingCanonical && isOpenJobStatus_(statusCurrent)) {
        await env.DB.prepare(`
          UPDATE jobs
          SET
            status = 'ARCHIVED',
            next_status = 'ARCHIVED',
            system_status = 'CANONICAL_DUPLICATE',
            archived_at = COALESCE(archived_at, ?),
            updated_at = ?
          WHERE job_key = ?;
        `.trim()).bind(now, now, jobKey).run();
        archivedDuplicates += 1;
        if (samples.length < 25) {
          samples.push({ job_key: jobKey, action: "archived_duplicate", canonical_job_key: canonicalKey });
        }
        continue;
      }
    }

    if (canonicalUrl !== rawUrl || canonicalSource !== sourceDomainCurrent) {
      await env.DB.prepare(`
        UPDATE jobs
        SET
          job_url = ?,
          source_domain = ?,
          updated_at = ?
        WHERE job_key = ?;
      `.trim()).bind(canonicalUrl, canonicalSource, now, jobKey).run();
      canonicalized += 1;
      if (samples.length < 25) {
        samples.push({ job_key: jobKey, action: "canonicalized", source_domain: canonicalSource });
      }
    } else {
      unchanged += 1;
    }
  }

  return {
    scanned,
    canonicalized,
    archived_invalid: archivedInvalid,
    archived_duplicates: archivedDuplicates,
    unchanged,
    errors,
    samples,
  };
}

async function runGmailPoll_(env, opts = {}) {
  const query = typeof opts.query === "string" && opts.query.trim()
    ? opts.query.trim()
    : String(env.GMAIL_QUERY || "label:JobOps newer_than:14d");
  const maxPerRun = Number.isFinite(Number(opts.maxPerRun))
    ? clampInt_(Number(opts.maxPerRun), 1, 100)
    : clampInt_(env.GMAIL_MAX_PER_RUN || 25, 1, 100);
  const maxJobsPerEmail = Number.isFinite(Number(opts.maxJobsPerEmail))
    ? clampInt_(Number(opts.maxJobsPerEmail), 1, 50)
    : clampInt_(env.MAX_JOBS_PER_EMAIL || 3, 1, 50);
  const maxJobsPerPoll = Number.isFinite(Number(opts.maxJobsPerPoll))
    ? clampInt_(Number(opts.maxJobsPerPoll), 1, 500)
    : clampInt_(env.MAX_JOBS_PER_POLL || 10, 1, 500);
  const promoFilterEnabled = toBoolEnv_(env.GMAIL_PROMO_FILTER, true);
  const aiForMailFilter = getAi_(env);

  return pollGmailAndIngest_(env, {
    query,
    maxPerRun,
    maxJobsPerEmail,
    maxJobsPerPoll,
    normalizeFn: async (raw_url) => normalizeJobUrl_(String(raw_url || "")),
    classifyMessageFn: async (msg) => classifyPromotionalGmailMessage_(env, aiForMailFilter, msg, { enabled: promoFilterEnabled }),
    ingestFn: async ({ raw_urls, email_text, email_html, email_subject, email_from }) => {
      const processed = processDomainIngest_({
        raw_urls,
        email_text,
        email_html,
        email_subject,
        email_from,
      }, "GMAIL");
      const sourceHealth = checkIngestSourceHealth_(processed);
      await logIngestSourceHealthIfNeeded_(env, sourceHealth, {
        route: "/gmail/poll",
        source: "GMAIL",
      });
      return ingestRawUrls_(env, {
        rawUrls: Array.isArray(processed?.ingest_input?.raw_urls) ? processed.ingest_input.raw_urls : [],
        emailText: typeof processed?.ingest_input?.email_text === "string" ? processed.ingest_input.email_text : "",
        emailHtml: typeof processed?.ingest_input?.email_html === "string" ? processed.ingest_input.email_html : "",
        emailSubject: typeof processed?.ingest_input?.email_subject === "string" ? processed.ingest_input.email_subject : "",
        emailFrom: typeof processed?.ingest_input?.email_from === "string" ? processed.ingest_input.email_from : "",
        ingestChannel: "gmail",
      });
    },
  });
}

async function logIngestSourceHealthIfNeeded_(env, sourceHealth, meta = {}) {
  const health = (sourceHealth && typeof sourceHealth === "object") ? sourceHealth : null;
  if (!health) return;
  const status = String(health.status || "").trim().toLowerCase();
  if (!status || status === "healthy") return;
  await logEvent_(env, "INGEST_SOURCE_HEALTH", null, {
    source: String(health.source || meta.source || "").trim().toUpperCase() || "UNKNOWN",
    status,
    reasons: Array.isArray(health.reasons) ? health.reasons.slice(0, 8) : [],
    total: Number(health.total || 0),
    valid: Number(health.valid || 0),
    invalid: Number(health.invalid || 0),
    valid_ratio: Number.isFinite(Number(health.valid_ratio)) ? Number(health.valid_ratio) : 0,
    min_valid_ratio: Number.isFinite(Number(health.min_valid_ratio)) ? Number(health.min_valid_ratio) : 0.6,
    route: String(meta.route || "").trim() || null,
    ts: Date.now(),
  });
}

async function runRssPoll_(env, opts = {}) {
  const feeds = Array.isArray(opts.feeds) && opts.feeds.length
    ? opts.feeds.map((x) => String(x || "").trim()).filter(Boolean)
    : String(env.RSS_FEEDS || "")
      .split(/\r?\n|,/g)
      .map((x) => String(x || "").trim())
      .filter(Boolean);

  if (!feeds.length) {
    return {
      skipped: true,
      reason: "no_feeds_configured",
      feeds_total: 0,
      items_listed: 0,
      processed: 0,
      inserted_or_updated: 0,
      ignored: 0,
      link_only: 0,
    };
  }

  const maxPerRun = Number.isFinite(Number(opts.maxPerRun))
    ? clampInt_(Number(opts.maxPerRun), 1, 200)
    : clampInt_(env.RSS_MAX_PER_RUN || 25, 1, 200);

  return pollRssFeedsAndIngest_(env, {
    feeds,
    maxPerRun,
    allowKeywords: opts.allowKeywords,
    blockKeywords: opts.blockKeywords,
    normalizeFn: async (raw_url) => normalizeJobUrl_(String(raw_url || "")),
    ingestFn: async ({ raw_urls, email_text, email_html, email_subject, email_from }) => {
      const processed = processDomainIngest_({
        raw_urls,
        email_text,
        email_html,
        email_subject,
        email_from,
      }, "RSS");
      const sourceHealth = checkIngestSourceHealth_(processed);
      await logIngestSourceHealthIfNeeded_(env, sourceHealth, {
        route: "/rss/poll",
        source: "RSS",
      });
      return ingestRawUrls_(env, {
        rawUrls: Array.isArray(processed?.ingest_input?.raw_urls) ? processed.ingest_input.raw_urls : [],
        emailText: typeof processed?.ingest_input?.email_text === "string" ? processed.ingest_input.email_text : "",
        emailHtml: typeof processed?.ingest_input?.email_html === "string" ? processed.ingest_input.email_html : "",
        emailSubject: typeof processed?.ingest_input?.email_subject === "string" ? processed.ingest_input.email_subject : "",
        emailFrom: typeof processed?.ingest_input?.email_from === "string" ? processed.ingest_input.email_from : "",
        ingestChannel: "rss",
      });
    },
  });
}

async function runRssDiagnostics_(env, opts = {}) {
  const feeds = Array.isArray(opts.feeds) && opts.feeds.length
    ? opts.feeds.map((x) => String(x || "").trim()).filter(Boolean)
    : String(env.RSS_FEEDS || "")
      .split(/\r?\n|,/g)
      .map((x) => String(x || "").trim())
      .filter(Boolean);

  const maxPerRun = Number.isFinite(Number(opts.maxPerRun))
    ? clampInt_(Number(opts.maxPerRun), 1, 200)
    : clampInt_(env.RSS_MAX_PER_RUN || 25, 1, 200);
  const sampleLimit = Number.isFinite(Number(opts.sampleLimit))
    ? clampInt_(Number(opts.sampleLimit), 1, 20)
    : 5;

  return diagnoseRssFeedsAndIngest_(env, {
    feeds,
    maxPerRun,
    sampleLimit,
    allowKeywords: opts.allowKeywords,
    blockKeywords: opts.blockKeywords,
    normalizeFn: async (raw_url) => normalizeJobUrl_(String(raw_url || "")),
    ingestFn: async ({ raw_urls, email_text, email_html, email_subject, email_from }) => {
      const processed = processDomainIngest_({
        raw_urls,
        email_text,
        email_html,
        email_subject,
        email_from,
      }, "RSS");
      const sourceHealth = checkIngestSourceHealth_(processed);
      await logIngestSourceHealthIfNeeded_(env, sourceHealth, {
        route: "/rss/diagnostics",
        source: "RSS",
      });
      return ingestRawUrls_(env, {
        rawUrls: Array.isArray(processed?.ingest_input?.raw_urls) ? processed.ingest_input.raw_urls : [],
        emailText: typeof processed?.ingest_input?.email_text === "string" ? processed.ingest_input.email_text : "",
        emailHtml: typeof processed?.ingest_input?.email_html === "string" ? processed.ingest_input.email_html : "",
        emailSubject: typeof processed?.ingest_input?.email_subject === "string" ? processed.ingest_input.email_subject : "",
        emailFrom: typeof processed?.ingest_input?.email_from === "string" ? processed.ingest_input.email_from : "",
        ingestChannel: "rss",
      });
    },
  });
}

function toBoolEnv_(v, defaultValue = false) {
  if (v === undefined || v === null || String(v).trim() === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

function toBool_(v, defaultValue = false) {
  if (v === undefined || v === null || String(v).trim() === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

async function classifyPromotionalGmailMessage_(env, ai, msg, opts = {}) {
  const enabled = opts.enabled !== false;
  if (!enabled) return { reject: false, by: "none", reason: "disabled" };

  const subject = String(msg?.subject || "").trim();
  const fromEmail = String(msg?.from_email || "").trim();
  const combinedText = String(msg?.combined_text || "");
  const urlsJobDomainsTotal = clampInt_(msg?.urls_job_domains_total || 0, 0, 9999);
  const sample = `${subject}\n${combinedText}`.slice(0, 4000).toLowerCase();

  const strongJobSignal =
    urlsJobDomainsTotal > 0 ||
    /linkedin\.com\/jobs\/view\/\d+/i.test(sample) ||
    /iimjobs\.com\/j\/.+-\d+/i.test(sample) ||
    /naukri\.com\/job-listings-.+-\d+/i.test(sample);

  const promoHints = [
    "premium",
    "upgrade",
    "new feature",
    "introducing",
    "newsletter",
    "product update",
    "sponsored",
    "advertisement",
    "ad:",
    "free trial",
    "inmail",
    "people you may know",
    "connect with",
    "recommendation digest",
    "learn more",
  ];
  const hintHits = promoHints.filter((h) => sample.includes(h)).length;
  const heuristicReject = !strongJobSignal && hintHits >= 2;
  if (heuristicReject) {
    return { reject: true, by: "heuristic", reason: "promotional_heuristic" };
  }

  if (!ai) return { reject: false, by: "none", reason: "no_ai_binding" };

  const aiPrompt = `
Classify this Gmail message for JobOps ingestion.
Return STRICT JSON only:
{"category":"JOB_ALERT"|"PROMOTION","confidence":0-1,"reason":"short string"}

Rules:
- PROMOTION if it's premium upsell, product/new-feature announcement, ad, newsletter, or non-job marketing.
- JOB_ALERT only if it is primarily about a specific job opportunity/alert.
- If unsure, choose JOB_ALERT.

Subject: ${jsonString_(subject)}
From: ${jsonString_(fromEmail)}
Text sample:
${jsonString_(sample)}
`.trim();

  try {
    const aiResult = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: aiPrompt }],
      temperature: 0,
    });
    const raw = pickModelText_(aiResult);
    const parsed = safeJsonParse_(raw);
    const category = String(parsed?.category || "").trim().toUpperCase();
    const confidence = Number(parsed?.confidence);
    const reason = String(parsed?.reason || "").slice(0, 120);
    if (category === "PROMOTION" && (!Number.isFinite(confidence) || confidence >= 0.6)) {
      return { reject: true, by: "ai", reason: reason || "promotional_ai" };
    }
  } catch {
    return { reject: false, by: "none", reason: "ai_error" };
  }

  return { reject: false, by: "none", reason: "job_alert_or_uncertain" };
}

async function probeReactiveResume_(env) {
  const rrBase = String(env?.RR_BASE_URL || "").trim().replace(/\/+$/, "");
  const rrKey = String(env?.RR_KEY || "").trim();
  const timeoutMs = clampInt_(env?.RR_TIMEOUT_MS || 6000, 1000, 20000);
  const configured = Boolean(rrBase) && Boolean(rrKey);
  const out = {
    configured,
    rr_base_url: rrBase || null,
    reachable: false,
    authenticated: null,
    status: "missing_config",
    http_status: null,
    attempted_paths: [],
    matched_path: null,
    checked_at: Date.now(),
    note: "",
  };

  if (!rrBase || !rrKey) {
    out.note = !rrBase && !rrKey
      ? "Set RR_BASE_URL (var) and RR_KEY (secret)."
      : (!rrBase ? "Set RR_BASE_URL (var)." : "Set RR_KEY (secret).");
    return out;
  }

  if (!/^https?:\/\//i.test(rrBase)) {
    out.note = "RR_BASE_URL must start with http:// or https://";
    return out;
  }

  const customPath = String(env?.RR_HEALTH_PATH || "").trim();
  const candidatePaths = unique_([customPath, "/api/health", "/health", "/api"])
    .map((p) => normalizeHealthPath_(p))
    .filter(Boolean);

  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Authorization": `Bearer ${rrKey}`,
    "x-api-key": rrKey,
  };

  for (const relPath of candidatePaths) {
    const url = `${rrBase}${relPath}`;
    out.attempted_paths.push(relPath);
    try {
      const res = await fetchWithTimeout_(url, { method: "GET", headers }, timeoutMs);
      const status = Number(res.status || 0);
      out.http_status = status;
      out.matched_path = relPath;
      out.reachable = true;

      if (res.ok) {
        out.authenticated = true;
        out.status = "ready";
        out.note = "Reactive Resume reachable.";
        return out;
      }

      if (status === 401 || status === 403) {
        out.authenticated = false;
        out.status = "unauthorized";
        out.note = "RR_KEY rejected by Reactive Resume.";
        return out;
      }

      if (status === 404) {
        // Continue trying fallback health paths.
        continue;
      }

      out.authenticated = null;
      out.status = "http_error";
      out.note = `Reactive Resume returned HTTP ${status}.`;
      return out;
    } catch (e) {
      if (!out.reachable) out.reachable = false;
      out.authenticated = null;
      out.status = "unreachable";
      out.note = String(e?.name || e?.message || e || "fetch_failed").slice(0, 120);
    }
  }

  if (out.reachable && out.http_status === 404) {
    out.status = "endpoint_not_found";
    out.note = "Reactive Resume reachable but no health path matched. Set RR_HEALTH_PATH.";
    return out;
  }

  if (!out.reachable) {
    out.note = out.note || "Could not reach Reactive Resume from Worker.";
    return out;
  }

  return out;
}

function getReactiveResumeBaseUrl_(env) {
  const rrBase = String(env?.RR_BASE_URL || "").trim().replace(/\/+$/, "");
  return rrBase || null;
}

function evaluatePdfReadiness_(env, { job, packJson, atsJson, rrExportJson } = {}) {
  const minSummaryChars = clampInt_(env?.PDF_MIN_SUMMARY_CHARS || 80, 20, 1000);
  const minBullets = clampInt_(env?.PDF_MIN_BULLETS || 3, 1, 12);
  const minAtsScore = clampInt_(env?.PDF_MIN_ATS_SCORE || 60, 0, 100);
  const minMustCoveragePct = clampInt_(env?.PDF_MIN_MUST_COVERAGE_PCT || 50, 0, 100);
  const jobSafe = job && typeof job === "object" ? job : {};
  const packSafe = packJson && typeof packJson === "object" ? packJson : {};
  const atsSafe = atsJson && typeof atsJson === "object" ? atsJson : {};
  const rrSafe = rrExportJson && typeof rrExportJson === "object" ? rrExportJson : {};
  const fetchDebug = safeJsonParse_(jobSafe.fetch_debug_json) || {};

  const roleTitle = String(packSafe?.extracted?.role_title || jobSafe.role_title || "").trim();
  const company = String(packSafe?.extracted?.company || jobSafe.company || "").trim();
  const jdTextLen = String(jobSafe.jd_text_clean || "").trim().length;
  const jdConfidence = String(fetchDebug.jd_confidence || "").trim().toLowerCase();
  const summary = String(packSafe?.tailoring?.summary || rrSafe?.basics?.summary || "").trim();
  const bullets = Array.isArray(packSafe?.tailoring?.bullets) ? packSafe.tailoring.bullets.filter((x) => String(x || "").trim()) : [];
  const atsScore = numOrNull_(atsSafe?.score);
  const coverage = atsSafe?.coverage && typeof atsSafe.coverage === "object" ? atsSafe.coverage : {};
  const mustTotal = Math.max(0, Number(coverage.must_total || 0));
  const mustHit = Math.max(0, Number(coverage.must_hit || 0));
  const mustCoveragePct = mustTotal > 0 ? Math.round((mustHit / mustTotal) * 100) : 100;
  const rrImportReady = Boolean(rrSafe?.metadata?.import_ready);
  const onePageMode = normalizeOnePageMode_(packSafe?.controls?.one_page_mode) || "soft";
  const hardGateApplied = onePageMode === "hard";
  const onePageEstimate = {
    summary_chars: summary.length,
    bullets_count: bullets.length,
    experience_items: Array.isArray(rrSafe?.sections?.experience) ? rrSafe.sections.experience.length : 0,
    skills_items: Array.isArray(rrSafe?.sections?.skills) ? rrSafe.sections.skills.length : 0,
    estimated_density: estimateOnePageDensity_({
      summaryChars: summary.length,
      bulletsCount: bullets.length,
      experienceItems: Array.isArray(rrSafe?.sections?.experience) ? rrSafe.sections.experience.length : 0,
      skillsItems: Array.isArray(rrSafe?.sections?.skills) ? rrSafe.sections.skills.length : 0,
    }),
  };

  const checks = [
    {
      id: "role_title",
      label: "Role title present",
      ok: roleTitle.length >= 3,
      detail: roleTitle ? `role: ${roleTitle}` : "Missing role title",
      enforced: hardGateApplied,
    },
    {
      id: "company",
      label: "Company present",
      ok: company.length >= 2,
      detail: company ? `company: ${company}` : "Missing company",
      enforced: hardGateApplied,
    },
    {
      id: "jd_quality",
      label: "JD quality usable",
      ok: jdTextLen >= 200 || jdConfidence === "medium" || jdConfidence === "high",
      detail: `jd_len=${jdTextLen}, jd_confidence=${jdConfidence || "-"}`,
      enforced: hardGateApplied,
    },
    {
      id: "summary_length",
      label: "Tailored summary length",
      ok: summary.length >= minSummaryChars,
      detail: `summary_chars=${summary.length}/${minSummaryChars}`,
      enforced: hardGateApplied,
    },
    {
      id: "bullets_count",
      label: "Tailored bullets count",
      ok: bullets.length >= minBullets,
      detail: `bullets=${bullets.length}/${minBullets}`,
      enforced: hardGateApplied,
    },
    {
      id: "ats_score",
      label: "ATS score threshold",
      ok: atsScore !== null && atsScore >= minAtsScore,
      detail: `ats_score=${atsScore ?? "-"} / ${minAtsScore}`,
      enforced: hardGateApplied,
    },
    {
      id: "must_coverage",
      label: "Must-keyword coverage",
      ok: mustCoveragePct >= minMustCoveragePct,
      detail: `must_coverage=${mustCoveragePct}% (${mustHit}/${mustTotal})`,
      enforced: hardGateApplied,
    },
    {
      id: "rr_import_ready",
      label: "RR import contract ready",
      ok: rrImportReady,
      detail: rrImportReady ? "ready" : "not import-ready",
      enforced: true,
    },
  ];

  const failedChecks = checks.filter((c) => c.enforced && !c.ok);
  const warningChecks = checks.filter((c) => !c.enforced && !c.ok);
  return {
    gate_version: "pdf_readiness_v2",
    ready: failedChecks.length === 0,
    failed_count: failedChecks.length,
    checks,
    failed_checks: failedChecks,
    warning_checks: warningChecks,
    thresholds: {
      min_summary_chars: minSummaryChars,
      min_bullets: minBullets,
      min_ats_score: minAtsScore,
      min_must_coverage_pct: minMustCoveragePct,
    },
    one_page_mode: onePageMode,
    one_page_estimate: onePageEstimate,
    hard_gate_applied: hardGateApplied,
  };
}

function estimateOnePageDensity_({ summaryChars = 0, bulletsCount = 0, experienceItems = 0, skillsItems = 0 } = {}) {
  const summary = clampInt_(summaryChars || 0, 0, 5000);
  const bullets = clampInt_(bulletsCount || 0, 0, 100);
  const exp = clampInt_(experienceItems || 0, 0, 50);
  const skills = clampInt_(skillsItems || 0, 0, 200);

  const high = summary > 280 || bullets > 4 || exp > 3 || skills > 12;
  if (high) return "high";
  const medium = summary > 220 || bullets > 3 || exp > 2 || skills > 8;
  if (medium) return "medium";
  return "low";
}

async function exportReactiveResumePdf_(env, { resumeId } = {}) {
  const rrBase = getReactiveResumeBaseUrl_(env);
  const rrKey = String(env?.RR_KEY || "").trim();
  const timeoutMs = clampInt_(env?.RR_PDF_TIMEOUT_MS || env?.RR_TIMEOUT_MS || 12000, 3000, 60000);
  const rid = String(resumeId || "").trim();
  if (!rrBase || !rrKey) {
    return { ok: false, error: "Reactive Resume is not configured (missing RR_BASE_URL or RR_KEY)." };
  }
  if (!rid) {
    return { ok: false, error: "Missing resume id for PDF export." };
  }

  const pdfPath = normalizeHealthPath_(`/api/openapi/resumes/${encodeURIComponent(rid)}/pdf`);
  try {
    const res = await fetchWithTimeout_(`${rrBase}${pdfPath}`, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "x-api-key": rrKey,
      },
    }, timeoutMs);

    const rawText = await res.text();
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch { parsed = null; }
    if (!res.ok) {
      return {
        ok: false,
        http_status: res.status,
        error: parsed?.message || parsed?.error || `Reactive Resume PDF export failed (HTTP ${res.status})`,
      };
    }

    const pdfUrl = String(
      parsed?.url ||
      parsed?.pdf_url ||
      parsed?.data?.url ||
      parsed?.data?.pdf_url ||
      ""
    ).trim();
    if (!pdfUrl) {
      return { ok: false, http_status: res.status, error: "Reactive Resume PDF URL missing in response." };
    }

    return {
      ok: true,
      http_status: res.status,
      resume_id: rid,
      pdf_url: pdfUrl,
      export_path: pdfPath,
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e || "Reactive Resume PDF export failed").slice(0, 200),
    };
  }
}

async function pushReactiveResume_(env, { rrExport, titleHint = "", resumeId = "" } = {}) {
  const existingResumeId = String(resumeId || "").trim();
  const rrBase = getReactiveResumeBaseUrl_(env);
  const rrKey = String(env?.RR_KEY || "").trim();
  const timeoutMs = clampInt_(env?.RR_TIMEOUT_MS || 6000, 1000, 20000);

  if (!rrBase || !rrKey) {
    return { ok: false, error: "Reactive Resume is not configured (missing RR_BASE_URL or RR_KEY)." };
  }

  if (existingResumeId) {
    const patched = await patchReactiveResumeDataRequest_(rrBase, rrKey, existingResumeId, rrExport, timeoutMs);
    if (patched.ok) return { ...patched, mode: "updated_existing" };
    if (Number(patched.http_status) !== 404) return patched;
  }

  const imported = await pushReactiveResumeImport_(env, { rrExport, titleHint });
  if (imported.ok) {
    return {
      ...imported,
      mode: existingResumeId ? "relinked_import" : "imported_new",
    };
  }
  return imported;
}

async function pushReactiveResumeImport_(env, { rrExport, titleHint = "" } = {}) {
  const rrBase = getReactiveResumeBaseUrl_(env);
  const rrKey = String(env?.RR_KEY || "").trim();
  const importPath = normalizeHealthPath_(String(env?.RR_IMPORT_PATH || "/api/openapi/resumes/import").trim() || "/api/openapi/resumes/import");
  const timeoutMs = clampInt_(env?.RR_TIMEOUT_MS || 6000, 1000, 20000);
  if (!rrBase || !rrKey) {
    return { ok: false, error: "Reactive Resume is not configured (missing RR_BASE_URL or RR_KEY)." };
  }

  const payload = {
    data: rrExport,
  };
  const safeTitle = String(titleHint || "").trim();
  if (safeTitle) payload.name = safeTitle.slice(0, 120);

  const first = await postReactiveResumeImportRequest_(rrBase, importPath, rrKey, payload, timeoutMs);
  if (first.ok) {
    return { ...first, adapter: "jobops_rr_export" };
  }

  // Fallback adapter: convert to Reactive Resume native data model if import rejects custom schema.
  if (Number(first.http_status) === 400) {
    const fallbackPayload = {
      data: toReactiveResumeDataModelFromRr_(rrExport),
    };
    if (safeTitle) fallbackPayload.name = safeTitle.slice(0, 120);
    const second = await postReactiveResumeImportRequest_(rrBase, importPath, rrKey, fallbackPayload, timeoutMs);
    if (second.ok) {
      return { ...second, adapter: "rxresu_data_model_fallback" };
    }
    return second;
  }

  return first;
}

async function patchReactiveResumeDataRequest_(rrBase, rrKey, resumeId, rrExport, timeoutMs) {
  const updatePath = normalizeHealthPath_(`/api/openapi/resumes/${encodeURIComponent(String(resumeId || "").trim())}`);
  const dataModel = toReactiveResumeDataModelFromRr_(rrExport);
  const patchOps = Object.entries(dataModel || {})
    .map(([k, v]) => ({ op: "replace", path: `/${k}`, value: v }));
  const attempts = [
    { method: "PATCH", body: { operations: patchOps } }, // JSON patch against resume.data
    { method: "PUT", body: { data: dataModel } }, // full replace shape
    { method: "PATCH", body: { data: dataModel } }, // partial nested shape
    { method: "PATCH", body: dataModel }, // partial direct shape
  ];

  let lastFail = null;
  for (const a of attempts) {
    const one = await tryReactiveResumeUpdateAttempt_(rrBase, rrKey, updatePath, resumeId, a.method, a.body, timeoutMs);
    if (one.ok) return one;
    lastFail = one;
    if (one.http_status === 401 || one.http_status === 403 || one.http_status === 404) {
      return one;
    }
  }

  return lastFail || {
    ok: false,
    import_path: updatePath,
    error: "Reactive Resume update failed",
  };
}

async function tryReactiveResumeUpdateAttempt_(rrBase, rrKey, updatePath, resumeId, method, bodyObj, timeoutMs) {
  try {
    const res = await fetchWithTimeout_(`${rrBase}${updatePath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "x-api-key": rrKey,
      },
      body: JSON.stringify(bodyObj || {}),
    }, timeoutMs);

    const rawText = await res.text();
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch { parsed = null; }

    if (!res.ok) {
      return {
        ok: false,
        http_status: res.status,
        import_path: updatePath,
        error: parsed?.message || parsed?.error || `Reactive Resume update failed (HTTP ${res.status})`,
      };
    }

    return {
      ok: true,
      http_status: res.status,
      import_path: updatePath,
      resume_id: String(parsed?.id || parsed?.resumeId || parsed?.resume_id || resumeId || "").trim() || null,
      adapter: "jobops_rr_export",
    };
  } catch (e) {
    return {
      ok: false,
      import_path: updatePath,
      error: String(e?.message || e || "Reactive Resume update failed").slice(0, 200),
    };
  }
}

async function postReactiveResumeImportRequest_(rrBase, importPath, rrKey, payload, timeoutMs) {
  try {
    const res = await fetchWithTimeout_(`${rrBase}${importPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "x-api-key": rrKey,
      },
      body: JSON.stringify(payload || {}),
    }, timeoutMs);

    const rawText = await res.text();
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch { parsed = null; }

    if (!res.ok) {
      return {
        ok: false,
        http_status: res.status,
        import_path: importPath,
        error: parsed?.message || parsed?.error || `Reactive Resume import failed (HTTP ${res.status})`,
      };
    }

    const resumeId =
      String(parsed?.id || parsed?.resumeId || parsed?.resume_id || parsed?.data?.id || parsed?.data?.resumeId || "").trim() ||
      (typeof parsed === "string" ? parsed.trim() : "");

    return {
      ok: true,
      http_status: res.status,
      import_path: importPath,
      resume_id: resumeId || null,
    };
  } catch (e) {
    return {
      ok: false,
      import_path: importPath,
      error: String(e?.message || e || "Reactive Resume request failed").slice(0, 200),
    };
  }
}

function toReactiveResumeDataModelFromRr_(rr) {
  const basicsIn = rr && typeof rr === "object" ? (rr.basics || {}) : {};
  const sections = rr && typeof rr === "object" ? (rr.sections || {}) : {};
  const jobContext = rr && typeof rr === "object" ? (rr.job_context || {}) : {};
  const highlightsIn = Array.isArray(sections.highlights) ? sections.highlights : [];
  const skillsIn = Array.isArray(sections.skills) ? sections.skills : [];
  const experienceIn = Array.isArray(sections.experience) ? sections.experience : [];
  const roleTitle = String(jobContext?.role_title || "").trim();
  const companyName = String(jobContext?.company || "").trim();
  const jobUrl = String(jobContext?.job_url || "").trim();

  const fallbackSummary = highlightsIn
    .map((h) => String(h?.text || h || "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  const summaryText = String(basicsIn.summary || fallbackSummary || "").trim();
  const bulletTexts = highlightsIn
    .map((h) => String(h?.text || h || "").trim())
    .filter(Boolean)
    .slice(0, 10);
  const bulletsHtml = bulletTexts.length
    ? `<ul>${bulletTexts.map((t) => `<li>${escapeHtmlLite_(t)}</li>`).join("")}</ul>`
    : "";
  const summaryHtml = summaryText ? `<p>${escapeHtmlLite_(summaryText)}</p>` : "";
  const experienceItems = [];

  // Carry over any profile experience summaries if present.
  for (const e of experienceIn.slice(0, 5)) {
    const company = String(e?.company || e?.organization || e?.name || companyName || "Experience").trim();
    const position = String(e?.position || e?.title || roleTitle || "Role").trim();
    const location = String(e?.location || "").trim();
    const period = String(e?.period || e?.date || "Recent").trim();
    const websiteUrl = String(e?.website?.url || e?.url || jobUrl || "").trim();
    const websiteLabel = String(e?.website?.label || "").trim();
    const descRaw = String(e?.description || e?.summary || "").trim();
    const descHtml = descRaw
      ? `<p>${escapeHtmlLite_(descRaw)}</p>${bulletsHtml}`
      : (bulletsHtml || summaryHtml || "<p></p>");
    experienceItems.push({
      id: crypto.randomUUID(),
      hidden: false,
      company: company || "Experience",
      position: position || "Role",
      location,
      period,
      website: {
        url: websiteUrl,
        label: websiteLabel || (websiteUrl ? "Details" : ""),
      },
      description: descHtml,
    });
  }

  // Ensure at least one visible work item exists for PDF output.
  if (!experienceItems.length) {
    experienceItems.push({
      id: crypto.randomUUID(),
      hidden: false,
      company: companyName || "Target company",
      position: roleTitle || "Target role",
      location: "",
      period: "Current",
      website: {
        url: jobUrl,
        label: jobUrl ? "Job posting" : "",
      },
      description: bulletsHtml || summaryHtml || "<p>Tailored for this role.</p>",
    });
  }

  const projectItems = bulletTexts.slice(0, 5).map((b) => ({
    id: crypto.randomUUID(),
    hidden: false,
    name: "Targeted Achievement",
    period: "Current",
    website: { url: jobUrl, label: jobUrl ? "Job posting" : "" },
    description: `<p>${escapeHtmlLite_(b)}</p>`,
  }));

  const skillKeywords = unique_([
    ...skillsIn.map((s) => String(s || "").trim()),
    ...bulletTexts.flatMap((t) => t.split(/[,|/]+/g).map((x) => String(x || "").trim())),
  ])
    .filter(Boolean)
    .slice(0, 16);
  const skillItems = skillKeywords.slice(0, 8).map((name) => ({
    id: crypto.randomUUID(),
    hidden: false,
    icon: "",
    name,
    proficiency: "Applied",
    level: 3,
    keywords: [],
  }));

  const emptySection = (title = "") => ({ title, columns: 1, hidden: false, items: [] });

  return {
    picture: {
      hidden: false,
      url: "",
      size: 80,
      rotation: 0,
      aspectRatio: 1,
      borderRadius: 0,
      borderColor: "rgba(0, 0, 0, 0.5)",
      borderWidth: 0,
      shadowColor: "rgba(0, 0, 0, 0.5)",
      shadowWidth: 0,
    },
    basics: {
      name: String(basicsIn.name || "").trim(),
      headline: "",
      email: String(basicsIn.email || "").trim(),
      phone: String(basicsIn.phone || "").trim(),
      location: String(basicsIn.location || "").trim(),
      website: {
        url: "",
        label: "",
      },
      customFields: [],
    },
    summary: {
      title: "",
      columns: 1,
      hidden: false,
      content: summaryText,
    },
    sections: {
      profiles: emptySection(""),
      experience: { title: "Experience", columns: 1, hidden: false, items: experienceItems },
      education: emptySection(""),
      projects: { title: "Projects", columns: 1, hidden: projectItems.length === 0, items: projectItems },
      skills: { title: "Skills", columns: 1, hidden: skillItems.length === 0, items: skillItems },
      languages: emptySection(""),
      interests: emptySection(""),
      awards: emptySection(""),
      certifications: emptySection(""),
      publications: emptySection(""),
      volunteer: emptySection(""),
      references: emptySection(""),
    },
    customSections: [],
    metadata: {
      template: "onyx",
      layout: {
        sidebarWidth: 35,
        pages: [
          {
            fullWidth: false,
            main: ["profiles", "summary", "education", "experience", "projects", "volunteer", "references"],
            sidebar: ["skills", "certifications", "awards", "languages", "interests", "publications"],
          },
        ],
      },
      css: {
        enabled: false,
        value: "",
      },
      page: {
        gapX: 4,
        gapY: 6,
        marginX: 14,
        marginY: 12,
        format: "a4",
        locale: "en-US",
        hideIcons: false,
      },
      design: {
        level: {
          icon: "star",
          type: "circle",
        },
        colors: {
          primary: "rgba(220, 38, 38, 1)",
          text: "rgba(0, 0, 0, 1)",
          background: "rgba(255, 255, 255, 1)",
        },
      },
      typography: {
        body: {
          fontFamily: "IBM Plex Serif",
          fontWeights: ["400", "500"],
          fontSize: 10,
          lineHeight: 1.5,
        },
        heading: {
          fontFamily: "IBM Plex Serif",
          fontWeights: ["600"],
          fontSize: 14,
          lineHeight: 1.5,
        },
      },
      notes: "",
    },
  };
}

function escapeHtmlLite_(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeHealthPath_(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return "";
  return s.startsWith("/") ? s : `/${s}`;
}

async function fetchWithTimeout_(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeoutUsingFetcher_(fetcher, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetcher(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleepMs_(ms) {
  const wait = clampInt_(ms, 0, 60000);
  if (!wait) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function routeModeFor_(path) {
  if (path === "/health" || path === "/") return "public";
  if (path === "/ingest/whatsapp/vonage") return "public";
  if (path === "/dashboard/triage") return "ui";
  if (path === "/jobs/evidence/rebuild-archived") return "api";
  if (path === "/jobs/evidence/gap-report") return "api";
  if (path === "/admin/scoring-runs/report") return "api";

  if (
    path === "/gmail/auth" ||
    path === "/jobs" ||
    path === "/metrics" ||
    path.startsWith("/jobs/") ||
    path === "/ingest" ||
    path === "/targets" ||
    path.startsWith("/targets/") ||
    path.startsWith("/resume/")
  ) return "ui";

  if (path === "/score-pending") return "either";

  if (
    path === "/normalize-job" ||
    path === "/resolve-jd" ||
    path === "/extract-jd" ||
    path === "/score-jd"
  ) return "api";

  return "public";
}

function requireAuth_(request, env, routeMode) {
  if (routeMode === "public") return null;
  const uiOk = isUiAuth_(request, env);
  const apiOk = isApiAuth_(request, env);

  if (routeMode === "ui" && !uiOk) return json_({ ok: false, error: "Unauthorized" }, env, 401);
  if (routeMode === "api" && !apiOk) return json_({ ok: false, error: "Unauthorized" }, env, 401);
  if (routeMode === "either" && !uiOk && !apiOk) return json_({ ok: false, error: "Unauthorized" }, env, 401);

  return null;
}

function isUiAuth_(request, env) {
  const uiKey = request.headers.get("x-ui-key");
  return Boolean(env.UI_KEY) && uiKey === env.UI_KEY;
}

function isApiAuth_(request, env) {
  const apiKey = request.headers.get("x-api-key");
  return Boolean(env.API_KEY) && apiKey === env.API_KEY;
}

function isCronRequest_(request) {
  return Boolean(String(request.headers.get("cf-cron") || "").trim());
}

function looksLikeGoogleClientSecret_(s) {
  const v = String(s || "").trim();
  return /^GOCSPX[-_A-Za-z0-9]+$/.test(v);
}

function getCookie_(request, name) {
  const cookies = String(request.headers.get("cookie") || "");
  const parts = cookies.split(";").map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(idx + 1));
  }
  return "";
}

function corsHeaders_(env) {
  const raw = env && env.ALLOW_ORIGIN ? String(env.ALLOW_ORIGIN).trim() : "*";
  const candidates = raw === "*"
    ? ["*"]
    : raw
      .split(/[\r\n,]+/g)
      .map((x) => String(x || "").trim())
      .filter((x) => /^https?:\/\//i.test(x));
  const allowOrigin = candidates.length ? candidates[0] : "*";
  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key,x-ui-key",
  };
  if (allowOrigin !== "*") headers["Vary"] = "Origin";
  return headers;
}

function json_(obj, env, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders_(env) },
  });
}

function pickModelText_(result) {
  return (
    result?.response ||
    result?.output ||
    result?.result ||
    result?.choices?.[0]?.message?.content ||
    ""
  );
}

function pickModelUsage_(result) {
  const usage = result?.usage || result?.meta?.usage || {};
  const inputTokens = numOr_(usage.input_tokens ?? usage.prompt_tokens, 0);
  const outputTokens = numOr_(usage.output_tokens ?? usage.completion_tokens, 0);
  const totalTokens = numOr_(usage.total_tokens, inputTokens + outputTokens);
  return {
    input_tokens: clampInt_(inputTokens, 0, 5_000_000),
    output_tokens: clampInt_(outputTokens, 0, 5_000_000),
    total_tokens: clampInt_(totalTokens, 0, 5_000_000),
  };
}

function safeJsonParse_(s) {
  try {
    const str = String(s || "").trim();
    const first = str.indexOf("{");
    const last = str.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    return JSON.parse(str.slice(first, last + 1));
  } catch {
    return null;
  }
}

function safeJsonParseAny_(s) {
  try {
    const str = String(s || "").trim();
    if (!str) return null;
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function timingSafeEqualText_(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) {
    diff |= (x.charCodeAt(i) ^ y.charCodeAt(i));
  }
  return diff === 0;
}

function decodeBase64UrlToBytes_(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeBase64UrlToText_(input) {
  const bytes = decodeBase64UrlToBytes_(input);
  if (!bytes) return "";
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function bytesToHex_(bytes) {
  const arr = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || []);
  let out = "";
  for (let i = 0; i < arr.length; i += 1) {
    out += arr[i].toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToBase64_(bytes) {
  const arr = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || []);
  let bin = "";
  for (let i = 0; i < arr.length; i += 1) {
    bin += String.fromCharCode(arr[i]);
  }
  try {
    return btoa(bin);
  } catch {
    return "";
  }
}

function getBearerToken_(request) {
  const auth = String(request?.headers?.get("authorization") || "").trim();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return String(m?.[1] || "").trim();
}

function syntheticWhatsappMediaJobUrl_(messageId) {
  const id = String(messageId || "").trim().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120) || "msg";
  return `https://whatsapp.vonage.local/media/${id}`;
}

function extractVonageMediaRefFromRawBody_(rawBody) {
  const s = String(rawBody || "").trim();
  if (!s) return { url: "", id: "" };
  const unescaped = s.replace(/\\\//g, "/");
  const urlMatch = unescaped.match(/https?:\/\/[^\s"'<>]+\/v3\/media\/([a-zA-Z0-9._-]+)/i);
  const mediaIdFromUrl = String(urlMatch?.[1] || "").trim();

  const mediaIdDirect = (
    unescaped.match(/"media[_-]?id"\s*:\s*"([a-zA-Z0-9._-]+)"/i)?.[1] ||
    unescaped.match(/"mediaId"\s*:\s*"([a-zA-Z0-9._-]+)"/i)?.[1] ||
    ""
  );

  const mediaUrl = String(urlMatch?.[0] || "").trim().slice(0, 4000);
  const mediaId = String(mediaIdDirect || mediaIdFromUrl || "").trim().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 240);
  return { url: mediaUrl, id: mediaId };
}

function vonageMediaUrlFromId_(env, mediaId) {
  const id = String(mediaId || "").trim();
  if (!id) return "";
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 240);
  if (!safeId) return "";
  const baseRaw = String(env?.VONAGE_MEDIA_BASE_URL || env?.VONAGE_API_BASE_URL || "").trim();
  let base = baseRaw || "https://api-eu.nexmo.com";
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  try {
    const u = new URL(base);
    u.pathname = `/v3/media/${encodeURIComponent(safeId)}`;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return `https://api-eu.nexmo.com/v3/media/${encodeURIComponent(safeId)}`;
  }
}

function extractFirstHttpUrlFromText_(text = "") {
  const s = String(text || "").trim();
  if (!s) return "";
  const m = s.match(/https?:\/\/[^\s<>"')\]]+/i);
  return String(m?.[0] || "").trim().slice(0, 3000);
}

function normalizeExtractorUrls_(input) {
  const out = [];
  const pushUrl = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      out.push(u.toString());
    } catch {
      // ignore invalid URL
    }
  };

  if (Array.isArray(input)) {
    for (const x of input) pushUrl(x);
  } else if (input && typeof input === "object") {
    pushUrl(input.url);
    pushUrl(input.job_url);
    pushUrl(input.link);
  } else {
    pushUrl(input);
  }
  return unique_(out).slice(0, 10);
}

function decideWhatsAppMediaExtractIngest_(text, urls, mediaType = "", mediaMimeType = "") {
  const cleanText = String(text || "").trim();
  const urlCount = Array.isArray(urls) ? urls.filter((u) => String(u || "").trim()).length : 0;
  if (urlCount > 0) {
    return { accept: true, reason: "has_url", keyword_hits: 0 };
  }
  if (!cleanText) {
    return { accept: false, reason: "empty_text", keyword_hits: 0 };
  }

  const low = cleanText.toLowerCase();
  const signalPatterns = [
    /\b(job|position|opening|vacancy|role)\b/i,
    /\b(responsibilit(?:y|ies)|what you will do|day-to-day)\b/i,
    /\b(requirements?|qualifications?|must[-\s]?have|preferred)\b/i,
    /\b(skills?|experience|years?)\b/i,
    /\b(company|team|department|organization)\b/i,
    /\b(apply|application|candidate|hiring)\b/i,
    /\b(full[-\s]?time|part[-\s]?time|contract|onsite|remote|hybrid)\b/i,
  ];
  let keywordHits = 0;
  for (const re of signalPatterns) {
    if (re.test(low)) keywordHits += 1;
  }

  const tLen = cleanText.length;
  const mediaKind = String(mediaType || "").trim().toLowerCase();
  const mime = String(mediaMimeType || "").trim().toLowerCase();
  const isImage = mediaKind === "image" || mime.startsWith("image/");

  if (tLen >= 80) return { accept: true, reason: "text_len>=80", keyword_hits: keywordHits };
  if (tLen >= 60 && keywordHits >= 1) return { accept: true, reason: "text_len>=60_signal", keyword_hits: keywordHits };
  if (tLen >= 35 && keywordHits >= 2) return { accept: true, reason: "text_len>=35_signal", keyword_hits: keywordHits };
  if (isImage && tLen >= 20 && keywordHits >= 1) return { accept: true, reason: "image_text_signal", keyword_hits: keywordHits };

  return { accept: false, reason: "text_too_short_or_low_signal", keyword_hits: keywordHits };
}

function parseJsonObjectFromText_(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const direct = safeJsonParseAny_(raw);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    const parsed = safeJsonParseAny_(fenced[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }

  return null;
}

function collectGeminiCandidateText_(obj) {
  const src = (obj && typeof obj === "object") ? obj : {};
  const allCandidates = [
    ...(Array.isArray(src.candidates) ? src.candidates : []),
    ...(Array.isArray(src?.data?.candidates) ? src.data.candidates : []),
    ...(Array.isArray(src?.response?.candidates) ? src.response.candidates : []),
  ];
  const chunks = [];

  for (const cand of allCandidates) {
    const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    for (const part of parts) {
      if (typeof part === "string") {
        const s = part.trim();
        if (s) chunks.push(s);
        continue;
      }
      const s = String(part?.text || "").trim();
      if (s) chunks.push(s);
    }
  }

  return chunks.join("\n").trim().slice(0, 120000);
}

function resolveExtractorResponse_(obj) {
  const src = (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};

  const directText = String(
    src.text ??
    src.extracted_text ??
    src.extractedText ??
    src.content_text ??
    src.contentText ??
    src.content ??
    src.markdown ??
    src.body ??
    src?.data?.text ??
    src?.data?.content ??
    src?.data?.markdown ??
    ""
  ).trim().slice(0, 120000);

  const geminiText = collectGeminiCandidateText_(src);
  const candidateText = directText || geminiText;
  const structured = parseJsonObjectFromText_(candidateText);

  const structuredText = String(
    structured?.job_description ??
    structured?.jobDescription ??
    structured?.description ??
    structured?.jd_text ??
    structured?.jdText ??
    structured?.content ??
    ""
  ).trim().slice(0, 120000);

  const text = (structuredText || directText || geminiText).trim().slice(0, 120000);

  const title = String(
    src.title ??
    src.job_title ??
    src.jobTitle ??
    src.subject ??
    src?.data?.title ??
    structured?.job_title ??
    structured?.jobTitle ??
    structured?.title ??
    structured?.role_title ??
    structured?.roleTitle ??
    ""
  ).trim().slice(0, 300);

  const company = String(
    src.company ??
    src.company_name ??
    src.companyName ??
    src?.data?.company ??
    structured?.company ??
    structured?.company_name ??
    structured?.companyName ??
    ""
  ).trim().slice(0, 300);

  const urls = normalizeExtractorUrls_([
    ...(Array.isArray(src.urls) ? src.urls : []),
    src.url,
    src.job_url,
    src.jobUrl,
    src?.data?.url,
    src?.data?.job_url,
    structured?.url,
    structured?.job_url,
    structured?.jobUrl,
    extractFirstHttpUrlFromText_(text),
  ]);

  return {
    text,
    title,
    company,
    urls,
    structured,
  };
}

async function extractWhatsAppMediaText_(env, input = {}) {
  const extractorService = (env?.EXTRACTOR && typeof env.EXTRACTOR.fetch === "function")
    ? env.EXTRACTOR
    : null;
  const configuredExtractorUrl = String(env?.WHATSAPP_MEDIA_EXTRACTOR_URL || "").trim();
  const fallbackExtractorUrl = String(
    env?.WHATSAPP_MEDIA_EXTRACTOR_URL_FALLBACK ||
    "https://jobops-whatsapp-extractor.shivanand-shah94.workers.dev/extract/whatsapp-media"
  ).trim();
  const extractorUrl = chooseExtractorUrl_(configuredExtractorUrl, fallbackExtractorUrl);
  if (!extractorService && !extractorUrl) {
    return { ok: false, error: "extractor_not_configured", extractor_url: "" };
  }
  const extractorRequestUrl = extractorService
    ? "https://extractor.internal/extract/whatsapp-media"
    : extractorUrl;
  const extractorLogUrl = extractorService
    ? `service:EXTRACTOR:${String(extractorUrl || "").trim() || "inline"}`
    : extractorUrl;

  if (!extractorService) {
    let parsedUrl;
    try {
      parsedUrl = new URL(extractorRequestUrl);
    } catch {
      return { ok: false, error: "invalid_extractor_url", extractor_url: extractorRequestUrl };
    }

    const isLocal = parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
    if (parsedUrl.protocol !== "https:" && !isLocal) {
      return { ok: false, error: "extractor_url_must_be_https", extractor_url: extractorRequestUrl };
    }

    const allowHostsRaw = String(env?.WHATSAPP_MEDIA_EXTRACTOR_ALLOW_HOSTS || "").trim();
    if (allowHostsRaw) {
      const allowed = allowHostsRaw
        .split(/[\r\n,]+/g)
        .map((x) => String(x || "").trim().toLowerCase())
        .filter(Boolean);
      if (allowed.length && !allowed.includes(parsedUrl.hostname.toLowerCase())) {
        return { ok: false, error: "extractor_host_not_allowed", extractor_url: extractorRequestUrl };
      }
    }
  }

  const mediaUrl = String(input?.media_url || "").trim();
  if (!mediaUrl) return { ok: false, error: "missing_media_url", extractor_url: extractorLogUrl };
  try {
    const mediaParsed = new URL(mediaUrl);
    if (mediaParsed.protocol !== "http:" && mediaParsed.protocol !== "https:") {
      return { ok: false, error: "unsupported_media_url_protocol", extractor_url: extractorLogUrl };
    }
  } catch {
    return { ok: false, error: "invalid_media_url", extractor_url: extractorLogUrl };
  }

  const timeoutMs = clampInt_(env?.WHATSAPP_MEDIA_EXTRACTOR_TIMEOUT_MS || 12000, 2000, 60000);
  const headers = {
    "Content-Type": "application/json",
  };
  const extractorToken = String(env?.WHATSAPP_MEDIA_EXTRACTOR_TOKEN || "").trim();
  if (extractorToken) headers.Authorization = `Bearer ${extractorToken}`;

  const forwardVonageAuth = toBool_(env?.WHATSAPP_MEDIA_FORWARD_VONAGE_AUTH, false);
  const inboundAuthorization = String(input?.inbound_authorization || "").trim();
  if (forwardVonageAuth && inboundAuthorization) {
    headers["x-vonage-authorization"] = inboundAuthorization;
  }

  const payload = {
    provider: String(input?.provider || "vonage").trim().toLowerCase() || "vonage",
    message_id: String(input?.message_id || "").trim() || null,
    sender: String(input?.sender || "").trim() || null,
    media: {
      url: mediaUrl,
      type: String(input?.media_type || "").trim().toLowerCase() || null,
      mime_type: String(input?.media_mime_type || "").trim().toLowerCase() || null,
      file_name: String(input?.media_file_name || "").trim() || null,
      size_bytes: numOrNull_(input?.media_size_bytes),
      caption: String(input?.media_caption || "").trim() || null,
    },
    signature: {
      verified: Boolean(input?.signature_verified),
      mode: String(input?.signature_mode || "").trim() || null,
      issuer: String(input?.signature_issuer || "").trim() || null,
    },
  };

  let res;
  try {
    const requestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    };
    if (extractorService) {
      res = await fetchWithTimeoutUsingFetcher_(
        extractorService.fetch.bind(extractorService),
        extractorRequestUrl,
        requestInit,
        timeoutMs
      );
    } else {
      res = await fetchWithTimeout_(extractorRequestUrl, requestInit, timeoutMs);
    }
  } catch (e) {
    return {
      ok: false,
      error: `extractor_request_failed:${String(e?.message || e || "unknown").slice(0, 180)}`,
      extractor_url: extractorLogUrl,
    };
  }

  const rawText = await res.text().catch(() => "");
  const parsed = safeJsonParseAny_(rawText);
  if (!res.ok) {
    const detail = String(
      parsed?.error ||
      parsed?.detail ||
      rawText ||
      `status_${res.status}`
    ).trim().slice(0, 300);
    return { ok: false, error: `extractor_http_${res.status}:${detail}`, extractor_url: extractorLogUrl };
  }

  const obj = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  const resolved = resolveExtractorResponse_(obj);

  return {
    ok: true,
    text: resolved.text,
    title: resolved.title,
    company: resolved.company,
    urls: resolved.urls,
    response: obj,
    extractor_url: extractorLogUrl,
  };
}

function chooseExtractorUrl_(configured, fallback) {
  const c = String(configured || "").trim();
  const f = String(fallback || "").trim();
  if (!c) return f;
  try {
    const u = new URL(c);
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "").toLowerCase();
    const looksLikeVonageApi = host.includes("nexmo.com") || host.includes("vonage.com");
    const looksLikeMediaPath = path.includes("/v3/media");
    if (looksLikeVonageApi || looksLikeMediaPath) return f || c;
  } catch {
    return f || c;
  }
  return c;
}

function pickVonageWebhookSender_(payload = {}) {
  const p = (payload && typeof payload === "object") ? payload : {};
  return String(
    p.from ||
    p.sender ||
    p.msisdn ||
    p.phone ||
    p.message?.from ||
    p.whatsapp?.from ||
    ""
  ).trim().slice(0, 500);
}

function normalizeVonageSenderForAllowList_(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("whatsapp:")) s = s.slice("whatsapp:".length);
  return s.replace(/[^a-z0-9+]/g, "");
}

function getVonageAllowedSenders_(env) {
  const raw = String(
    env?.WHATSAPP_VONAGE_ALLOWED_SENDERS ||
    env?.WHATSAPP_ALLOWED_SENDERS ||
    ""
  ).trim();
  if (!raw) return [];
  const list = raw
    .split(/[\r\n,]+/g)
    .map((x) => normalizeVonageSenderForAllowList_(x))
    .filter(Boolean);
  return unique_(list).slice(0, 200);
}

async function verifyVonageJwtHs256_(token, secret) {
  const compact = String(token || "").trim();
  const keySecret = String(secret || "").trim();
  if (!compact) return { ok: false, error: "missing_token" };
  if (!keySecret) return { ok: false, error: "missing_signature_secret" };

  const parts = compact.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed_jwt" };

  const headerText = decodeBase64UrlToText_(parts[0]);
  const payloadText = decodeBase64UrlToText_(parts[1]);
  const header = safeJsonParseAny_(headerText);
  const payload = safeJsonParseAny_(payloadText);
  if (!header || typeof header !== "object") return { ok: false, error: "invalid_jwt_header" };
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid_jwt_payload" };

  const alg = String(header.alg || "").trim().toUpperCase();
  if (alg !== "HS256") return { ok: false, error: "unsupported_jwt_alg" };

  const signatureBytes = decodeBase64UrlToBytes_(parts[2]);
  if (!signatureBytes) return { ok: false, error: "invalid_jwt_signature_encoding" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keySecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const validSig = await crypto.subtle.verify("HMAC", key, signatureBytes, data);
  if (!validSig) return { ok: false, error: "jwt_signature_mismatch" };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  const nbf = Number(payload.nbf);
  if (Number.isFinite(exp) && nowSeconds > (Math.floor(exp) + 60)) {
    return { ok: false, error: "jwt_expired" };
  }
  if (Number.isFinite(nbf) && nowSeconds + 60 < Math.floor(nbf)) {
    return { ok: false, error: "jwt_not_yet_valid" };
  }

  return { ok: true, header, payload };
}

async function verifyVonageWebhookSignature_(request, rawBody, env) {
  const signatureSecret = String(env?.WHATSAPP_VONAGE_SIGNATURE_SECRET || "").trim();
  if (!signatureSecret) {
    return { ok: true, enabled: false, mode: "disabled", claims: {} };
  }

  const bearer = getBearerToken_(request);
  if (!bearer) {
    return { ok: false, status: 401, error: "Missing Vonage Authorization bearer token" };
  }

  const jwt = await verifyVonageJwtHs256_(bearer, signatureSecret);
  if (!jwt.ok) {
    return { ok: false, status: 401, error: `Invalid Vonage signature token (${jwt.error})` };
  }

  const claims = (jwt.payload && typeof jwt.payload === "object") ? jwt.payload : {};
  const payloadHashClaim = String(claims.payload_hash || claims.payloadHash || "").trim();
  if (payloadHashClaim) {
    const bodyText = String(rawBody || "");
    const digestBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText));
    const digestBytes = new Uint8Array(digestBuffer);
    const digestHex = bytesToHex_(digestBytes).toLowerCase();
    const digestBase64 = bytesToBase64_(digestBytes);
    const digestBase64Url = digestBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

    const claim = payloadHashClaim;
    const claimLower = claim.toLowerCase();
    const matchesHex = claim.length === digestHex.length && timingSafeEqualText_(claimLower, digestHex);
    const matchesB64 = claim.length === digestBase64.length && timingSafeEqualText_(claim, digestBase64);
    const matchesB64Url = claim.length === digestBase64Url.length && timingSafeEqualText_(claim, digestBase64Url);
    if (!matchesHex && !matchesB64 && !matchesB64Url) {
      return { ok: false, status: 401, error: "Vonage payload hash mismatch" };
    }
  }

  return {
    ok: true,
    enabled: true,
    mode: "verified",
    claims: {
      iss: String(claims.iss || "").trim() || null,
      sub: String(claims.sub || "").trim() || null,
      jti: String(claims.jti || "").trim() || null,
      iat: Number.isFinite(Number(claims.iat)) ? Math.floor(Number(claims.iat)) : null,
      exp: Number.isFinite(Number(claims.exp)) ? Math.floor(Number(claims.exp)) : null,
    },
  };
}

function safeJsonParseArray_(s) {
  try {
    if (Array.isArray(s)) return s.map(String);
    const v = JSON.parse(String(s || "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function jsonString_(s) {
  return JSON.stringify(String(s || ""));
}

function numOr_(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampInt_(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function isOpenJobStatus_(status) {
  const s = String(status || "").trim().toUpperCase();
  return s !== "APPLIED" && s !== "REJECTED" && s !== "ARCHIVED";
}

function normalizeKeywords_(input) {
  // Accept array OR string (comma/newline separated) OR JSON string.
  if (Array.isArray(input)) return unique_(input.map((x) => String(x || "").trim()).filter(Boolean)).slice(0, 200);

  const s = String(input || "").trim();
  if (!s) return [];

  // If it's JSON array string
  if (s.startsWith("[") && s.endsWith("]")) {
    const arr = safeJsonParseArray_(s);
    return unique_(arr.map((x) => String(x || "").trim()).filter(Boolean)).slice(0, 200);
  }

  // Split commas/newlines
  const parts = s.split(/[\n,]+/g).map((x) => x.trim()).filter(Boolean);
  return unique_(parts).slice(0, 200);
}

function normalizeRubricProfile_(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "pm_v1" || raw === "target_generic_v1" || raw === "auto") return raw;
  if (raw === "pm" || raw === "product" || raw === "product_manager") return "pm_v1";
  if (raw === "generic" || raw === "target" || raw === "default") return "target_generic_v1";
  return "auto";
}

function unique_(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = String(x || "").trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}


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

export default {
  async fetch(request, env) {
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
        return json_({ ok: true, ts: Date.now() }, env, 200);
      }

      // ----------------------------
      // Route groups & auth
      // ----------------------------
      const routeMode = routeModeFor_(path);

      const isUiRoute =
        path === "/ingest" ||
        path === "/jobs" ||
        path === "/metrics" ||
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
        path === "/resolve-jd" ||
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
        path === "/jobs/recover/missing-fields" ||
        path === "/jobs/recover/rescore-existing-jd" ||
        (path.startsWith("/jobs/") && path.endsWith("/rescore"));

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
        const rows = (res.results || []).map((row) => {
          const fetchDebug = safeJsonParse_(row.fetch_debug_json) || {};
          row.fetch_debug = fetchDebug;
          row.ingest_channel = normalizeIngestChannel_(fetchDebug.ingest_channel) || null;
          row.jd_confidence = String(fetchDebug.jd_confidence || "").trim().toLowerCase() || null;
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

      // ============================
      // UI: JOB detail
      // ============================
      if (path.startsWith("/jobs/") && request.method === "GET" && !path.endsWith("/status") && !path.endsWith("/rescore") && !path.endsWith("/checklist") && !path.endsWith("/resume-payload") && !path.endsWith("/application-pack")) {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const row = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);

        decorateJobRow_(row);
        return json_({ ok: true, data: row }, env, 200);
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
        const allowed = new Set(["NEW","LINK_ONLY","SCORED","SHORTLISTED","APPLIED","REJECTED","ARCHIVED"]);
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
        const location = String(extracted?.location || existing.location || "").trim();
        const seniority = String(extracted?.seniority || existing.seniority || "").trim();

        const scoring = await scoreJobWithModel_(aiForManual, {
          role_title: roleTitle,
          location,
          seniority,
          jd_clean: jdText,
        }, targets, cfg);

        const rejectFromTargets = computeTargetReject_(jdText, scoring.primary_target_id, targets);
        const mergedRejectTriggered = Boolean(scoring.reject_triggered || rejectFromTargets.triggered || hasRejectMarker_(jdText));
        const rejectReasons = [];
        if (hasRejectMarker_(jdText)) rejectReasons.push("Contains 'Reject:' marker in JD");
        if (scoring.reject_triggered) rejectReasons.push("AI flagged reject_triggered=true");
        if (rejectFromTargets.triggered) rejectReasons.push(`Target reject keywords: ${rejectFromTargets.matches.join(", ")}`);

        const finalScore = mergedRejectTriggered ? 0 : clampInt_(scoring.final_score, 0, 100);
        const transition = applyStatusTransition_(existing, "scored", {
          final_score: finalScore,
          reject_triggered: mergedRejectTriggered,
          cfg,
        });

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
          scoring.primary_target_id || cfg.DEFAULT_TARGET_ID,
          clampInt_(scoring.score_must, 0, 100),
          clampInt_(scoring.score_nice, 0, 100),
          finalScore,
          mergedRejectTriggered ? 1 : 0,
          JSON.stringify(rejectReasons),
          mergedRejectTriggered ? extractRejectEvidence_(jdText) : "",
          String(scoring.reason_top_matches || "").slice(0, 1000),
          transition.next_status,
          transition.system_status,
          transition.status,
          now,
          now,
          jobKey
        ).run();

        await logEvent_(env, "MANUAL_JD_RESCORED", jobKey, { status: transition.status, final_score: finalScore, ts: now });
        return json_({
          ok: true,
          data: {
            job_key: jobKey,
            status: transition.status,
            final_score: finalScore,
            primary_target_id: scoring.primary_target_id || cfg.DEFAULT_TARGET_ID,
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
        const scoring = await scoreJobWithModel_(ai, {
          role_title: roleTitle,
          location,
          seniority,
          jd_clean: jdClean,
        }, targets, cfg);

        // Apply target-based reject keyword scan too
        const rejectFromTargets = computeTargetReject_(jdClean, scoring.primary_target_id, targets);

        const mergedRejectTriggered = Boolean(scoring.reject_triggered || rejectFromTargets.triggered || hasRejectMarker_(jdClean));
        const rejectReasons = []
        if (hasRejectMarker_(jdClean)) rejectReasons.push("Contains 'Reject:' marker in JD");
        if (scoring.reject_triggered) rejectReasons.push("AI flagged reject_triggered=true");
        if (rejectFromTargets.triggered) rejectReasons.push(`Target reject keywords: ${rejectFromTargets.matches.join(", ")}`);

        const finalScore = mergedRejectTriggered ? 0 : clampInt_(scoring.final_score, 0, 100);
        const transition = applyStatusTransition_(job, "scored", {
          final_score: finalScore,
          reject_triggered: mergedRejectTriggered,
          cfg,
        });

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
          scoring.primary_target_id || cfg.DEFAULT_TARGET_ID,
          clampInt_(scoring.score_must, 0, 100),
          clampInt_(scoring.score_nice, 0, 100),
          finalScore,
          mergedRejectTriggered ? 1 : 0,
          JSON.stringify(rejectReasons),
          mergedRejectTriggered ? extractRejectEvidence_(jdClean) : "",
          String(scoring.reason_top_matches || "").slice(0, 1000),
          transition.next_status,
          transition.system_status,
          transition.status,
          now,
          now,
          jobKey
        ).run();

        await logEvent_(env, "RESCORED_ONE", jobKey, { final_score: finalScore, status: transition.status, ts: now });

        return json_({ ok: true, data: { job_key: jobKey, final_score: finalScore, status: transition.status, primary_target_id: scoring.primary_target_id || cfg.DEFAULT_TARGET_ID } }, env, 200);
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
      // UI: Resume profiles
      // ============================
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
      if (path.startsWith("/jobs/") && path.endsWith("/generate-application-pack") && request.method === "POST") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

        const body = await request.json().catch(() => ({}));
        const force = Boolean(body.force);
        const renderer = String(body.renderer || "reactive_resume").trim().toLowerCase();
        const rendererSafe = (renderer === "html_simple" || renderer === "reactive_resume") ? renderer : "reactive_resume";
        const controls = {
          template_id: String(body.template_id || body.templateId || "").trim().slice(0, 80),
          enabled_blocks: Array.isArray(body.enabled_blocks)
            ? body.enabled_blocks
            : (Array.isArray(body.enabledBlocks) ? body.enabledBlocks : []),
          selected_keywords: Array.isArray(body.selected_keywords)
            ? body.selected_keywords
            : (Array.isArray(body.selectedKeywords) ? body.selectedKeywords : []),
          ats_target_mode: String(body.ats_target_mode || body.atsTargetMode || "").trim().toLowerCase(),
        };

        const job = await env.DB.prepare(`SELECT * FROM jobs WHERE job_key = ? LIMIT 1;`).bind(jobKey).first();
        if (!job) return json_({ ok: false, error: "Not found" }, env, 404);

        let profile = null;
        const profileIdIn = String(body.profile_id || "").trim();
        if (profileIdIn) {
          profile = await env.DB.prepare(`SELECT * FROM resume_profiles WHERE id = ? LIMIT 1;`).bind(profileIdIn).first();
        }
        if (!profile) profile = await ensurePrimaryProfile_(env);

        const targets = await loadTargets_(env);
        const target = targets.find((t) => t.id === String(job.primary_target_id || "")) || null;
        const aiForPack = getAi_(env);

        let packData = null;
        try {
          packData = await generateApplicationPack_({
            env,
            ai: aiForPack || null,
            job,
            target,
            profile,
            renderer: rendererSafe,
            controls,
          });
        } catch (e) {
          packData = {
            status: aiForPack ? "ERROR" : "NEEDS_AI",
            error_text: String(e?.message || e).slice(0, 1000),
            pack_json: {
              job: { job_key: job.job_key, job_url: job.job_url, source_domain: job.source_domain, status: job.status },
              target: target || null,
              extracted: { role_title: job.role_title, company: job.company, location: job.location, seniority: job.seniority, final_score: job.final_score },
              tailoring: { summary: "", bullets: [], must_keywords: safeJsonParseArray_(job.must_have_keywords_json), nice_keywords: safeJsonParseArray_(job.nice_to_have_keywords_json) },
              renderer: rendererSafe,
            },
            ats_json: { score: 0, missing_keywords: safeJsonParseArray_(job.must_have_keywords_json).slice(0, 20), coverage: {}, notes: "Pack generation failed. Retry later." },
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

        await logEvent_(env, "APPLICATION_PACK_GENERATED", jobKey, {
          profile_id: profile.id,
          status: packData.status,
          ats_score: packData.ats_score,
          rr_export_contract_id: RR_EXPORT_CONTRACT_ID,
          rr_export_schema_version: RR_EXPORT_SCHEMA_VERSION,
          ts: Date.now(),
        });

        return json_({
          ok: true,
          data: {
            job_key: job.job_key,
            draft_id: saved.draft_id,
            profile_id: profile.id,
            status: packData.status,
            ats_score: packData.ats_score,
            template_id: controls.template_id || "",
            enabled_blocks_count: Array.isArray(controls.enabled_blocks) ? controls.enabled_blocks.length : 0,
            selected_keywords_count: Array.isArray(controls.selected_keywords) ? controls.selected_keywords.length : 0,
            rr_export_contract: {
              id: RR_EXPORT_CONTRACT_ID,
              schema_version: RR_EXPORT_SCHEMA_VERSION,
            },
          }
        }, env, 200);
      }

      // ============================
      // UI: Get application pack
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/application-pack") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);
        const profileId = String(url.searchParams.get("profile_id") || "").trim();

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

        return json_({
          ok: true,
          data: {
            id: row.id,
            job_key: row.job_key,
            profile_id: row.profile_id,
            status: row.status,
            error_text: row.error_text || "",
            pack_json: packJson,
            ats_json: atsJson,
            rr_export_json: rrExportJson,
            rr_export_contract: {
              id: RR_EXPORT_CONTRACT_ID,
              schema_version: RR_EXPORT_SCHEMA_VERSION,
            },
            updated_at: row.updated_at,
          }
        }, env, 200);
      }

      // ============================
      // UI: Targets list
      // ============================
      if (path === "/targets" && request.method === "GET") {
        const targetSchema = await getTargetsSchema_(env);
        const rejectSelect = targetSchema.hasRejectKeywords ? "reject_keywords_json" : "'[]' AS reject_keywords_json";
        const res = await env.DB.prepare(`
          SELECT id, name, primary_role, seniority_pref, location_pref,
                 must_keywords_json, nice_keywords_json, ${rejectSelect},
                 updated_at, created_at
          FROM targets
          ORDER BY updated_at DESC;
        `.trim()).all();

        const rows = (res.results || []).map((r) => ({
          ...r,
          must_keywords: safeJsonParseArray_(r.must_keywords_json),
          nice_keywords: safeJsonParseArray_(r.nice_keywords_json),
          reject_keywords: safeJsonParseArray_(r.reject_keywords_json),
        }));

        return json_({ ok: true, data: rows, meta: { reject_keywords_enabled: targetSchema.hasRejectKeywords } }, env, 200);
      }

      // ============================
      // UI: Target detail
      // ============================
      if (path.startsWith("/targets/") && request.method === "GET") {
        const targetId = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!targetId) return json_({ ok: false, error: "Missing target id" }, env, 400);
        const targetSchema = await getTargetsSchema_(env);
        const rejectSelect = targetSchema.hasRejectKeywords ? "reject_keywords_json" : "'[]' AS reject_keywords_json";

        const row = await env.DB.prepare(`
          SELECT id, name, primary_role, seniority_pref, location_pref,
                 must_keywords_json, nice_keywords_json, ${rejectSelect},
                 updated_at, created_at
          FROM targets WHERE id = ? LIMIT 1;
        `.trim()).bind(targetId).first();

        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);

        row.must_keywords = safeJsonParseArray_(row.must_keywords_json);
        row.nice_keywords = safeJsonParseArray_(row.nice_keywords_json);
        row.reject_keywords = safeJsonParseArray_(row.reject_keywords_json);

        return json_({ ok: true, data: row, meta: { reject_keywords_enabled: targetSchema.hasRejectKeywords } }, env, 200);
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

        // Keywords: accept array OR string with commas/newlines
        const must = normalizeKeywords_(body.must_keywords ?? body.must_keywords_json ?? []);
        const nice = normalizeKeywords_(body.nice_keywords ?? body.nice_keywords_json ?? []);
        const reject = normalizeKeywords_(body.reject_keywords ?? body.reject_keywords_json ?? []);
        const targetSchema = await getTargetsSchema_(env);

        const now = Date.now();
        const r = targetSchema.hasRejectKeywords
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
          ).run();

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

        const scoring = await scoreJobWithModel_(ai, { role_title: roleTitle, location, seniority, jd_clean: jdClean }, targets, cfg);
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
      // ADMIN: Ingest (raw URLs) â€” optional utility
      // ============================
      if (path === "/ingest" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rawUrls = Array.isArray(body.raw_urls) ? body.raw_urls : [];
        const emailText = typeof body.email_text === "string" ? body.email_text : "";
        const emailHtml = typeof body.email_html === "string" ? body.email_html : "";
        const emailSubject = typeof body.email_subject === "string" ? body.email_subject : "";
        const emailFrom = typeof body.email_from === "string" ? body.email_from : "";

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
    };
  } catch {
    return { hasRejectKeywords: false };
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

async function loadTargets_(env) {
  const targetSchema = await getTargetsSchema_(env);
  const rejectSelect = targetSchema.hasRejectKeywords ? "reject_keywords_json" : "'[]' AS reject_keywords_json";
  const res = await env.DB.prepare(`
    SELECT id, name, primary_role, seniority_pref, location_pref,
           must_keywords_json, nice_keywords_json, ${rejectSelect}
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

async function extractJdWithModel_(ai, text) {
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

async function scoreJobWithModel_(ai, job, targets, cfg) {
  const roleTitle = String(job.role_title || "").trim();
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
  "reason_top_matches": string
}

Rules:
- score_must: job.role_title vs target.primaryRole/target.name.
- score_nice: seniority + location fit (use job.seniority and job.location and jd_clean).
- final_score integer 0-100 (round). Use:
    final = score_must*0.40 + score_nice*0.35 + signal_score*0.25
  where signal_score (0-100) measures JD clarity/structure.
- Do not invent facts; base only on provided text.
- If you see explicit disqualifiers, set reject_triggered=true and mention why in reason_top_matches.

JOB:
{
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

  return {
    primary_target_id: String(parsed.primary_target_id || "").trim() || cfg.DEFAULT_TARGET_ID,
    score_must: clampInt_(parsed.score_must, 0, 100),
    score_nice: clampInt_(parsed.score_nice, 0, 100),
    final_score: clampInt_(parsed.final_score, 0, 100),
    reject_triggered: Boolean(parsed.reject_triggered),
    reason_top_matches: String(parsed.reason_top_matches || "").slice(0, 1000),
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
    out.jd_text_clean = fallback.slice(0, 12000);
    out.jd_source = "email";
    out.debug.used_email_fallback = true;
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
      label: "strict_linkedin",
    };
  }
  if (source === "iimjobs") {
    return {
      source_domain: "iimjobs",
      min_chars: 220,
      require_high_confidence_for_fetched: false,
      label: "standard_iimjobs",
    };
  }
  if (source === "naukri") {
    return {
      source_domain: "naukri",
      min_chars: 220,
      require_high_confidence_for_fetched: false,
      label: "standard_naukri",
    };
  }
  return {
    source_domain: source || "unknown",
    min_chars: 220,
    require_high_confidence_for_fetched: false,
    label: "default",
  };
}

function computeFallbackDecision_(sourceDomain, resolved, jdText, aiAvailable) {
  const policy = getSourceFallbackPolicy_(sourceDomain);
  const jdSource = String(resolved?.jd_source || "").toLowerCase();
  const fetchStatus = String(resolved?.fetch_status || "").toLowerCase();
  const confidence = String(resolved?.debug?.jd_confidence || "").toLowerCase();
  const len = String(jdText || "").trim().length;

  let reason = "none";
  if (!aiAvailable) {
    reason = "manual_required";
  } else if (fetchStatus === "blocked") {
    reason = "blocked";
  } else if (fetchStatus === "low_quality") {
    reason = "low_quality";
  } else if (jdSource !== "email" && jdSource !== "fetched") {
    reason = "manual_required";
  } else if (len < policy.min_chars) {
    reason = "low_quality";
  } else if (confidence === "low") {
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

    let scoring = null;
    let finalScore = null;
    let mergedRejectTriggered = false;
    let rejectReasons = [];
    if (!needsManual && canAutoScore && jdText && jdText.length >= 180) {
      const roleTitleForScore = String(extracted?.role_title || "").trim();
      const locationForScore = String(extracted?.location || "").trim();
      const seniorityForScore = String(extracted?.seniority || "").trim();
      if (roleTitleForScore || jdText) {
        scoring = await scoreJobWithModel_(aiForIngest, {
          role_title: roleTitleForScore,
          location: locationForScore,
          seniority: seniorityForScore,
          jd_clean: jdText,
        }, targets, cfg).catch(() => null);
      }

      if (scoring) {
        const rejectFromTargets = computeTargetReject_(jdText, scoring.primary_target_id, targets);
        mergedRejectTriggered = Boolean(scoring.reject_triggered || rejectFromTargets.triggered || hasRejectMarker_(jdText));
        if (hasRejectMarker_(jdText)) rejectReasons.push("Contains 'Reject:' marker in JD");
        if (scoring.reject_triggered) rejectReasons.push("AI flagged reject_triggered=true");
        if (rejectFromTargets.triggered) rejectReasons.push(`Target reject keywords: ${rejectFromTargets.matches.join(", ")}`);
        finalScore = mergedRejectTriggered ? 0 : clampInt_(scoring.final_score, 0, 100);
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
    if (scoring) {
      transition = applyStatusTransition_(null, "scored", {
        final_score: finalScore,
        reject_triggered: mergedRejectTriggered,
        cfg,
      });
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
          WHEN jobs.status IN ('APPLIED', 'REJECTED', 'ARCHIVED') THEN jobs.status
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

    if (scoring) {
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
            WHEN status IN ('APPLIED', 'REJECTED', 'ARCHIVED') THEN status
            ELSE ?
          END,
          system_status = CASE
            WHEN status IN ('APPLIED', 'REJECTED', 'ARCHIVED') THEN system_status
            ELSE ?
          END,
          next_status = CASE
            WHEN status IN ('APPLIED', 'REJECTED', 'ARCHIVED') THEN next_status
            ELSE ?
          END,
          last_scored_at = ?,
          updated_at = ?
        WHERE job_key = ?;
      `.trim()).bind(
        scoring.primary_target_id || cfg.DEFAULT_TARGET_ID,
        clampInt_(scoring.score_must, 0, 100),
        clampInt_(scoring.score_nice, 0, 100),
        finalScore,
        mergedRejectTriggered ? 1 : 0,
        JSON.stringify(rejectReasons),
        mergedRejectTriggered ? extractRejectEvidence_(jdText) : "",
        String(scoring.reason_top_matches || "").slice(0, 1000),
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
      primary_target_id: scoring?.primary_target_id || null
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

      const scoring = await scoreJobWithModel_(ai, {
        role_title: roleTitle,
        location,
        seniority,
        jd_clean: jdClean,
      }, targets, cfg);

      const rejectFromTargets = computeTargetReject_(jdClean, scoring.primary_target_id, targets);
      const mergedRejectTriggered = Boolean(scoring.reject_triggered || rejectFromTargets.triggered || hasRejectMarker_(jdClean));

      const rejectReasons = [];
      if (hasRejectMarker_(jdClean)) rejectReasons.push("Contains 'Reject:' marker in JD");
      if (scoring.reject_triggered) rejectReasons.push("AI flagged reject_triggered=true");
      if (rejectFromTargets.triggered) rejectReasons.push(`Target reject keywords: ${rejectFromTargets.matches.join(", ")}`);

      const finalScore = mergedRejectTriggered ? 0 : clampInt_(scoring.final_score, 0, 100);
      const transition = applyStatusTransition_(j, "scored", {
        final_score: finalScore,
        reject_triggered: mergedRejectTriggered,
        cfg,
      });

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
        scoring.primary_target_id || cfg.DEFAULT_TARGET_ID,
        clampInt_(scoring.score_must, 0, 100),
        clampInt_(scoring.score_nice, 0, 100),
        finalScore,
        mergedRejectTriggered ? 1 : 0,
        JSON.stringify(rejectReasons),
        mergedRejectTriggered ? extractRejectEvidence_(jdClean) : "",
        String(scoring.reason_top_matches || "").slice(0, 1000),
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
        primary_target_id: scoring.primary_target_id || cfg.DEFAULT_TARGET_ID
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
      return ingestRawUrls_(env, {
        rawUrls: Array.isArray(raw_urls) ? raw_urls : [],
        emailText: typeof email_text === "string" ? email_text : "",
        emailHtml: typeof email_html === "string" ? email_html : "",
        emailSubject: typeof email_subject === "string" ? email_subject : "",
        emailFrom: typeof email_from === "string" ? email_from : "",
        ingestChannel: "gmail",
      });
    },
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
      return ingestRawUrls_(env, {
        rawUrls: Array.isArray(raw_urls) ? raw_urls : [],
        emailText: typeof email_text === "string" ? email_text : "",
        emailHtml: typeof email_html === "string" ? email_html : "",
        emailSubject: typeof email_subject === "string" ? email_subject : "",
        emailFrom: typeof email_from === "string" ? email_from : "",
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
      return ingestRawUrls_(env, {
        rawUrls: Array.isArray(raw_urls) ? raw_urls : [],
        emailText: typeof email_text === "string" ? email_text : "",
        emailHtml: typeof email_html === "string" ? email_html : "",
        emailSubject: typeof email_subject === "string" ? email_subject : "",
        emailFrom: typeof email_from === "string" ? email_from : "",
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

function routeModeFor_(path) {
  if (path === "/health" || path === "/") return "public";

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


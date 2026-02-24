// worker_jobops_v2_ui_plus_clean.js
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
        path.startsWith("/jobs/") ||
        path === "/targets" ||
        path.startsWith("/targets/");

      const isAdminRoute =
        path === "/normalize-job" ||
        path === "/resolve-jd" ||
        path === "/extract-jd" ||
        path === "/score-jd";

      const authErr = requireAuth_(request, env, routeMode);
      if (authErr) return authErr;

      // DB required for most routes except /health and pure AI extraction/scoring
      const needsDB =
        isUiRoute ||
        path === "/score-pending" ||
        path === "/ingest" ||
        path === "/resolve-jd"; // resolve-jd optionally updates DB in some flows

      if (needsDB && !env.DB) {
        return json_({ ok: false, error: "Missing D1 binding env.DB (bind your D1 as DB)" }, env, 500);
      }

      // AI required for extract/score and rescore endpoints
      const needsAI =
        path === "/extract-jd" ||
        path === "/score-jd" ||
        path === "/score-pending" ||
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
            updated_at, created_at
          FROM jobs
          ${whereSql}
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?;
        `.trim();

        args.push(limit, offset);

        const res = await env.DB.prepare(sql).bind(...args).all();
        const rows = (res.results || []).map((row) => ({
          ...row,
          display_title: String(row.role_title || "").trim()
            ? `${String(row.role_title || "").trim()}${String(row.company || "").trim() ? ` - ${String(row.company || "").trim()}` : ""}`
            : "(Needs JD)",
        }));
        return json_({ ok: true, data: rows }, env, 200);
      }

      // ============================
      // UI: JOB detail
      // ============================
      if (path.startsWith("/jobs/") && request.method === "GET" && !path.endsWith("/status") && !path.endsWith("/rescore") && !path.endsWith("/checklist") && !path.endsWith("/resume-payload")) {
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
          await env.DB.prepare(`
            UPDATE jobs
            SET system_status = 'NEEDS_MANUAL_JD', updated_at = ?
            WHERE job_key = ?;
          `.trim()).bind(now, jobKey).run();

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

        const extracted = sanitizeExtracted_(await extractJdWithModel_(aiForManual, jdText), jdText);
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
        const nextStatus = computeSystemStatus_(finalScore, mergedRejectTriggered, cfg);

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
          nextStatus,
          nextStatus,
          nextStatus,
          now,
          now,
          jobKey
        ).run();

        await logEvent_(env, "MANUAL_JD_RESCORED", jobKey, { status: nextStatus, final_score: finalScore, ts: now });
        return json_({
          ok: true,
          data: {
            job_key: jobKey,
            status: nextStatus,
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
            .then((x) => sanitizeExtracted_(x, jdClean))
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
        const nextStatus = computeSystemStatus_(finalScore, mergedRejectTriggered, cfg);

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
          nextStatus,
          nextStatus,
          nextStatus,
          now,
          now,
          jobKey
        ).run();

        await logEvent_(env, "RESCORED_ONE", jobKey, { final_score: finalScore, status: nextStatus, ts: now });

        return json_({ ok: true, data: { job_key: jobKey, final_score: finalScore, status: nextStatus, primary_target_id: scoring.primary_target_id || cfg.DEFAULT_TARGET_ID } }, env, 200);
      }

      // ============================
      // UI: Checklist GET/POST
      // ============================
      if (path.startsWith("/jobs/") && path.endsWith("/checklist") && request.method === "GET") {
        const jobKey = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!jobKey) return json_({ ok: false, error: "Missing job_key" }, env, 400);

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
      // UI: Targets list
      // ============================
      if (path === "/targets" && request.method === "GET") {
        const res = await env.DB.prepare(`
          SELECT id, name, primary_role, seniority_pref, location_pref,
                 must_keywords_json, nice_keywords_json, reject_keywords_json,
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

        return json_({ ok: true, data: rows }, env, 200);
      }

      // ============================
      // UI: Target detail
      // ============================
      if (path.startsWith("/targets/") && request.method === "GET") {
        const targetId = decodeURIComponent(path.split("/")[2] || "").trim();
        if (!targetId) return json_({ ok: false, error: "Missing target id" }, env, 400);

        const row = await env.DB.prepare(`
          SELECT id, name, primary_role, seniority_pref, location_pref,
                 must_keywords_json, nice_keywords_json, reject_keywords_json,
                 updated_at, created_at
          FROM targets WHERE id = ? LIMIT 1;
        `.trim()).bind(targetId).first();

        if (!row) return json_({ ok: false, error: "Not found" }, env, 404);

        row.must_keywords = safeJsonParseArray_(row.must_keywords_json);
        row.nice_keywords = safeJsonParseArray_(row.nice_keywords_json);
        row.reject_keywords = safeJsonParseArray_(row.reject_keywords_json);

        return json_({ ok: true, data: row }, env, 200);
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

        const now = Date.now();
        const r = await env.DB.prepare(`
          UPDATE targets SET
            name = COALESCE(NULLIF(?, ''), name),
            primary_role = COALESCE(NULLIF(?, ''), primary_role),
            seniority_pref = COALESCE(NULLIF(?, ''), seniority_pref),
            location_pref = COALESCE(NULLIF(?, ''), location_pref),
            must_keywords_json = ?,
            nice_keywords_json = ?,
            reject_keywords_json = ?,
            updated_at = ?
          WHERE id = ?;
        `.trim()).bind(
          name,
          primaryRole,
          seniorityPref,
          locationPref,
          JSON.stringify(must),
          JSON.stringify(nice),
          JSON.stringify(reject),
          now,
          targetId
        ).run();

        if (!r.success || r.changes === 0) return json_({ ok: false, error: "Not found" }, env, 404);

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
        if (!jobUrl) return json_({ ok: false, error: "Missing job_url" }, env, 400);

        const resolved = await resolveJd_(jobUrl, { emailHtml, emailText });
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
        const limit = clampInt_(body.limit || 30, 1, 200);
        const statusFilter = String(body.status || "").trim().toUpperCase(); // optional
        const onlyStatuses = statusFilter ? [statusFilter] : ["NEW", "SCORED"];

        const targets = await loadTargets_(env);
        if (!targets.length) return json_({ ok: false, error: "No targets configured" }, env, 400);

        const cfg = await loadSysCfg_(env);

        // Pick jobs that are NEW or SCORED
        const placeholders = onlyStatuses.map(() => "?").join(",");
        const rows = await env.DB.prepare(`
          SELECT * FROM jobs
          WHERE status IN (${placeholders})
          ORDER BY updated_at ASC
          LIMIT ?;
        `.trim()).bind(...onlyStatuses, limit).all();

        const jobs = rows.results || [];
        let updated = 0;

        const results = [];
        for (const j of jobs) {
          try {
            const jdClean = String(j.jd_text_clean || "").trim();
            const roleTitle = String(j.role_title || "").trim();

            if (!jdClean && !roleTitle) {
              results.push({ job_key: j.job_key, ok: false, error: "missing_jd_and_title" });
              continue;
            }

            const scoring = await scoreJobWithModel_(ai, {
              role_title: roleTitle,
              location: String(j.location || ""),
              seniority: String(j.seniority || ""),
              jd_clean: jdClean,
            }, targets, cfg);

            const rejectFromTargets = computeTargetReject_(jdClean, scoring.primary_target_id, targets);
            const mergedRejectTriggered = Boolean(scoring.reject_triggered || rejectFromTargets.triggered || hasRejectMarker_(jdClean));

            const rejectReasons = [];
            if (hasRejectMarker_(jdClean)) rejectReasons.push("Contains 'Reject:' marker in JD");
            if (scoring.reject_triggered) rejectReasons.push("AI flagged reject_triggered=true");
            if (rejectFromTargets.triggered) rejectReasons.push(`Target reject keywords: ${rejectFromTargets.matches.join(", ")}`);

            const finalScore = mergedRejectTriggered ? 0 : clampInt_(scoring.final_score, 0, 100);
            const nextStatus = computeSystemStatus_(finalScore, mergedRejectTriggered, cfg);

            const now = Date.now();
            const r = await env.DB.prepare(`
              UPDATE jobs SET
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
              scoring.primary_target_id || cfg.DEFAULT_TARGET_ID,
              clampInt_(scoring.score_must, 0, 100),
              clampInt_(scoring.score_nice, 0, 100),
              finalScore,
              mergedRejectTriggered ? 1 : 0,
              JSON.stringify(rejectReasons),
              mergedRejectTriggered ? extractRejectEvidence_(jdClean) : "",
              String(scoring.reason_top_matches || "").slice(0, 1000),
              nextStatus,
              nextStatus,
              nextStatus,
              now,
              now,
              j.job_key
            ).run();

            if (r.success && r.changes) updated += 1;
            results.push({ job_key: j.job_key, ok: true, final_score: finalScore, status: nextStatus, primary_target_id: scoring.primary_target_id || cfg.DEFAULT_TARGET_ID });
          } catch (e) {
            results.push({ job_key: j.job_key, ok: false, error: String(e?.message || e) });
          }
        }

        await logEvent_(env, "RESCORED_BATCH", null, { limit, status: statusFilter || "NEW,SCORED", updated, ts: Date.now() });
        return json_({ ok: true, data: { picked: jobs.length, updated, jobs: results } }, env, 200);
      }

      // ============================
      // ADMIN: Ingest (raw URLs) â€” optional utility
      // ============================
      if (path === "/ingest" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rawUrls = Array.isArray(body.raw_urls) ? body.raw_urls : [];
        const emailText = typeof body.email_text === "string" ? body.email_text : "";
        const emailHtml = typeof body.email_html === "string" ? body.email_html : "";

        if (!rawUrls.length) return json_({ ok: false, error: "Missing raw_urls[]" }, env, 400);

        const now = Date.now();
        const results = [];
        let insertedOrUpdated = 0;
        let ignored = 0;

        const aiForIngest = ai || getAi_(env);
        const aiAvailable = Boolean(aiForIngest);

        for (const rawUrl of rawUrls) {
          const norm = await normalizeJobUrl_(String(rawUrl || "").trim());
          if (!norm || norm.ignored) {
            ignored += 1;
            continue;
          }

          // Resolve JD
          const resolved = await resolveJd_(norm.job_url, { emailHtml, emailText });

          // Extract minimal from job_url if resolution failed
          const jdText = String(resolved.jd_text_clean || "").trim();
          const needsManual = !aiAvailable || shouldRequireManualJd_(resolved, jdText);
          let extracted = null;
          if (!needsManual && jdText && jdText.length >= 200) {
            extracted = await extractJdWithModel_(aiForIngest, jdText)
              .then((x) => sanitizeExtracted_(x, jdText))
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

          const effectiveFetchStatus = aiAvailable ? String(resolved.fetch_status || "failed") : "ai_unavailable";
          const fetchDebug = { ...(resolved.debug || {}), ai_available: aiAvailable };
          const rowStatus = needsManual ? "LINK_ONLY" : "NEW";
          const systemStatus = needsManual ? "NEEDS_MANUAL_JD" : "NEW";

          // Upsert jobs row
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
                WHEN excluded.status = 'LINK_ONLY' AND jobs.status IN ('NEW', 'SCORED', 'LINK_ONLY') THEN 'LINK_ONLY'
                ELSE jobs.status
              END,
              next_status = CASE
                WHEN excluded.system_status = 'NEEDS_MANUAL_JD' THEN 'NEEDS_MANUAL_JD'
                ELSE jobs.next_status
              END,
              system_status = CASE
                WHEN excluded.system_status = 'NEEDS_MANUAL_JD' THEN 'NEEDS_MANUAL_JD'
                ELSE jobs.system_status
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
            rowStatus,
            systemStatus,
            systemStatus,
            now,
            now
          ).run();

          if (r.success) insertedOrUpdated += 1;

          results.push({
            raw_url: rawUrl,
            job_key: norm.job_key,
            job_url: norm.job_url,
            status: rowStatus,
            jd_source: resolved.jd_source,
            fetch_status: effectiveFetchStatus,
            system_status: systemStatus
          });
        }

        return json_({
          ok: true,
          data: {
            count_in: rawUrls.length,
            inserted_or_updated: insertedOrUpdated,
            ignored,
            results
          }
        }, env, 200);
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

async function loadTargets_(env) {
  const res = await env.DB.prepare(`
    SELECT id, name, primary_role, seniority_pref, location_pref,
           must_keywords_json, nice_keywords_json, reject_keywords_json
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
  row.display_title = String(row.role_title || "").trim()
    ? `${String(row.role_title || "").trim()}${String(row.company || "").trim() ? ` - ${String(row.company || "").trim()}` : ""}`
    : "(Needs JD)";
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

function sanitizeExtracted_(raw, jdText) {
  if (!raw || typeof raw !== "object") return null;
  const out = { ...raw };
  const txt = String(jdText || "");

  const badLabels = new Set(["startup", "company", "organization", "introduction", "role", "job"]);
  const normalize = (v) => String(v || "").replace(/\s+/g, " ").trim();

  out.company = normalize(out.company);
  out.role_title = normalize(out.role_title);
  out.location = normalize(out.location);
  out.seniority = normalize(out.seniority);
  out.work_mode = normalize(out.work_mode);

  if (badLabels.has(out.company.toLowerCase())) out.company = "";
  if (badLabels.has(out.role_title.toLowerCase())) out.role_title = "";

  if (!out.role_title || out.role_title.length < 3) {
    const m =
      txt.match(/as a\s+([^\n,]{3,140})[,.:]/i) ||
      txt.match(/role(?:\s+and\s+responsibilities)?\s*[:\-]\s*([^\n]{3,140})/i);
    if (m && m[1]) out.role_title = normalize(m[1]);
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
  let u;
  try {
    u = new URL(rawUrl);
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
    const canonical = strip(rawUrl);
    return { ignored: false, source_domain: "linkedin", job_id: null, job_url: canonical, job_key: await sha1Hex(`url|${canonical}`) };
  }

  if (host.includes("iimjobs.com")) {
    const canonical = strip(rawUrl);
    const last = canonical.split("/").filter(Boolean).pop() || "";
    const id = last.match(/-(\d+)$/)?.[1] || null;
    return { ignored: false, source_domain: "iimjobs", job_id: id, job_url: canonical, job_key: await sha1Hex(id ? `iimjobs|${id}` : `url|${canonical}`) };
  }

  if (host.includes("naukri.com")) {
    const canonical = strip(rawUrl);
    const last = canonical.split("/").filter(Boolean).pop() || "";
    const id = last.match(/-(\d+)$/)?.[1] || null;
    return { ignored: false, source_domain: "naukri", job_id: id, job_url: canonical, job_key: await sha1Hex(id ? `naukri|${id}` : `url|${canonical}`) };
  }

  const canonical = strip(rawUrl);
  return { ignored: false, source_domain: host, job_id: null, job_url: canonical, job_key: await sha1Hex(`url|${canonical}`) };
}

/* =========================================================
 * JD resolution (fetch + email fallback + window extraction)
 * ========================================================= */

async function resolveJd_(jobUrl, { emailHtml, emailText }) {
  const out = { jd_text_clean: "", jd_source: "none", fetch_status: "failed", debug: {} };
  const sourceDomain = sourceDomainFromUrl_(jobUrl);

  // Try fetch first
  try {
    const res = await fetch(jobUrl, {
      redirect: "follow",
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
      } else if (cleaned.length >= 600) {
        out.jd_text_clean = cleaned.slice(0, 12000);
        out.jd_source = "fetched";
        out.fetch_status = "ok";
        return out;
      } else {
        out.fetch_status = out.fetch_status === "blocked" ? "blocked" : "failed";
      }
    }
  } catch (e) {
    out.fetch_status = "blocked";
    out.debug.fetch_error = String(e?.message || e);
  }

  // Email fallback
  const fallback = extractJdFromEmail_(emailHtml, emailText);
  if (fallback && fallback.length >= 200) {
    out.jd_text_clean = fallback.slice(0, 12000);
    out.jd_source = "email";
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

function isLowQualityJd_(text, sourceDomain) {
  const cleaned = cleanJdText_(text);
  const low = cleaned.toLowerCase();
  if (cleaned.length < 400) return true;

  if (low.includes("linkedin respects your privacy")) return true;
  if (low.includes("enable javascript")) return true;

  const cookieMentions = (low.match(/cookie/g) || []).length;
  const privacyMentions = (low.match(/privacy/g) || []).length;
  const linkedInShell = String(sourceDomain || "").includes("linkedin.com");
  if ((cookieMentions + privacyMentions >= 6) || (linkedInShell && cookieMentions + privacyMentions >= 3)) return true;

  return false;
}

function shouldRequireManualJd_(resolved, jdText) {
  const fetchStatus = String(resolved?.fetch_status || "").toLowerCase();
  if (fetchStatus === "blocked" || fetchStatus === "low_quality") return true;
  return String(jdText || "").trim().length < 400;
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

function extractJdFromEmail_(emailHtml, emailText) {
  const textFromHtml = emailHtml ? htmlToText_(emailHtml) : "";
  const combined = [String(emailText || ""), String(textFromHtml || "")].join("\n");
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
    .replace(/\s+/g, " ")
    .trim();

  return cleanJdText_(snippet);
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

/* =========================================================
 * Common helpers
 * ========================================================= */

function getAi_(env) {
  if (env && env.AI) return env.AI;
  const name = env && env.AI_BINDING ? String(env.AI_BINDING).trim() : "";
  if (name && env && env[name]) return env[name];
  return null;
}

function routeModeFor_(path) {
  if (path === "/health" || path === "/") return "public";

  if (
    path === "/jobs" ||
    path.startsWith("/jobs/") ||
    path === "/ingest" ||
    path === "/targets" ||
    path.startsWith("/targets/")
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

  const uiKey = request.headers.get("x-ui-key");
  const apiKey = request.headers.get("x-api-key");
  const uiOk = Boolean(env.UI_KEY) && uiKey === env.UI_KEY;
  const apiOk = Boolean(env.API_KEY) && apiKey === env.API_KEY;

  if (routeMode === "ui" && !uiOk) return json_({ ok: false, error: "Unauthorized" }, env, 401);
  if (routeMode === "api" && !apiOk) return json_({ ok: false, error: "Unauthorized" }, env, 401);
  if (routeMode === "either" && !uiOk && !apiOk) return json_({ ok: false, error: "Unauthorized" }, env, 401);

  return null;
}

function corsHeaders_(env) {
  const v = env && env.ALLOW_ORIGIN ? String(env.ALLOW_ORIGIN).trim() : "*";
  const allowOrigin = (v === "*" || v.startsWith("http")) ? v : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key,x-ui-key",
  };
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


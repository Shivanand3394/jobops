const GMAIL_TOKENS_ID = "default";
const GMAIL_STATE_ID = "default";

export function buildGmailAuthUrl_(env, { redirectUri, state }) {
  const clientId = String(env.GMAIL_CLIENT_ID || "").trim();
  if (!clientId) throw new Error("Missing GMAIL_CLIENT_ID");

  const qp = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${qp.toString()}`;
}

export async function handleGmailOAuthCallback_(env, { code, redirectUri }) {
  const now = Date.now();
  const tokenData = await exchangeCodeForTokens_(env, { code, redirectUri });

  let refreshTokenEnc = null;
  if (tokenData.refresh_token) {
    refreshTokenEnc = await encryptSecret_(env, String(tokenData.refresh_token));
  } else {
    const prev = await loadGmailTokensRow_(env);
    refreshTokenEnc = prev?.refresh_token_enc || null;
  }
  if (!refreshTokenEnc) {
    throw new Error("No refresh token returned by Google. Re-run OAuth with prompt=consent.");
  }

  await env.DB.prepare(`
    INSERT INTO gmail_tokens (id, refresh_token_enc, access_token, access_expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      refresh_token_enc = excluded.refresh_token_enc,
      access_token = excluded.access_token,
      access_expires_at = excluded.access_expires_at,
      updated_at = excluded.updated_at;
  `.trim()).bind(
    GMAIL_TOKENS_ID,
    refreshTokenEnc,
    tokenData.access_token || null,
    tokenData.expires_in ? now + (Number(tokenData.expires_in) * 1000) : null,
    now
  ).run();

  await env.DB.prepare(`
    INSERT INTO gmail_state (id, last_seen_internal_date, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_internal_date = excluded.last_seen_internal_date,
      updated_at = excluded.updated_at;
  `.trim()).bind(GMAIL_STATE_ID, now, now).run();

  return { connected: true, has_refresh_token: true };
}

export async function pollGmailAndIngest_(env, { query, maxPerRun, maxJobsPerEmail, maxJobsPerPoll, ingestFn, normalizeFn, classifyMessageFn }) {
  if (!env.DB) throw new Error("Missing D1 binding env.DB (bind your D1 as DB)");
  if (typeof ingestFn !== "function") throw new Error("ingestFn is required");

  const runId = crypto.randomUUID();
  const ts = Date.now();
  const accessToken = await getAccessToken_(env);
  const state = await loadGmailState_(env);
  const lastSeen = Number(state?.last_seen_internal_date || 0);

  const effectiveQuery = String(query || env.GMAIL_QUERY || "label:JobOps newer_than:14d").trim();
  const maxResults = clampInt_(maxPerRun || env.GMAIL_MAX_PER_RUN || 25, 1, 100);
  const effectiveMaxJobsPerEmail = clampInt_(maxJobsPerEmail || env.MAX_JOBS_PER_EMAIL || 3, 1, 50);
  const effectiveMaxJobsPerPoll = clampInt_(maxJobsPerPoll || env.MAX_JOBS_PER_POLL || 10, 1, 500);

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", effectiveQuery);
  listUrl.searchParams.set("maxResults", String(maxResults));

  const listResp = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listResp.ok) {
    const txt = await listResp.text();
    throw new Error(`Gmail list failed: ${listResp.status} ${txt.slice(0, 300)}`);
  }
  const listJson = await listResp.json();
  const messages = Array.isArray(listJson?.messages) ? listJson.messages : [];

  let scanned = Array.isArray(messages) ? messages.length : 0;
  let processed = 0;
  let skippedExisting = 0;
  let blockedOrFailedFetch = 0;
  let insertedOrUpdated = 0;
  let insertedCount = 0;
  let updatedCount = 0;
  let ignored = 0;
  let ignoredCount = 0;
  let linkOnly = 0;
  let linkOnlyCount = 0;
  let urlsFoundTotal = 0;
  let urlsJobDomainsTotal = 0;
  let ignoredDomainsCount = 0;
  let ingestedCount = 0;
  let jobsKeptTotal = 0;
  let jobsDroppedDueToCapsTotal = 0;
  let skippedPromotional = 0;
  let skippedPromotionalHeuristic = 0;
  let skippedPromotionalAi = 0;
  const urlsUnique = new Set();
  const resultsSample = [];
  let newestInternalDate = lastSeen;

  for (const m of messages) {
    if (jobsKeptTotal >= effectiveMaxJobsPerPoll) break;
    const msgId = String(m?.id || "").trim();
    if (!msgId) continue;

    const existing = await env.DB.prepare(
      `SELECT 1 AS ok FROM gmail_ingest_log WHERE msg_id = ? LIMIT 1;`
    ).bind(msgId).first();
    if (existing?.ok === 1) {
      skippedExisting += 1;
      continue;
    }

    const fullResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!fullResp.ok) {
      blockedOrFailedFetch += 1;
      continue;
    }
    const full = await fullResp.json();
    const internalDate = numOr0_(full?.internalDate);
    if (lastSeen && internalDate && internalDate <= lastSeen) {
      skippedExisting += 1;
      continue;
    }

    const parsed = parseGmailMessage_(full);
    const urlStats = scanUrls_(parsed.combined_text);
    const classified = await classifyJobUrls_(urlStats.unique_urls, normalizeFn);
    const urls = classified.supported_urls;

    let promoDecision = { reject: false, by: "none", reason: "" };
    if (typeof classifyMessageFn === "function") {
      try {
        promoDecision = await classifyMessageFn({
          subject: parsed.subject,
          from_email: parsed.from_email,
          email_text: parsed.email_text,
          email_html: parsed.email_html,
          combined_text: parsed.combined_text,
          urls_found_total: urlStats.found_urls.length,
          urls_unique_total: urlStats.unique_urls.length,
          urls_job_domains_total: urls.length,
        }) || promoDecision;
      } catch {
        promoDecision = { reject: false, by: "none", reason: "" };
      }
    }

    if (promoDecision?.reject) {
      processed += 1;
      skippedPromotional += 1;
      if (String(promoDecision.by || "") === "heuristic") skippedPromotionalHeuristic += 1;
      if (String(promoDecision.by || "") === "ai") skippedPromotionalAi += 1;

      await env.DB.prepare(`
        INSERT INTO gmail_ingest_log (
          msg_id, thread_id, internal_date, subject, from_email, urls_json, job_keys_json, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `.trim()).bind(
        msgId,
        String(full?.threadId || "").trim() || null,
        internalDate || null,
        parsed.subject || null,
        parsed.from_email || null,
        JSON.stringify([]),
        JSON.stringify([]),
        Date.now()
      ).run();

      if (internalDate > newestInternalDate) newestInternalDate = internalDate;
      continue;
    }

    const urlsKeptPerEmail = urls.slice(0, effectiveMaxJobsPerEmail);
    jobsDroppedDueToCapsTotal += Math.max(0, urls.length - urlsKeptPerEmail.length);
    const remainingGlobalSlots = Math.max(0, effectiveMaxJobsPerPoll - jobsKeptTotal);
    const urlsKept = urlsKeptPerEmail.slice(0, remainingGlobalSlots);
    jobsDroppedDueToCapsTotal += Math.max(0, urlsKeptPerEmail.length - urlsKept.length);

    urlsFoundTotal += urlStats.found_urls.length;
    urlsJobDomainsTotal += urls.length;
    ignoredDomainsCount += classified.ignored_domains_count;
    for (const u of urlStats.unique_urls) urlsUnique.add(u);

    const ingestData = urlsKept.length
      ? await ingestFn({
        raw_urls: urlsKept,
        email_text: parsed.email_text,
        email_html: parsed.email_html,
        email_subject: parsed.subject,
        email_from: parsed.from_email,
      })
      : { inserted_or_updated: 0, inserted_count: 0, updated_count: 0, ignored: 1, link_only: 0, results: [] };
    if (urlsKept.length) ingestedCount += 1;
    jobsKeptTotal += urlsKept.length;

    processed += 1;
    insertedOrUpdated += numOr0_(ingestData.inserted_or_updated);
    insertedCount += numOr0_(ingestData.inserted_count);
    updatedCount += numOr0_(ingestData.updated_count);
    ignored += numOr0_(ingestData.ignored);
    ignoredCount += numOr0_(ingestData.ignored);
    linkOnly += numOr0_(ingestData.link_only);
    linkOnlyCount += numOr0_(ingestData.link_only);

    const jobKeys = Array.isArray(ingestData?.results)
      ? ingestData.results.map((r) => String(r?.job_key || "").trim()).filter(Boolean)
      : [];
    for (const k of jobKeys) {
      if (resultsSample.length >= 3) break;
      if (resultsSample.includes(k)) continue;
      resultsSample.push(k);
    }

    await env.DB.prepare(`
      INSERT INTO gmail_ingest_log (
        msg_id, thread_id, internal_date, subject, from_email, urls_json, job_keys_json, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `.trim()).bind(
      msgId,
      String(full?.threadId || "").trim() || null,
      internalDate || null,
      parsed.subject || null,
      parsed.from_email || null,
      JSON.stringify(urlsKept),
      JSON.stringify(jobKeys),
      Date.now()
    ).run();

    if (internalDate > newestInternalDate) newestInternalDate = internalDate;
  }

  if (newestInternalDate > lastSeen) {
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO gmail_state (id, last_seen_internal_date, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen_internal_date = excluded.last_seen_internal_date,
        updated_at = excluded.updated_at;
    `.trim()).bind(GMAIL_STATE_ID, newestInternalDate, now).run();
  }

  return {
    run_id: runId,
    ts,
    query_used: effectiveQuery,
    max_results: maxResults,
    max_jobs_per_email: effectiveMaxJobsPerEmail,
    max_jobs_per_poll: effectiveMaxJobsPerPoll,
    messages_listed: messages.length,
    scanned,
    processed,
    skipped_already_ingested: skippedExisting,
    skipped_existing: skippedExisting,
    blocked_or_failed_fetch: blockedOrFailedFetch,
    urls_found_total: urlsFoundTotal,
    urls_unique_total: urlsUnique.size,
    urls_job_domains_total: urlsJobDomainsTotal,
    jobs_kept_total: jobsKeptTotal,
    jobs_dropped_due_to_caps_total: jobsDroppedDueToCapsTotal,
    skipped_promotional: skippedPromotional,
    skipped_promotional_heuristic: skippedPromotionalHeuristic,
    skipped_promotional_ai: skippedPromotionalAi,
    ignored_domains_count: ignoredDomainsCount,
    ingested_count: ingestedCount,
    ingest_inserted_count: insertedCount,
    ingest_updated_count: updatedCount,
    ingest_link_only_count: linkOnlyCount,
    ingest_ignored_count: ignoredCount,
    results_sample: resultsSample,
    inserted_or_updated: insertedOrUpdated,
    inserted_count: insertedCount,
    updated_count: updatedCount,
    ignored,
    ignored_count: ignoredCount,
    link_only: linkOnly,
    link_only_count: linkOnlyCount,
  };
}

async function getAccessToken_(env) {
  const row = await loadGmailTokensRow_(env);
  if (!row?.refresh_token_enc) throw new Error("Gmail not connected. Run /gmail/auth first.");

  const now = Date.now();
  if (row.access_token && numOr0_(row.access_expires_at) > now + 60_000) {
    return String(row.access_token);
  }

  const refreshToken = await decryptSecret_(env, String(row.refresh_token_enc));
  const clientId = String(env.GMAIL_CLIENT_ID || "").trim();
  const clientSecret = String(env.GMAIL_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) throw new Error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) {
    throw new Error(`Failed to refresh Gmail access token: ${r.status}`);
  }

  const expiresAt = now + (numOr0_(j.expires_in) || 3600) * 1000;
  const nextRefreshEnc = j.refresh_token
    ? await encryptSecret_(env, String(j.refresh_token))
    : String(row.refresh_token_enc);

  await env.DB.prepare(`
    UPDATE gmail_tokens
    SET refresh_token_enc = ?, access_token = ?, access_expires_at = ?, updated_at = ?
    WHERE id = ?;
  `.trim()).bind(nextRefreshEnc, String(j.access_token), expiresAt, now, GMAIL_TOKENS_ID).run();

  return String(j.access_token);
}

async function exchangeCodeForTokens_(env, { code, redirectUri }) {
  const clientId = String(env.GMAIL_CLIENT_ID || "").trim();
  const clientSecret = String(env.GMAIL_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) throw new Error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET");

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OAuth token exchange failed: ${r.status}`);
  return j;
}

async function loadGmailTokensRow_(env) {
  return env.DB.prepare(`
    SELECT id, refresh_token_enc, access_token, access_expires_at, updated_at
    FROM gmail_tokens
    WHERE id = ? LIMIT 1;
  `.trim()).bind(GMAIL_TOKENS_ID).first();
}

async function loadGmailState_(env) {
  return env.DB.prepare(`
    SELECT id, last_seen_internal_date, updated_at
    FROM gmail_state
    WHERE id = ? LIMIT 1;
  `.trim()).bind(GMAIL_STATE_ID).first();
}

function parseGmailMessage_(msg) {
  const payload = msg?.payload || {};
  const subject = getHeader_(payload, "Subject");
  const fromEmail = getHeader_(payload, "From");
  const parts = { text: [], html: [] };
  collectBodies_(payload, parts);
  const emailText = parts.text.join("\n").trim();
  const emailHtml = parts.html.join("\n").trim();
  const combinedText = [emailText, stripHtml_(emailHtml)].join("\n");

  return {
    subject: subject || "",
    from_email: fromEmail || "",
    email_text: emailText,
    email_html: emailHtml,
    combined_text: combinedText,
  };
}

function getHeader_(payload, key) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const hit = headers.find((h) => String(h?.name || "").toLowerCase() === String(key).toLowerCase());
  return String(hit?.value || "").trim();
}

function collectBodies_(part, out) {
  if (!part || typeof part !== "object") return;
  const mime = String(part.mimeType || "").toLowerCase();
  const data = String(part?.body?.data || "");
  if (data) {
    const decoded = decodeBase64UrlUtf8_(data);
    if (mime === "text/plain") out.text.push(decoded);
    if (mime === "text/html") out.html.push(decoded);
  }
  const children = Array.isArray(part.parts) ? part.parts : [];
  for (const c of children) collectBodies_(c, out);
}

function decodeBase64UrlUtf8_(s) {
  const v = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = v.length % 4 === 0 ? "" : "=".repeat(4 - (v.length % 4));
  const raw = atob(v + pad);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function extractUrls_(text) {
  const s = String(text || "");
  const m = s.match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  return unique_(m.map((x) => x.replace(/[),.;]+$/g, "").trim()).filter(Boolean));
}

function scanUrls_(text) {
  const s = String(text || "");
  const found = (s.match(/https?:\/\/[^\s"'<>)\]]+/gi) || [])
    .map((x) => String(x || "").replace(/[),.;]+$/g, "").trim())
    .filter(Boolean);
  return { found_urls: found, unique_urls: unique_(found) };
}

async function classifyJobUrls_(urls, normalizeFn) {
  // Prefer post-normalization classification so tracking links can still resolve to canonical job URLs.
  if (typeof normalizeFn === "function") {
    const supported = [];
    const seenByKey = new Set();
    const seenByUrl = new Set();
    let ignoredDomains = 0;

    for (const raw of urls || []) {
      let norm = null;
      try {
        norm = await normalizeFn(String(raw || ""));
      } catch {
        norm = null;
      }

      if (!norm || norm.ignored || !norm.job_url) {
        ignoredDomains += 1;
        continue;
      }

      const key = String(norm.job_key || "").trim();
      const canonicalUrl = String(norm.job_url || "").trim();
      if (!canonicalUrl) {
        ignoredDomains += 1;
        continue;
      }

      // Deduplicate by job_key first; fallback to canonical URL.
      if (key) {
        if (seenByKey.has(key)) continue;
        seenByKey.add(key);
      } else {
        if (seenByUrl.has(canonicalUrl)) continue;
        seenByUrl.add(canonicalUrl);
      }
      supported.push({
        job_key: key || null,
        job_url: canonicalUrl,
        job_id: String(norm.job_id || "").trim() || null,
        source_domain: String(norm.source_domain || "").trim() || null,
      });
    }

    supported.sort((a, b) => scoreCandidate_(b) - scoreCandidate_(a));
    return { supported_urls: supported.map((x) => x.job_url), ignored_domains_count: ignoredDomains };
  }

  const supported = [];
  let ignoredDomains = 0;
  for (const raw of urls || []) {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isLinkedIn = host.includes("linkedin.com") && path.includes("/jobs/");
    const isIimjobs = host.includes("iimjobs.com") && path.includes("/j/");
    const isNaukri = host.includes("naukri.com") && path.includes("/job-listings-");
    if (!isLinkedIn && !isIimjobs && !isNaukri) {
      ignoredDomains += 1;
      continue;
    }
    u.hash = "";
    supported.push(u.toString().replace(/\/+$/, ""));
  }
  return { supported_urls: unique_(supported), ignored_domains_count: ignoredDomains };
}

function scoreCandidate_(c) {
  const sourceDomain = String(c?.source_domain || "").toLowerCase();
  const jobId = String(c?.job_id || "").trim();
  const jobUrl = String(c?.job_url || "");
  const hasJobId = jobId ? 1 : 0;

  let strict = 0;
  if (sourceDomain === "linkedin" && /linkedin\.com\/jobs\/view\/\d+\/?$/i.test(jobUrl)) strict = 1;
  if (sourceDomain === "iimjobs" && /iimjobs\.com\/j\/.+-\d+\/?$/i.test(jobUrl)) strict = 1;
  if (sourceDomain === "naukri" && /naukri\.com\/job-listings-.+-\d+\/?$/i.test(jobUrl)) strict = 1;

  return (strict * 10) + (hasJobId * 5);
}

function filterJobUrls_(urls) {
  const out = [];
  for (const raw of urls || []) {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isLinkedIn = host.includes("linkedin.com") && path.includes("/jobs/");
    const isIimjobs = host.includes("iimjobs.com") && path.includes("/j/");
    const isNaukri = host.includes("naukri.com") && path.includes("/job-listings-");
    if (!isLinkedIn && !isIimjobs && !isNaukri) continue;
    u.hash = "";
    out.push(u.toString().replace(/\/+$/, ""));
  }
  return unique_(out);
}

function stripHtml_(html) {
  return String(html || "")
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

async function encryptSecret_(env, plainText) {
  const key = await importAesKey_(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(String(plainText || ""));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const ivB64 = bytesToBase64_(iv);
  const ctB64 = bytesToBase64_(new Uint8Array(ctBuf));
  return JSON.stringify({ iv: ivB64, ct: ctB64 });
}

async function decryptSecret_(env, encJson) {
  const parsed = JSON.parse(String(encJson || "{}"));
  const iv = base64ToBytes_(String(parsed.iv || ""));
  const ct = base64ToBytes_(String(parsed.ct || ""));
  if (!iv.length || !ct.length) throw new Error("Invalid encrypted token payload");
  const key = await importAesKey_(env);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plainBuf);
}

async function importAesKey_(env) {
  const raw = String(env.TOKEN_ENC_KEY || "").trim();
  if (!raw) throw new Error("Missing TOKEN_ENC_KEY");
  const keyBytes = base64ToBytes_(raw);
  if (keyBytes.length !== 32) throw new Error("TOKEN_ENC_KEY must be base64 for 32-byte key");
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function base64ToBytes_(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToBase64_(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function numOr0_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampInt_(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function unique_(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = String(x || "").trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

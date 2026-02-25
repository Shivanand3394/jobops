export async function pollRssFeedsAndIngest_(env, opts = {}) {
  return runRssFeedsAndIngest_(env, { ...opts, mode: "poll" });
}

export async function diagnoseRssFeedsAndIngest_(env, opts = {}) {
  return runRssFeedsAndIngest_(env, { ...opts, mode: "diagnostics" });
}

async function runRssFeedsAndIngest_(env, opts = {}) {
  const ingestFn = opts.ingestFn;
  const normalizeFn = opts.normalizeFn;
  if (typeof ingestFn !== "function") throw new Error("ingestFn is required");
  if (typeof normalizeFn !== "function") throw new Error("normalizeFn is required");

  const mode = String(opts.mode || "poll").toLowerCase();
  const runId = crypto.randomUUID();
  const ts = Date.now();

  const feedList = unique_(
    (Array.isArray(opts.feeds) ? opts.feeds : [])
      .map((x) => String(x || "").trim())
      .filter((x) => /^https?:\/\//i.test(x))
  );
  const maxItems = clampInt_(opts.maxPerRun || env.RSS_MAX_PER_RUN || 25, 1, 200);
  const allow = parseKeywordList_(opts.allowKeywords ?? env.RSS_ALLOW_KEYWORDS);
  const block = parseKeywordList_(opts.blockKeywords ?? env.RSS_BLOCK_KEYWORDS);
  const sampleLimit = clampInt_(opts.sampleLimit || 5, 1, 20);
  const maxCandidateAttempts = clampInt_(opts.maxCandidateAttempts || 12, 1, 50);
  const ingestEnabled = opts.ingestEnabled !== false;

  const resolverBudget = {
    remaining: clampInt_(opts.maxResolveRequests || 120, 0, 500),
    timeoutMs: clampInt_(opts.resolveTimeoutMs || 3500, 500, 10000),
  };

  let feedsTotal = feedList.length;
  let feedsProcessed = 0;
  let feedsFailed = 0;
  let itemsListed = 0;
  let processed = 0;
  let itemsFilteredAllow = 0;
  let itemsFilteredBlock = 0;
  let skippedEmpty = 0;
  let blockedOrFailedFetch = 0;
  let ingestedCount = 0;
  let insertedOrUpdated = 0;
  let insertedCount = 0;
  let updatedCount = 0;
  let ignored = 0;
  let linkOnly = 0;
  let urlsFoundTotal = 0;
  let urlsJobDomainsTotal = 0;
  let ignoredDomainsCount = 0;
  const reasonBuckets = createReasonBuckets_();
  const urlsUnique = new Set();
  const resultsSample = [];
  const sourceSummary = new Map();
  const unsupportedDomainByHost = {};
  const rejectedUrlSamples = [];
  const feedSummaries = [];

  if (!feedList.length) {
    return {
      run_id: runId,
      ts,
      skipped: true,
      reason: "no_feeds_configured",
      feeds_total: 0,
      feeds_processed: 0,
      feeds_failed: 0,
      max_per_run: maxItems,
      items_listed: 0,
      processed: 0,
      skipped_empty: 0,
      blocked_or_failed_fetch: 0,
      allow_keywords_count: allow.length,
      block_keywords_count: block.length,
      items_filtered_allow: 0,
      items_filtered_block: 0,
      urls_found_total: 0,
      urls_unique_total: 0,
      urls_job_domains_total: 0,
      ignored_domains_count: 0,
      ingested_count: 0,
      inserted_or_updated: 0,
      inserted_count: 0,
      updated_count: 0,
      ignored: 0,
      link_only: 0,
      reason_buckets: reasonBuckets,
      unsupported_domain_by_host: {},
      rejected_url_samples: [],
      feed_summaries: [],
      source_summary: [],
      results_sample: [],
      mode,
    };
  }

  for (const feedUrl of feedList) {
    if (processed >= maxItems) break;
    feedsProcessed += 1;

    const feedBucket = createReasonBuckets_();
    const feedSummary = {
      feed_url: feedUrl,
      items_listed: 0,
      processed: 0,
      reason_buckets: feedBucket,
      unsupported_domain_by_host: {},
      rejected_url_samples: [],
      sample_candidates: [],
    };

    let xml = "";
    try {
      const res = await fetch(feedUrl, {
        headers: {
          "User-Agent": "JobOpsRSS/1.0 (+https://get-job.shivanand-shah94.workers.dev)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
      });
      if (!res.ok) {
        feedsFailed += 1;
        blockedOrFailedFetch += 1;
        feedSummaries.push(feedSummary);
        continue;
      }
      xml = String(await res.text());
      if (!xml.trim()) {
        feedsFailed += 1;
        feedSummaries.push(feedSummary);
        continue;
      }
    } catch {
      feedsFailed += 1;
      blockedOrFailedFetch += 1;
      feedSummaries.push(feedSummary);
      continue;
    }

    const items = parseFeedItems_(xml);
    itemsListed += items.length;
    feedSummary.items_listed = items.length;
    const feedHost = hostFromUrl_(feedUrl) || "unknown";

    for (const item of items) {
      if (processed >= maxItems) break;
      processed += 1;
      feedSummary.processed += 1;

      const textForFilter = `${String(item?.title || "")}\n${String(item?.summary || "")}`.toLowerCase();
      if (block.length && containsAnyKeyword_(textForFilter, block)) {
        itemsFilteredBlock += 1;
        continue;
      }
      if (allow.length && !containsAnyKeyword_(textForFilter, allow)) {
        itemsFilteredAllow += 1;
        continue;
      }

      const rawUrls = collectItemUrls_(item);
      urlsFoundTotal += rawUrls.length;
      for (const u of unique_(rawUrls)) urlsUnique.add(u);

      if (!rawUrls.length) {
        skippedEmpty += 1;
        ignored += 1;
        reasonBuckets.no_url_in_item += 1;
        feedBucket.no_url_in_item += 1;
        continue;
      }

      const classified = await classifyRssJobUrlsDetailed_(rawUrls, normalizeFn, {
        maxCandidateAttempts,
        resolverBudget,
        sampleLimit,
      });
      const supported = Array.isArray(classified.supported) ? classified.supported : [];
      urlsJobDomainsTotal += supported.length;
      ignoredDomainsCount += numOr0_(classified.ignored_domains_count);
      mergeReasonBuckets_(reasonBuckets, classified.reason_buckets);
      mergeReasonBuckets_(feedBucket, classified.reason_buckets);
      mergeCountMap_(unsupportedDomainByHost, classified.unsupported_domain_by_host);
      mergeCountMap_(feedSummary.unsupported_domain_by_host, classified.unsupported_domain_by_host);
      pushRejectedSamples_(rejectedUrlSamples, classified.rejected_url_samples, sampleLimit);
      pushRejectedSamples_(feedSummary.rejected_url_samples, classified.rejected_url_samples, sampleLimit);
      pushUniqueLimited_(feedSummary.sample_candidates, classified.sample_candidates, sampleLimit);

      let ingestData = null;
      if (!supported.length) {
        skippedEmpty += 1;
        ignored += 1;
      } else if (!ingestEnabled) {
        // Diagnostics can disable ingest to run pure classification checks.
      } else {
        try {
          const emailText = `${String(item.title || "").trim()}\n\n${String(item.summary || "").trim()}`.slice(0, 6000);
          ingestData = await ingestFn({
            raw_urls: supported.map((x) => x.job_url),
            email_text: emailText,
            email_html: "",
            email_subject: String(item.title || "").slice(0, 300),
            email_from: `rss:${feedHost}`,
          });
          ingestedCount += 1;
          reasonBuckets.ingested += 1;
          feedBucket.ingested += 1;
        } catch {
          blockedOrFailedFetch += 1;
          ignored += 1;
        }
      }

      if (ingestData) {
        insertedOrUpdated += numOr0_(ingestData.inserted_or_updated);
        insertedCount += numOr0_(ingestData.inserted_count);
        updatedCount += numOr0_(ingestData.updated_count);
        ignored += numOr0_(ingestData.ignored);
        linkOnly += numOr0_(ingestData.link_only);

        mergeSourceSummary_(sourceSummary, ingestData?.source_summary, ingestData?.results, supported);

        const keys = Array.isArray(ingestData?.results)
          ? ingestData.results.map((r) => String(r?.job_key || "").trim()).filter(Boolean)
          : [];
        for (const k of keys) {
          if (resultsSample.length >= 5) break;
          if (resultsSample.includes(k)) continue;
          resultsSample.push(k);
        }
      }
    }

    feedSummaries.push(feedSummary);
  }

  return {
    run_id: runId,
    ts,
    feeds_total: feedsTotal,
    feeds_processed: feedsProcessed,
    feeds_failed: feedsFailed,
    max_per_run: maxItems,
    items_listed: itemsListed,
    processed,
    skipped_empty: skippedEmpty,
    blocked_or_failed_fetch: blockedOrFailedFetch,
    allow_keywords_count: allow.length,
    block_keywords_count: block.length,
    items_filtered_allow: itemsFilteredAllow,
    items_filtered_block: itemsFilteredBlock,
    urls_found_total: urlsFoundTotal,
    urls_unique_total: urlsUnique.size,
    urls_job_domains_total: urlsJobDomainsTotal,
    ignored_domains_count: ignoredDomainsCount,
    ingested_count: ingestedCount,
    inserted_or_updated: insertedOrUpdated,
    inserted_count: insertedCount,
    updated_count: updatedCount,
    ignored,
    link_only: linkOnly,
    reason_buckets: reasonBuckets,
    unsupported_domain_by_host: unsupportedDomainByHost,
    rejected_url_samples: rejectedUrlSamples,
    feed_summaries: feedSummaries,
    source_summary: Array.from(sourceSummary.values()).sort((a, b) => (b.total || 0) - (a.total || 0)),
    results_sample: resultsSample,
    mode,
  };
}

async function classifyRssJobUrlsDetailed_(urls, normalizeFn, opts = {}) {
  const supported = [];
  const seenByKey = new Set();
  const seenByUrl = new Set();
  const sampleCandidates = [];
  const allowedDomains = new Set(["linkedin", "iimjobs", "naukri"]);
  const sampleLimit = clampInt_(opts.sampleLimit || 5, 1, 20);
  const reasonBuckets = createReasonBuckets_();
  const unsupportedDomainByHost = {};
  const rejectedUrlSamples = [];
  let ignoredDomains = 0;

  for (const raw of unique_(urls)) {
    const resolved = await buildResolvedCandidates_(raw, opts);
    const candidates = Array.isArray(resolved.candidates) ? resolved.candidates : [];

    let accepted = null;
    for (const candidate of candidates) {
      let norm = null;
      try {
        norm = await normalizeFn(candidate);
      } catch {
        norm = null;
      }

      if (!norm || norm.ignored || !norm.job_url) {
        reasonBuckets.normalize_ignored += 1;
        pushRejectedSample_(rejectedUrlSamples, "normalize_ignored", candidate, sampleLimit);
        continue;
      }

      const sourceDomain = normalizeSourceDomain_(norm.source_domain);
      if (!allowedDomains.has(sourceDomain)) {
        reasonBuckets.unsupported_domain += 1;
        incrMapCount_(unsupportedDomainByHost, hostFromUrl_(norm.job_url) || hostFromUrl_(candidate) || "unknown");
        pushRejectedSample_(rejectedUrlSamples, "unsupported_domain", norm.job_url || candidate, sampleLimit);
        continue;
      }

      accepted = {
        job_key: String(norm.job_key || "").trim() || null,
        job_url: String(norm.job_url || "").trim(),
        source_domain: sourceDomain,
      };
      break;
    }

    if (!accepted || !accepted.job_url) {
      if (resolved.wrapper_detected && !resolved.wrapper_resolved) {
        reasonBuckets.unresolved_wrapper += 1;
        pushRejectedSample_(rejectedUrlSamples, "unresolved_wrapper", raw, sampleLimit);
      }
      ignoredDomains += 1;
      continue;
    }

    if (accepted.job_key) {
      if (seenByKey.has(accepted.job_key)) {
        reasonBuckets.duplicate_candidate += 1;
        pushRejectedSample_(rejectedUrlSamples, "duplicate_candidate", accepted.job_url, sampleLimit);
        continue;
      }
      seenByKey.add(accepted.job_key);
    } else {
      if (seenByUrl.has(accepted.job_url)) {
        reasonBuckets.duplicate_candidate += 1;
        pushRejectedSample_(rejectedUrlSamples, "duplicate_candidate", accepted.job_url, sampleLimit);
        continue;
      }
      seenByUrl.add(accepted.job_url);
    }

    supported.push(accepted);
    if (sampleCandidates.length < sampleLimit && !sampleCandidates.includes(accepted.job_url)) {
      sampleCandidates.push(accepted.job_url);
    }
  }

  return {
    supported,
    ignored_domains_count: ignoredDomains,
    reason_buckets: reasonBuckets,
    unsupported_domain_by_host: unsupportedDomainByHost,
    rejected_url_samples: rejectedUrlSamples,
    sample_candidates: sampleCandidates,
  };
}

async function buildResolvedCandidates_(raw, opts = {}) {
  const maxCandidateAttempts = clampInt_(opts.maxCandidateAttempts || 12, 1, 50);
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const s = String(value || "").trim();
    if (!/^https?:\/\//i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const expanded = expandTrackingUrlCandidates_(raw);
  for (const c of expanded) add(c);

  const wrapperDetected = looksLikeGoogleNewsRssLink_(raw);
  let wrapperResolved = false;

  if (wrapperDetected) {
    const fromPath = extractUrlFromGoogleNewsWrapperPath_(raw);
    if (fromPath) {
      wrapperResolved = true;
      for (const c of expandTrackingUrlCandidates_(fromPath)) add(c);
    }

    const viaFetch = await resolveGoogleNewsRssLink_(raw, opts.resolverBudget);
    if (viaFetch) {
      wrapperResolved = true;
      for (const c of expandTrackingUrlCandidates_(viaFetch)) add(c);
    }
  }

  return {
    candidates: out.slice(0, maxCandidateAttempts),
    wrapper_detected: wrapperDetected,
    wrapper_resolved: wrapperResolved,
  };
}

function createReasonBuckets_() {
  return {
    unsupported_domain: 0,
    normalize_ignored: 0,
    unresolved_wrapper: 0,
    duplicate_candidate: 0,
    no_url_in_item: 0,
    ingested: 0,
  };
}

function mergeReasonBuckets_(target, source) {
  if (!target || !source) return;
  target.unsupported_domain += numOr0_(source.unsupported_domain);
  target.normalize_ignored += numOr0_(source.normalize_ignored);
  target.unresolved_wrapper += numOr0_(source.unresolved_wrapper);
  target.duplicate_candidate += numOr0_(source.duplicate_candidate);
  target.no_url_in_item += numOr0_(source.no_url_in_item);
  target.ingested += numOr0_(source.ingested);
}

function pushUniqueLimited_(target, values, limit) {
  const max = clampInt_(limit || 5, 1, 20);
  const arr = Array.isArray(values) ? values : [];
  for (const v of arr) {
    const s = String(v || "").trim();
    if (!s) continue;
    if (target.includes(s)) continue;
    if (target.length >= max) break;
    target.push(s);
  }
}

function pushRejectedSamples_(target, values, limit) {
  const max = clampInt_(limit || 5, 1, 20);
  const arr = Array.isArray(values) ? values : [];
  for (const row of arr) {
    if (target.length >= max) break;
    const reason = String(row?.reason || "").trim();
    const url = String(row?.url || "").trim();
    if (!reason || !/^https?:\/\//i.test(url)) continue;
    const exists = target.some((x) => String(x?.reason || "") === reason && String(x?.url || "") === url);
    if (exists) continue;
    target.push({ reason, url });
  }
}

function pushRejectedSample_(target, reason, url, limit) {
  const max = clampInt_(limit || 5, 1, 20);
  if (!Array.isArray(target) || target.length >= max) return;
  const r = String(reason || "").trim();
  const u = String(url || "").trim();
  if (!r || !/^https?:\/\//i.test(u)) return;
  const exists = target.some((x) => String(x?.reason || "") === r && String(x?.url || "") === u);
  if (exists) return;
  target.push({ reason: r, url: u });
}

function mergeCountMap_(target, source) {
  if (!target || !source) return;
  for (const [k, v] of Object.entries(source)) {
    const key = String(k || "").trim().toLowerCase();
    if (!key) continue;
    target[key] = numOr0_(target[key]) + numOr0_(v);
  }
}

function incrMapCount_(target, key, by = 1) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return;
  target[k] = numOr0_(target[k]) + numOr0_(by);
}

function parseFeedItems_(xml) {
  const items = [];
  const s = String(xml || "");

  const rssBlocks = s.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of rssBlocks) {
    const title = decodeHtmlEntities_(extractTag_(block, "title"));
    const link = decodeHtmlEntities_(extractTag_(block, "link"));
    const desc = decodeHtmlEntities_(extractTag_(block, "description") || extractTag_(block, "content:encoded"));
    items.push({
      title: String(title || "").trim(),
      link: String(link || "").trim(),
      summary: stripHtml_(desc).slice(0, 3000),
    });
  }

  const atomBlocks = s.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of atomBlocks) {
    const title = decodeHtmlEntities_(extractTag_(block, "title"));
    const link = decodeHtmlEntities_(extractAtomLink_(block));
    const desc = decodeHtmlEntities_(extractTag_(block, "summary") || extractTag_(block, "content"));
    items.push({
      title: String(title || "").trim(),
      link: String(link || "").trim(),
      summary: stripHtml_(desc).slice(0, 3000),
    });
  }

  return items.filter((x) => x.link || x.summary || x.title);
}

function collectItemUrls_(item) {
  const out = [];
  if (item?.link) out.push(String(item.link));
  const body = `${String(item?.title || "")}\n${String(item?.summary || "")}`;
  out.push(...extractUrls_(body));
  return unique_(out);
}

function extractTag_(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = String(block || "").match(re);
  if (!m || !m[1]) return "";
  return String(m[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();
}

function extractAtomLink_(block) {
  const b = String(block || "");
  const alt = b.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  if (alt && alt[1]) return alt[1];
  const any = b.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (any && any[1]) return any[1];
  return "";
}

function extractUrls_(text) {
  const s = String(text || "");
  const m = s.match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  return unique_(m.map((x) => x.replace(/[),.;]+$/g, "").trim()).filter(Boolean));
}

function expandTrackingUrlCandidates_(raw) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v || "").trim();
    if (!/^https?:\/\//i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  add(raw);

  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return out;
  }

  const candidateParams = [
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

  for (const k of candidateParams) {
    const val = u.searchParams.get(k);
    if (!val) continue;
    const decoded1 = decodeUrlSafely_(val);
    const decoded2 = decodeUrlSafely_(decoded1);
    add(decoded1);
    add(decoded2);
  }
  return out;
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

function looksLikeGoogleNewsRssLink_(url) {
  try {
    const u = new URL(String(url || ""));
    return u.hostname.toLowerCase().includes("news.google.") && /\/rss\/articles\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function extractUrlFromGoogleNewsWrapperPath_(url) {
  try {
    const decoded = decodeURIComponent(String(url || ""));
    const match = decoded.match(/https?:\/\/[^\s"'<>]+/i);
    if (!match || !match[0]) return "";
    return String(match[0]).replace(/[),.;]+$/g, "");
  } catch {
    return "";
  }
}

async function resolveGoogleNewsRssLink_(url, resolverBudget) {
  if (!resolverBudget || numOr0_(resolverBudget.remaining) <= 0) return "";
  resolverBudget.remaining = Math.max(0, numOr0_(resolverBudget.remaining) - 1);
  const timeoutMs = clampInt_(resolverBudget.timeoutMs || 3500, 500, 10000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(String(url || ""), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "JobOpsRSS/1.0 (+https://get-job.shivanand-shah94.workers.dev)",
      },
    });

    const finalUrl = String(res?.url || "").trim();
    if (/^https?:\/\//i.test(finalUrl) && !looksLikeGoogleNewsRssLink_(finalUrl)) return finalUrl;

    const body = String(await res.text());
    const extracted = extractFirstHttpUrl_(body);
    if (/^https?:\/\//i.test(extracted) && !looksLikeGoogleNewsRssLink_(extracted)) return extracted;
    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function extractFirstHttpUrl_(text) {
  const s = String(text || "");
  const m = s.match(/https?:\/\/[^\s"'<>]+/i);
  if (!m || !m[0]) return "";
  return String(m[0]).replace(/[),.;]+$/g, "");
}

function decodeHtmlEntities_(s) {
  return String(s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
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
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mergeSourceSummary_(acc, sourceSummary, ingestResults, supported) {
  const fromSummary = Array.isArray(sourceSummary) ? sourceSummary : [];
  if (fromSummary.length) {
    for (const row of fromSummary) {
      const source = normalizeSourceDomain_(row?.source_domain);
      const item = acc.get(source) || baseSourceSummary_(source);
      item.total += numOr0_(row?.total);
      item.recovered += numOr0_(row?.recovered);
      item.manual_needed += numOr0_(row?.manual_needed);
      item.needs_ai += numOr0_(row?.needs_ai);
      item.blocked += numOr0_(row?.blocked);
      item.low_quality += numOr0_(row?.low_quality);
      item.link_only += numOr0_(row?.link_only);
      item.ignored += numOr0_(row?.ignored);
      item.inserted += numOr0_(row?.inserted);
      item.updated += numOr0_(row?.updated);
      acc.set(source, item);
    }
    return;
  }

  const fallbackRows = Array.isArray(ingestResults) ? ingestResults : [];
  for (const row of fallbackRows) {
    const source = normalizeSourceDomain_(
      row?.source_domain ||
      supported?.find((x) => String(x?.job_url || "") === String(row?.job_url || ""))?.source_domain
    );
    const item = acc.get(source) || baseSourceSummary_(source);
    item.total += 1;
    const action = String(row?.action || "").toLowerCase();
    const status = String(row?.status || "").toUpperCase();
    const fallbackReason = String(row?.fallback_reason || "").toLowerCase();
    if (action === "inserted") item.inserted += 1;
    if (action === "updated") item.updated += 1;
    if (action === "ignored") item.ignored += 1;
    if (status === "LINK_ONLY" || action === "link_only") item.link_only += 1;
    if (fallbackReason === "manual_required") item.manual_needed += 1;
    if (fallbackReason === "low_quality") item.low_quality += 1;
    if (fallbackReason === "blocked") item.blocked += 1;
    if (action !== "ignored" && status !== "LINK_ONLY") item.recovered += 1;
    acc.set(source, item);
  }
}

function baseSourceSummary_(source) {
  return {
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
}

function hostFromUrl_(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeSourceDomain_(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw.includes("linkedin")) return "linkedin";
  if (raw.includes("iimjobs")) return "iimjobs";
  if (raw.includes("naukri")) return "naukri";
  return raw.replace(/^www\./, "");
}

function parseKeywordList_(input) {
  if (Array.isArray(input)) {
    return unique_(
      input
        .map((x) => String(x || "").trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return unique_(
    String(input || "")
      .split(/\r?\n|,/g)
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function containsAnyKeyword_(text, keywords) {
  const t = String(text || "").toLowerCase();
  for (const kw of keywords || []) {
    if (!kw) continue;
    if (t.includes(String(kw))) return true;
  }
  return false;
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

function clampInt_(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function numOr0_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

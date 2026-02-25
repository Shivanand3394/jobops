export async function pollRssFeedsAndIngest_(env, { feeds, maxPerRun, ingestFn, normalizeFn, allowKeywords, blockKeywords }) {
  if (typeof ingestFn !== "function") throw new Error("ingestFn is required");
  if (typeof normalizeFn !== "function") throw new Error("normalizeFn is required");

  const runId = crypto.randomUUID();
  const ts = Date.now();
  const feedList = unique_(
    (Array.isArray(feeds) ? feeds : [])
      .map((x) => String(x || "").trim())
      .filter((x) => /^https?:\/\//i.test(x))
  );
  const maxItems = clampInt_(maxPerRun || env.RSS_MAX_PER_RUN || 25, 1, 200);
  const allow = parseKeywordList_(allowKeywords ?? env.RSS_ALLOW_KEYWORDS);
  const block = parseKeywordList_(blockKeywords ?? env.RSS_BLOCK_KEYWORDS);

  let feedsTotal = feedList.length;
  let feedsProcessed = 0;
  let feedsFailed = 0;
  let itemsListed = 0;
  let processed = 0;
  let itemsFilteredAllow = 0;
  let itemsFilteredBlock = 0;
  let skippedEmpty = 0;
  let blockedOrFailedFetch = 0;
  let insertedOrUpdated = 0;
  let insertedCount = 0;
  let updatedCount = 0;
  let ignored = 0;
  let linkOnly = 0;
  let urlsFoundTotal = 0;
  let urlsJobDomainsTotal = 0;
  let ignoredDomainsCount = 0;
  const urlsUnique = new Set();
  const resultsSample = [];
  const sourceSummary = new Map();

  for (const feedUrl of feedList) {
    if (processed >= maxItems) break;
    feedsProcessed += 1;

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
        continue;
      }
      xml = String(await res.text());
      if (!xml.trim()) {
        feedsFailed += 1;
        continue;
      }
    } catch {
      feedsFailed += 1;
      blockedOrFailedFetch += 1;
      continue;
    }

    const items = parseFeedItems_(xml);
    itemsListed += items.length;
    const feedHost = hostFromUrl_(feedUrl) || "unknown";

    for (const item of items) {
      if (processed >= maxItems) break;

      const textForFilter = `${String(item?.title || "")}\n${String(item?.summary || "")}`.toLowerCase();
      if (block.length && containsAnyKeyword_(textForFilter, block)) {
        processed += 1;
        itemsFilteredBlock += 1;
        continue;
      }
      if (allow.length && !containsAnyKeyword_(textForFilter, allow)) {
        processed += 1;
        itemsFilteredAllow += 1;
        continue;
      }

      const rawUrls = collectItemUrls_(item);
      urlsFoundTotal += rawUrls.length;
      for (const u of unique_(rawUrls)) urlsUnique.add(u);

      const classified = await classifyRssJobUrls_(rawUrls, normalizeFn);
      const supported = Array.isArray(classified.supported) ? classified.supported : [];
      urlsJobDomainsTotal += supported.length;
      ignoredDomainsCount += numOr0_(classified.ignored_domains_count);

      const emailText = `${String(item.title || "").trim()}\n\n${String(item.summary || "").trim()}`.slice(0, 6000);
      const ingestData = supported.length
        ? await ingestFn({
          raw_urls: supported.map((x) => x.job_url),
          email_text: emailText,
          email_html: "",
          email_subject: String(item.title || "").slice(0, 300),
          email_from: `rss:${feedHost}`,
        })
        : { inserted_or_updated: 0, inserted_count: 0, updated_count: 0, ignored: 1, link_only: 0, results: [] };

      processed += 1;
      if (!supported.length) skippedEmpty += 1;

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
    inserted_or_updated: insertedOrUpdated,
    inserted_count: insertedCount,
    updated_count: updatedCount,
    ignored,
    link_only: linkOnly,
    source_summary: Array.from(sourceSummary.values()).sort((a, b) => (b.total || 0) - (a.total || 0)),
    results_sample: resultsSample,
  };
}

async function classifyRssJobUrls_(urls, normalizeFn) {
  const supported = [];
  const seenByKey = new Set();
  const seenByUrl = new Set();
  const allowedDomains = new Set(["linkedin", "iimjobs", "naukri"]);
  let ignoredDomains = 0;

  for (const raw of unique_(urls)) {
    const candidates = expandTrackingUrlCandidates_(raw);
    let accepted = null;
    for (const candidate of candidates) {
      let norm = null;
      try {
        norm = await normalizeFn(candidate);
      } catch {
        norm = null;
      }
      if (!norm || norm.ignored || !norm.job_url) continue;
      const sourceDomain = normalizeSourceDomain_(norm.source_domain);
      if (!allowedDomains.has(sourceDomain)) continue;
      accepted = {
        job_key: String(norm.job_key || "").trim() || null,
        job_url: String(norm.job_url || "").trim(),
        source_domain: sourceDomain,
      };
      break;
    }

    if (!accepted || !accepted.job_url) {
      ignoredDomains += 1;
      continue;
    }

    if (accepted.job_key) {
      if (seenByKey.has(accepted.job_key)) continue;
      seenByKey.add(accepted.job_key);
    } else {
      if (seenByUrl.has(accepted.job_url)) continue;
      seenByUrl.add(accepted.job_url);
    }
    supported.push(accepted);
  }

  return { supported, ignored_domains_count: ignoredDomains };
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
    const desc = decodeHtmlEntities_(
      extractTag_(block, "summary") || extractTag_(block, "content")
    );
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
    add(decodeUrlSafely_(val));
    add(decodeUrlSafely_(decodeUrlSafely_(val)));
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

function normalizeText_(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeList_(items) {
  const seen = new Set();
  const out = [];
  for (const item of (Array.isArray(items) ? items : [])) {
    const value = normalizeText_(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function toWords_(text) {
  return normalizeText_(text).split(" ").filter(Boolean);
}

function scoreKeywordOverlap_(text, keywords) {
  const src = normalizeText_(text);
  if (!src) return 0;
  let hits = 0;
  for (const keyword of normalizeList_(keywords)) {
    if (!keyword) continue;
    if (src.includes(keyword)) hits += 1;
  }
  return hits;
}

function clampInt_(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

function shouldRejectLowSignal_(ctx, cfg) {
  const role = normalizeText_(ctx.role_title);
  const jd = normalizeText_(ctx.jd_clean);
  if (role) return false;
  return jd.length < cfg.min_jd_chars;
}

function shouldRejectBlockedKeywords_(ctx, blockedKeywords) {
  const text = normalizeText_(`${ctx.role_title || ""}\n${ctx.jd_clean || ""}`);
  if (!text) return { reject: false, matched: [] };
  const matched = [];
  for (const keyword of normalizeList_(blockedKeywords)) {
    if (!keyword) continue;
    if (text.includes(keyword)) matched.push(keyword);
  }
  return { reject: matched.length > 0, matched };
}

function scoreTargetSignal_(ctx, target) {
  const roleText = normalizeText_(ctx.role_title);
  const jdText = normalizeText_(ctx.jd_clean);
  const seniorityText = normalizeText_(ctx.seniority);
  const locationText = normalizeText_(ctx.location);

  let score = 0;
  const roleTokens = toWords_(target.primaryRole || target.name || "").filter((x) => x.length >= 3);
  if (roleTokens.length) {
    const roleHits = roleTokens.filter((token) => roleText.includes(token) || jdText.includes(token)).length;
    score += clampInt_(Math.round((roleHits / roleTokens.length) * 50), 0, 50);
  }

  const mustHits = scoreKeywordOverlap_(jdText, target.must || []);
  score += clampInt_(mustHits * 8, 0, 24);

  const niceHits = scoreKeywordOverlap_(jdText, target.nice || []);
  score += clampInt_(niceHits * 3, 0, 12);

  const seniority = normalizeText_(target.seniorityPref);
  if (seniority && (seniorityText.includes(seniority) || jdText.includes(seniority))) score += 8;

  const location = normalizeText_(target.locationPref);
  if (location && (locationText.includes(location) || jdText.includes(location))) score += 6;

  return clampInt_(score, 0, 100);
}

function pickBestTarget_(ctx, targets) {
  let best = null;
  for (const target of (Array.isArray(targets) ? targets : [])) {
    const row = target && typeof target === "object" ? target : null;
    if (!row?.id) continue;
    const signal = scoreTargetSignal_(ctx, row);
    if (!best || signal > best.signal) best = { id: row.id, signal };
  }
  return best;
}

export function evaluateScoringHeuristics_(input = {}, options = {}) {
  const cfg = {
    min_jd_chars: clampInt_(options.min_jd_chars ?? 120, 60, 2000),
    min_target_signal: clampInt_(options.min_target_signal ?? 20, 0, 100),
    blocked_keywords: normalizeList_(options.blocked_keywords || []),
  };

  const ctx = {
    role_title: String(input.role_title || "").trim(),
    location: String(input.location || "").trim(),
    seniority: String(input.seniority || "").trim(),
    jd_clean: String(input.jd_clean || "").trim(),
  };

  const reasons = [];
  if (shouldRejectLowSignal_(ctx, cfg)) {
    reasons.push(`missing_core_text(min_jd_chars=${cfg.min_jd_chars})`);
  }

  const blocked = shouldRejectBlockedKeywords_(ctx, cfg.blocked_keywords);
  if (blocked.reject) {
    reasons.push(`blocked_keywords(${blocked.matched.slice(0, 5).join(",")})`);
  }

  const bestTarget = pickBestTarget_(ctx, options.targets || []);
  if (bestTarget && bestTarget.signal < cfg.min_target_signal) {
    reasons.push(`low_target_signal(${bestTarget.signal}<${cfg.min_target_signal})`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    best_target_id: bestTarget?.id || null,
    best_target_signal: Number.isFinite(Number(bestTarget?.signal)) ? Number(bestTarget.signal) : null,
    config: cfg,
  };
}


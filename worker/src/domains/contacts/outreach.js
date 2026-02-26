function safeText_(value, maxLen = 5000) {
  return String(value || "").trim().slice(0, maxLen);
}

function safeLower_(value) {
  return safeText_(value, 5000).toLowerCase();
}

function clampInt_(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

function normalizeChannel_(value) {
  const v = safeText_(value, 80).toUpperCase();
  if (v === "EMAIL") return "EMAIL";
  if (v === "OTHER") return "OTHER";
  return "LINKEDIN";
}

function firstName_(fullName) {
  const raw = safeText_(fullName, 240);
  if (!raw) return "";
  const first = raw.split(/\s+/g).filter(Boolean)[0] || "";
  return safeText_(first, 80);
}

function cleanLine_(text) {
  return safeText_(text, 500)
    .replace(/\s+/g, " ")
    .replace(/[;:,.!?]+$/g, "")
    .trim();
}

function truncateLine_(text, maxLen = 180) {
  const src = cleanLine_(text);
  if (src.length <= maxLen) return src;
  const cut = src.slice(0, maxLen).replace(/\s+\S*$/g, "").trim();
  return cut ? `${cut}...` : src.slice(0, maxLen);
}

function uniqueEvidence_(rows = [], max = 3) {
  const out = [];
  const seen = new Set();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const requirement = cleanLine_(row?.requirement_text || "");
    const evidence = cleanLine_(row?.evidence_text || "");
    if (!requirement && !evidence) continue;
    const key = safeLower_(requirement || evidence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      requirement: truncateLine_(requirement, 140),
      evidence: truncateLine_(evidence, 180),
      confidence: clampInt_(row?.confidence_score ?? 0, 0, 100),
      source: safeText_(row?.evidence_source || "", 80) || null,
    });
    if (out.length >= max) break;
  }
  return out;
}

function fallbackEvidenceFromJob_(job = {}) {
  const out = [];
  const reasonRaw = safeText_(job.reason_top_matches, 600);
  if (reasonRaw) {
    const first = reasonRaw
      .split(/[.;|]+/g)
      .map((x) => cleanLine_(x))
      .filter(Boolean)
      .slice(0, 2);
    for (const item of first) {
      out.push({
        requirement: item,
        evidence: "",
        confidence: 60,
        source: "reason_top_matches",
      });
    }
  }
  const must = Array.isArray(job.must_have_keywords) ? job.must_have_keywords : [];
  for (const kw of must.slice(0, 2)) {
    const item = cleanLine_(kw);
    if (!item) continue;
    out.push({
      requirement: item,
      evidence: "",
      confidence: 55,
      source: "must_keyword",
    });
  }
  return uniqueEvidence_(out, 3);
}

function channelLimit_(channel) {
  const normalized = normalizeChannel_(channel);
  if (normalized === "EMAIL") return 1200;
  if (normalized === "OTHER") return 900;
  return 550;
}

function truncateToLimit_(text, maxLen) {
  const src = safeText_(text, 10000);
  if (src.length <= maxLen) return src;
  const cut = src.slice(0, maxLen).replace(/\s+\S*$/g, "").trim();
  return cut ? `${cut}...` : src.slice(0, maxLen);
}

function deterministicDraft_(input = {}) {
  const channel = normalizeChannel_(input.channel);
  const job = input.job && typeof input.job === "object" ? input.job : {};
  const contact = input.contact && typeof input.contact === "object" ? input.contact : {};
  const profile = input.profile && typeof input.profile === "object" ? input.profile : {};
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];

  const contactFirst = firstName_(contact.name) || "there";
  const role = safeText_(job.role_title, 200) || "this role";
  const company = safeText_(job.company, 200) || "your team";
  const sender = safeText_(profile.sender_name || profile.name, 120) || "Candidate";
  const senderSummary = truncateLine_(safeText_(profile.summary, 350), 160);
  const top = evidence[0] || null;
  const second = evidence[1] || null;

  const signalA = top?.requirement
    ? `I noticed the role emphasizes ${top.requirement}`
    : `I noticed this role has a strong execution and cross-functional focus`;
  const signalB = second?.requirement
    ? `and ${second.requirement}`
    : "";
  const proof = top?.evidence
    ? `In my recent work, ${safeText_(top.evidence, 220)}.`
    : (senderSummary ? `${senderSummary}.` : "I have built similar outcomes and can share specifics quickly.");

  if (channel === "EMAIL") {
    const lines = [
      `Hi ${contactFirst},`,
      "",
      `I came across the ${role} opening at ${company}. ${signalA}${signalB ? ` ${signalB}` : ""}. ${proof}`,
      "",
      "If helpful, I can share a concise walkthrough of relevant wins and how they translate to your current priorities.",
      "",
      `Best,`,
      sender,
    ];
    return truncateToLimit_(lines.join("\n"), channelLimit_(channel));
  }

  const lines = [
    `Hi ${contactFirst} - saw the ${role} role at ${company}.`,
    `${signalA}${signalB ? ` ${signalB}` : ""}. ${proof}`,
    "Happy to share a quick, relevant walkthrough if useful.",
    `Thanks, ${sender}`,
  ];
  return truncateToLimit_(lines.join("\n"), channelLimit_(channel));
}

function buildPrompt_(input = {}) {
  const channel = normalizeChannel_(input.channel);
  const job = input.job && typeof input.job === "object" ? input.job : {};
  const contact = input.contact && typeof input.contact === "object" ? input.contact : {};
  const profile = input.profile && typeof input.profile === "object" ? input.profile : {};
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];

  const evidenceBlock = evidence.length
    ? evidence.map((e, idx) => {
      const req = safeText_(e?.requirement, 220);
      const ev = safeText_(e?.evidence, 260);
      return `${idx + 1}. requirement=${req || "-"} | candidate_evidence=${ev || "-"}`;
    }).join("\n")
    : "none";

  const limit = channelLimit_(channel);
  return `
You write concise recruiter outreach messages.
Output plain text only. No markdown. No lists. No placeholders.

Channel: ${channel}
Max chars: ${limit}
Tone: professional, direct, specific.
Goal: 2 short paragraphs that connect candidate wins to role needs.

Job:
- title: ${safeText_(job.role_title, 220) || "unknown"}
- company: ${safeText_(job.company, 220) || "unknown"}

Contact:
- name: ${safeText_(contact.name, 220) || "there"}
- title: ${safeText_(contact.title, 220) || "unknown"}

Candidate context:
- name: ${safeText_(profile.sender_name || profile.name, 220) || "Candidate"}
- summary: ${safeText_(profile.summary, 600) || "n/a"}

Evidence matches:
${evidenceBlock}

Constraints:
- Do not claim anything that is not in candidate context or evidence matches.
- Keep under max chars.
- Mention 1-2 concrete matches.
- End with a low-friction CTA.
`.trim();
}

function modelTextFromResult_(result) {
  return (
    result?.response ||
    result?.output ||
    result?.result ||
    result?.choices?.[0]?.message?.content ||
    ""
  );
}

function usageFromResult_(result) {
  const usage = result?.usage || result?.meta?.usage || {};
  const inTokens = clampInt_(usage.input_tokens ?? usage.prompt_tokens ?? 0, 0, 5_000_000);
  const outTokens = clampInt_(usage.output_tokens ?? usage.completion_tokens ?? 0, 0, 5_000_000);
  const total = clampInt_(usage.total_tokens ?? (inTokens + outTokens), 0, 5_000_000);
  return {
    input_tokens: inTokens,
    output_tokens: outTokens,
    total_tokens: total,
  };
}

export function normalizeOutreachChannel_(value) {
  return normalizeChannel_(value);
}

export async function draftOutreachMessage_(input = {}) {
  const channel = normalizeChannel_(input.channel);
  const job = input.job && typeof input.job === "object" ? input.job : {};
  const contact = input.contact && typeof input.contact === "object" ? input.contact : {};
  const profile = input.profile && typeof input.profile === "object" ? input.profile : {};
  const evidenceRows = Array.isArray(input.evidence_rows) ? input.evidence_rows : [];
  const ai = input.ai && typeof input.ai.run === "function" ? input.ai : null;

  let evidence = uniqueEvidence_(evidenceRows, 3);
  if (!evidence.length) {
    evidence = fallbackEvidenceFromJob_(job);
  }

  const fallback = deterministicDraft_({ channel, job, contact, profile, evidence });
  if (!ai) {
    return {
      ok: true,
      channel,
      draft: fallback,
      used_ai: false,
      model: null,
      usage: null,
      evidence,
    };
  }

  const prompt = buildPrompt_({ channel, job, contact, profile, evidence });
  try {
    const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: channel === "EMAIL" ? 300 : 220,
    });
    const textRaw = safeText_(modelTextFromResult_(result), 5000);
    const text = truncateToLimit_(textRaw, channelLimit_(channel));
    if (!text) {
      return {
        ok: true,
        channel,
        draft: fallback,
        used_ai: false,
        model: null,
        usage: null,
        evidence,
      };
    }
    return {
      ok: true,
      channel,
      draft: text,
      used_ai: true,
      model: "@cf/meta/llama-3.1-8b-instruct",
      usage: usageFromResult_(result),
      evidence,
    };
  } catch {
    return {
      ok: true,
      channel,
      draft: fallback,
      used_ai: false,
      model: null,
      usage: null,
      evidence,
    };
  }
}


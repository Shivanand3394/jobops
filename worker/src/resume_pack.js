export async function generateApplicationPack_({ env, ai, job, target, profile, renderer = "reactive_resume", controls = {} }) {
  const mustAll = arr_(job.must_have_keywords_json || job.must_have_keywords);
  const niceAll = arr_(job.nice_to_have_keywords_json || job.nice_to_have_keywords);
  const selectedKeywords = unique_(arr_(controls.selected_keywords || controls.selectedKeywords));
  const templateId = str_(controls.template_id || controls.templateId || "balanced") || "balanced";
  const atsTargetMode = str_(controls.ats_target_mode || controls.atsTargetMode || "all").toLowerCase() || "all";
  const enabledBlocks = normalizeEnabledBlocks_(controls.enabled_blocks || controls.enabledBlocks);
  const focusKeywords = selectedKeywords.length ? selectedKeywords : mustAll;
  const atsMust = (atsTargetMode === "selected_only" && selectedKeywords.length) ? selectedKeywords : mustAll;
  const atsNice = (atsTargetMode === "selected_only" && selectedKeywords.length) ? [] : niceAll;
  const profileJson = safeJsonObj_(profile?.profile_json) || {};

  const role = str_(job.role_title) || "Role";
  const company = str_(job.company) || "Company";
  const location = str_(job.location) || "";
  const summaryBase = buildTailoredSummary_({ role, company, location, must: focusKeywords, profileJson });
  const bulletsBase = buildTailoredBullets_({ role, company, must: focusKeywords, nice: niceAll, profileJson });

  let tailoredSummary = summaryBase;
  let tailoredBullets = bulletsBase;
  let status = "DRAFT_READY";
  let errorText = "";

  if (!ai) {
    status = "NEEDS_AI";
  } else {
    const polished = await polishWithAi_(ai, summaryBase, bulletsBase).catch(() => null);
    if (polished) {
      tailoredSummary = str_(polished.summary) || summaryBase;
      tailoredBullets = Array.isArray(polished.bullets) && polished.bullets.length ? polished.bullets.map(str_).filter(Boolean) : bulletsBase;
    }
  }

  if (!enabledBlocks.has("summary")) tailoredSummary = "";
  if (!enabledBlocks.has("bullets")) tailoredBullets = [];

  const atsText = `${tailoredSummary}\n${tailoredBullets.join("\n")}`.trim() || `${role}\n${company}\n${location}`.trim();
  const keywordCoverage = computeKeywordCoverage_(atsMust, atsNice, atsText);
  const atsJson = {
    score: keywordCoverage.score,
    missing_keywords: keywordCoverage.missing,
    coverage: keywordCoverage.coverage,
    notes: keywordCoverage.notes,
  };

  const extracted = {
    role_title: str_(job.role_title),
    company: str_(job.company),
    location: str_(job.location),
    seniority: str_(job.seniority),
    final_score: num_(job.final_score),
    reason_top_matches: str_(job.reason_top_matches),
  };

  const packJson = {
    job: {
      job_key: str_(job.job_key),
      job_url: str_(job.job_url),
      source_domain: str_(job.source_domain),
      status: str_(job.status),
    },
    target: target || null,
    extracted,
    tailoring: {
      summary: tailoredSummary,
      bullets: tailoredBullets,
      must_keywords: atsMust,
      nice_keywords: atsNice,
    },
    controls: {
      template_id: templateId,
      enabled_blocks: Array.from(enabledBlocks),
      selected_keywords: selectedKeywords,
      ats_target_mode: atsTargetMode,
    },
    renderer,
  };

  const rrExport = toReactiveResumeExport_(profileJson, packJson, { enabledBlocks, templateId });
  return {
    status,
    error_text: errorText,
    pack_json: packJson,
    ats_json: atsJson,
    rr_export_json: rrExport,
    ats_score: keywordCoverage.score,
  };
}

export async function persistResumeDraft_({ env, jobKey, profileId, pack, force }) {
  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT id, status FROM resume_drafts WHERE job_key = ? AND profile_id = ? LIMIT 1;`
  ).bind(jobKey, profileId).first();

  const id = existing?.id || crypto.randomUUID();
  if (existing && !force) {
    await env.DB.prepare(`
      UPDATE resume_drafts
      SET pack_json = ?, ats_json = ?, rr_export_json = ?, status = ?, error_text = ?, updated_at = ?
      WHERE id = ?;
    `.trim()).bind(
      JSON.stringify(pack.pack_json),
      JSON.stringify(pack.ats_json),
      JSON.stringify(pack.rr_export_json),
      str_(pack.status) || "DRAFT_READY",
      str_(pack.error_text),
      now,
      id
    ).run();
    return { draft_id: id };
  }

  await env.DB.prepare(`
    INSERT INTO resume_drafts (
      id, job_key, profile_id, pack_json, ats_json, rr_export_json, status, error_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_key, profile_id) DO UPDATE SET
      pack_json = excluded.pack_json,
      ats_json = excluded.ats_json,
      rr_export_json = excluded.rr_export_json,
      status = excluded.status,
      error_text = excluded.error_text,
      updated_at = excluded.updated_at;
  `.trim()).bind(
    id,
    jobKey,
    profileId,
    JSON.stringify(pack.pack_json),
    JSON.stringify(pack.ats_json),
    JSON.stringify(pack.rr_export_json),
    str_(pack.status) || "DRAFT_READY",
    str_(pack.error_text),
    now,
    now
  ).run();

  return { draft_id: id };
}

export async function ensurePrimaryProfile_(env) {
  const row = await env.DB.prepare(
    `SELECT id, name, profile_json, updated_at FROM resume_profiles ORDER BY updated_at DESC LIMIT 1;`
  ).first();
  if (row) return row;

  const now = Date.now();
  const profile = {
    id: "primary",
    name: "Primary",
    profile_json: JSON.stringify({
      basics: { name: "", email: "", phone: "", location: "" },
      summary: "",
      experience: [],
      skills: [],
    }),
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(`
    INSERT INTO resume_profiles (id, name, profile_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?);
  `.trim()).bind(profile.id, profile.name, profile.profile_json, now, now).run();
  return profile;
}

function computeKeywordCoverage_(must, nice, text) {
  const low = str_(text).toLowerCase();
  const mustClean = unique_(must.map((x) => str_(x).toLowerCase()).filter(Boolean));
  const niceClean = unique_(nice.map((x) => str_(x).toLowerCase()).filter(Boolean));

  const mustHit = mustClean.filter((k) => low.includes(k));
  const niceHit = niceClean.filter((k) => low.includes(k));
  const missing = mustClean.filter((k) => !mustHit.includes(k));

  const mustScore = mustClean.length ? Math.round((mustHit.length / mustClean.length) * 100) : 100;
  const niceScore = niceClean.length ? Math.round((niceHit.length / niceClean.length) * 100) : 60;
  const score = Math.max(0, Math.min(100, Math.round((mustScore * 0.7) + (niceScore * 0.3))));

  return {
    score,
    missing,
    coverage: {
      must_total: mustClean.length,
      must_hit: mustHit.length,
      nice_total: niceClean.length,
      nice_hit: niceHit.length,
    },
    notes: missing.length ? `Add evidence for: ${missing.slice(0, 8).join(", ")}` : "Good keyword coverage",
  };
}

function buildTailoredSummary_({ role, company, location, must, profileJson }) {
  const profileSummary = str_(profileJson?.summary);
  const focus = must.slice(0, 5).join(", ");
  const where = location ? ` based in ${location}` : "";
  return [
    profileSummary || "Results-driven professional with experience delivering measurable business outcomes.",
    `Targeting ${role} at ${company}${where}.`,
    focus ? `Core strengths aligned: ${focus}.` : "",
  ].filter(Boolean).join(" ");
}

function buildTailoredBullets_({ role, company, must, nice, profileJson }) {
  const profileExp = Array.isArray(profileJson?.experience) ? profileJson.experience : [];
  const expBullets = profileExp
    .slice(0, 2)
    .map((e) => str_(e?.summary || e?.highlights?.[0] || e?.position))
    .filter(Boolean);
  const keyMust = must.slice(0, 4);
  const keyNice = nice.slice(0, 3);

  const generated = [
    `Align achievements to ${role} expectations at ${company}.`,
    keyMust.length ? `Demonstrate hands-on delivery across: ${keyMust.join(", ")}.` : "",
    keyNice.length ? `Supplementary strengths: ${keyNice.join(", ")}.` : "",
    "Quantify impact using metrics (revenue, efficiency, adoption, or quality).",
  ].filter(Boolean);
  return unique_([...expBullets, ...generated]).slice(0, 8);
}

function toReactiveResumeExport_(profileJson, packJson, opts = {}) {
  const basics = profileJson?.basics || {};
  const experience = Array.isArray(profileJson?.experience) ? profileJson.experience : [];
  const skills = Array.isArray(profileJson?.skills) ? profileJson.skills : [];
  const bullets = Array.isArray(packJson?.tailoring?.bullets) ? packJson.tailoring.bullets : [];
  const enabledBlocks = normalizeEnabledBlocks_(opts.enabledBlocks);
  const includeSummary = enabledBlocks.has("summary");
  const includeExperience = enabledBlocks.has("experience");
  const includeSkills = enabledBlocks.has("skills");
  const includeHighlights = enabledBlocks.has("highlights");
  const templateId = str_(opts.templateId || packJson?.controls?.template_id || "balanced") || "balanced";

  return {
    metadata: {
      source: "jobops",
      exported_at: Date.now(),
      version: 1,
      template_id: templateId,
    },
    basics: {
      name: str_(basics.name),
      email: str_(basics.email),
      phone: str_(basics.phone),
      location: str_(basics.location),
      summary: includeSummary ? str_(packJson?.tailoring?.summary) : "",
    },
    sections: {
      experience: includeExperience ? experience : [],
      skills: includeSkills ? skills : [],
      highlights: includeHighlights ? bullets.map((x) => ({ text: str_(x) })).filter((x) => x.text) : [],
    },
    job_context: {
      job_key: str_(packJson?.job?.job_key),
      role_title: str_(packJson?.extracted?.role_title),
      company: str_(packJson?.extracted?.company),
      job_url: str_(packJson?.job?.job_url),
    },
  };
}

async function polishWithAi_(ai, summary, bullets) {
  const prompt = `
Rewrite resume tailoring content in concise professional tone.
Return STRICT JSON only:
{"summary": "...", "bullets": ["...", "..."]}
Summary max 90 words. Keep bullets to 3-6 and preserve facts.
INPUT SUMMARY: ${summary}
INPUT BULLETS: ${JSON.stringify(bullets)}
  `.trim();
  const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });
  const raw = pickModelText_(result);
  return safeJsonObj_(raw);
}

function safeJsonObj_(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    const s = String(v || "").trim();
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i === -1 || j === -1 || j <= i) return null;
    return JSON.parse(s.slice(i, j + 1));
  } catch {
    return null;
  }
}

function arr_(v) {
  if (Array.isArray(v)) return v.map(str_).filter(Boolean);
  try {
    const parsed = JSON.parse(String(v || "[]"));
    return Array.isArray(parsed) ? parsed.map(str_).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeEnabledBlocks_(v) {
  const allowed = ["summary", "experience", "skills", "highlights", "bullets"];
  const set = new Set(
    (Array.isArray(v) ? v : [])
      .map((x) => str_(x).toLowerCase())
      .filter((x) => allowed.includes(x))
  );
  if (!set.size) {
    for (const block of allowed) set.add(block);
  }
  return set;
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

function unique_(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = str_(x);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function str_(v) {
  return String(v || "").trim();
}

function num_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

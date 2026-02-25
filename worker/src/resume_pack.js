export const RR_EXPORT_CONTRACT_ID = "jobops.rr_export.v1";
export const RR_EXPORT_SCHEMA_VERSION = 1;

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
  const targetRubric = computeTargetRubric_({
    target,
    roleTitle: role,
    location,
    seniority: str_(job.seniority),
    must: atsMust,
    nice: atsNice,
    text: atsText,
    keywordCoverage,
  });
  const atsJson = {
    score: keywordCoverage.score,
    missing_keywords: keywordCoverage.missing,
    coverage: keywordCoverage.coverage,
    notes: keywordCoverage.notes,
    target_rubric: targetRubric,
    // Backward-compat: keep pm_rubric for existing UI/clients when PM template applies.
    pm_rubric: targetRubric?.template_id === "pm_v1"
      ? targetRubric
      : {
        applicable: false,
        score: null,
        dimensions: [],
        missing_evidence: [],
        notes: "Non-PM target rubric in use.",
      },
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

  const rrExportRaw = toReactiveResumeExport_(profileJson, packJson, { enabledBlocks, templateId });
  const rrExport = ensureReactiveResumeExportContract_(rrExportRaw, {
    jobKey: str_(job.job_key),
    templateId,
  });

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
  const packSafe = pack && typeof pack === "object" ? pack : {};
  const renderer = str_(packSafe?.pack_json?.renderer || "reactive_resume").toLowerCase() || "reactive_resume";
  const rrExport = ensureReactiveResumeExportContract_(packSafe.rr_export_json, {
    jobKey: str_(jobKey),
    templateId: str_(packSafe?.pack_json?.controls?.template_id) || "balanced",
  });
  const rrValidation = validateReactiveResumeExport_(rrExport);
  const rrImport = validateReactiveResumeImportReadiness_(rrExport);
  const hasRrIssues = !rrValidation.ok || !rrImport.ok;
  const statusFromPack = str_(packSafe.status) || "DRAFT_READY";
  const statusSafe =
    statusFromPack === "NEEDS_AI"
      ? "NEEDS_AI"
      : (renderer === "reactive_resume" && hasRrIssues ? "ERROR" : statusFromPack);
  const rrIssues = unique_([...(rrValidation.errors || []), ...(rrImport.errors || [])]);
  const issuePrefix = rrIssues.length
    ? (renderer === "reactive_resume"
      ? `RR export invalid: ${rrIssues.join("; ")}`
      : `RR warnings: ${rrIssues.join("; ")}`)
    : "";
  const errorTextSafe = [issuePrefix, str_(packSafe.error_text)].filter(Boolean).join(" | ").slice(0, 1000);

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
      JSON.stringify(packSafe.pack_json || {}),
      JSON.stringify(packSafe.ats_json || {}),
      JSON.stringify(rrExport),
      statusSafe,
      errorTextSafe,
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
    JSON.stringify(packSafe.pack_json || {}),
    JSON.stringify(packSafe.ats_json || {}),
    JSON.stringify(rrExport),
    statusSafe,
    errorTextSafe,
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

function computeTargetRubric_({
  target = null,
  roleTitle = "",
  location = "",
  seniority = "",
  must = [],
  nice = [],
  text = "",
  keywordCoverage = null,
} = {}) {
  const targetObj = target && typeof target === "object" ? target : {};
  const targetId = str_(targetObj.id);
  const targetName = str_(targetObj.name);
  const targetRole = str_(targetObj.primaryRole || targetObj.primary_role);
  const rubricProfile = normalizeRubricProfile_(targetObj.rubricProfile || targetObj.rubric_profile || "auto");
  const roleCombined = `${str_(roleTitle)} ${targetRole}`.toLowerCase();
  const isPmTarget =
    /product manager|product management|product owner|group product manager|senior product manager|technical product manager|\bpm\b/.test(roleCombined);
  const usePmTemplate = rubricProfile === "pm_v1" || (rubricProfile === "auto" && isPmTarget);

  if (usePmTemplate) {
    const pm = computePmRubric_({ roleTitle, targetRole, text });
    return {
      ...pm,
      template_id: "pm_v1",
      rubric_profile: rubricProfile,
      target_id: targetId || null,
      target_name: targetName || null,
      target_role: targetRole || null,
    };
  }

  const low = str_(text).toLowerCase();
  const mustClean = unique_(must.map((x) => str_(x).toLowerCase()).filter(Boolean));
  const niceClean = unique_(nice.map((x) => str_(x).toLowerCase()).filter(Boolean));
  const mustHit = mustClean.filter((k) => low.includes(k));
  const niceHit = niceClean.filter((k) => low.includes(k));
  const roleKeywords = unique_(
    targetRole
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((x) => x.trim())
      .filter((x) => x.length >= 3 && !["and", "the", "for", "with", "role", "lead", "senior"].includes(x))
  ).slice(0, 8);
  const roleHits = roleKeywords.filter((k) => low.includes(k));

  const cov = keywordCoverage && typeof keywordCoverage === "object" ? keywordCoverage : {};
  const mustCovPct = Number.isFinite(Number(cov?.coverage?.must_total)) && Number(cov.coverage.must_total) > 0
    ? Math.round((Number(cov.coverage.must_hit || 0) / Number(cov.coverage.must_total || 1)) * 100)
    : (mustClean.length ? Math.round((mustHit.length / mustClean.length) * 100) : 100);
  const niceCovPct = Number.isFinite(Number(cov?.coverage?.nice_total)) && Number(cov.coverage.nice_total) > 0
    ? Math.round((Number(cov.coverage.nice_hit || 0) / Number(cov.coverage.nice_total || 1)) * 100)
    : (niceClean.length ? Math.round((niceHit.length / niceClean.length) * 100) : 60);
  const roleFitPct = roleKeywords.length ? Math.round((roleHits.length / Math.max(1, Math.min(roleKeywords.length, 4))) * 100) : 60;

  const targetSeniority = str_(targetObj.seniorityPref || targetObj.seniority_pref).toLowerCase();
  const jobSeniority = str_(seniority).toLowerCase();
  const seniorityOk = !targetSeniority || !jobSeniority || jobSeniority.includes(targetSeniority) || targetSeniority.includes(jobSeniority);
  const targetLocation = str_(targetObj.locationPref || targetObj.location_pref).toLowerCase();
  const jobLocation = str_(location).toLowerCase();
  const locationOk = !targetLocation || !jobLocation || jobLocation.includes(targetLocation) || targetLocation.includes(jobLocation);
  const fitScore = seniorityOk && locationOk ? 100 : ((seniorityOk || locationOk) ? 70 : 40);

  const dimensions = [
    {
      id: "must_coverage",
      label: "Must-have coverage",
      score: Math.max(0, Math.min(100, mustCovPct)),
      hit_count: mustHit.length,
      total: mustClean.length,
      evidence: mustHit.slice(0, 8),
      missing_evidence: mustClean.filter((k) => !mustHit.includes(k)).slice(0, 6),
    },
    {
      id: "nice_coverage",
      label: "Nice-to-have coverage",
      score: Math.max(0, Math.min(100, niceCovPct)),
      hit_count: niceHit.length,
      total: niceClean.length,
      evidence: niceHit.slice(0, 8),
      missing_evidence: niceClean.filter((k) => !niceHit.includes(k)).slice(0, 6),
    },
    {
      id: "role_language",
      label: "Role language fit",
      score: Math.max(0, Math.min(100, roleFitPct)),
      hit_count: roleHits.length,
      total: roleKeywords.length,
      evidence: roleHits.slice(0, 8),
      missing_evidence: roleKeywords.filter((k) => !roleHits.includes(k)).slice(0, 6),
    },
    {
      id: "profile_fit",
      label: "Target profile fit (seniority/location)",
      score: fitScore,
      hit_count: Number(seniorityOk) + Number(locationOk),
      total: 2,
      evidence: [seniorityOk ? "seniority_fit" : "", locationOk ? "location_fit" : ""].filter(Boolean),
      missing_evidence: [seniorityOk ? "" : "seniority_fit", locationOk ? "" : "location_fit"].filter(Boolean),
    },
  ];

  const score = dimensions.length
    ? Math.round(dimensions.reduce((acc, d) => acc + Number(d.score || 0), 0) / dimensions.length)
    : null;
  const missingEvidence = dimensions
    .flatMap((d) => (d.missing_evidence || []).map((m) => `${d.label}: ${m}`))
    .slice(0, 12);

  return {
    template_id: "target_generic_v1",
    rubric_profile: rubricProfile,
    target_id: targetId || null,
    target_name: targetName || null,
    target_role: targetRole || null,
    applicable: true,
    score,
    dimensions,
    missing_evidence: missingEvidence,
    notes: score >= 70
      ? "Target rubric coverage looks strong."
      : "Improve missing evidence against selected target rubric.",
  };
}

function computePmRubric_({ roleTitle = "", targetRole = "", text = "" } = {}) {
  const roleCombined = `${str_(roleTitle)} ${str_(targetRole)}`.toLowerCase();
  const isPmLikeRole =
    /product manager|product management|product owner|group product manager|senior product manager|technical product manager|\bpm\b/.test(roleCombined);
  const low = str_(text).toLowerCase();

  const dimensions = [
    {
      id: "strategy",
      label: "Product Strategy",
      target_hits: 3,
      keywords: [
        "strategy", "vision", "roadmap", "prioritization", "market", "go-to-market", "business case",
      ],
    },
    {
      id: "discovery",
      label: "Discovery & Research",
      target_hits: 3,
      keywords: [
        "customer", "user research", "discovery", "problem statement", "persona", "journey", "feedback",
      ],
    },
    {
      id: "analytics",
      label: "Analytics & Experimentation",
      target_hits: 3,
      keywords: [
        "a/b", "experiment", "hypothesis", "funnel", "retention", "activation", "metric", "kpi", "sql", "analytics",
      ],
    },
    {
      id: "execution",
      label: "Delivery & Execution",
      target_hits: 3,
      keywords: [
        "prd", "requirements", "backlog", "agile", "scrum", "cross-functional", "launch", "delivery", "execution",
      ],
    },
    {
      id: "leadership",
      label: "Leadership & Influence",
      target_hits: 3,
      keywords: [
        "stakeholder", "influence", "alignment", "communication", "collaboration", "leadership", "mentoring",
      ],
    },
  ];

  const scoredDims = dimensions.map((d) => {
    const found = unique_((d.keywords || []).filter((k) => low.includes(String(k || "").toLowerCase())));
    const missing = (d.keywords || []).filter((k) => !found.includes(k)).slice(0, 4);
    const targetHits = Math.max(1, Number(d.target_hits || 3));
    const score = Math.max(0, Math.min(100, Math.round((found.length / targetHits) * 100)));
    return {
      id: d.id,
      label: d.label,
      score,
      hit_count: found.length,
      target_hits: targetHits,
      evidence: found.slice(0, 8),
      missing_evidence: missing,
    };
  });

  const avgScore = scoredDims.length
    ? Math.round(scoredDims.reduce((acc, d) => acc + Number(d.score || 0), 0) / scoredDims.length)
    : null;
  const missingEvidence = scoredDims
    .flatMap((d) => (d.missing_evidence || []).map((m) => `${d.label}: ${m}`))
    .slice(0, 10);

  return {
    applicable: isPmLikeRole,
    score: avgScore,
    dimensions: scoredDims,
    missing_evidence: missingEvidence,
    notes: isPmLikeRole
      ? (avgScore >= 70 ? "PM rubric coverage looks strong." : "Add stronger PM evidence in summary/bullets.")
      : "Role is not strongly PM-typed; rubric shown as guidance.",
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
      contract_id: RR_EXPORT_CONTRACT_ID,
      schema_version: RR_EXPORT_SCHEMA_VERSION,
      exported_at: Date.now(),
      version: 1,
      template_id: templateId,
      renderer: "reactive_resume",
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

export function ensureReactiveResumeExportContract_(value, ctx = {}) {
  const parsed = safeJsonObj_(value) || {};
  const metadataIn = safeJsonObj_(parsed.metadata) || {};
  const basicsIn = safeJsonObj_(parsed.basics) || {};
  const sectionsIn = safeJsonObj_(parsed.sections) || {};
  const jobIn = safeJsonObj_(parsed.job_context) || {};
  const highlightsIn = Array.isArray(sectionsIn.highlights) ? sectionsIn.highlights : [];

  const out = {
    metadata: {
      source: str_(metadataIn.source) || "jobops",
      contract_id: RR_EXPORT_CONTRACT_ID,
      schema_version: RR_EXPORT_SCHEMA_VERSION,
      version: RR_EXPORT_SCHEMA_VERSION,
      exported_at: num_(metadataIn.exported_at) || Date.now(),
      template_id: str_(metadataIn.template_id || ctx.templateId || "balanced") || "balanced",
      renderer: "reactive_resume",
    },
    basics: {
      name: str_(basicsIn.name),
      email: str_(basicsIn.email),
      phone: str_(basicsIn.phone),
      location: str_(basicsIn.location),
      summary: str_(basicsIn.summary),
    },
    sections: {
      experience: Array.isArray(sectionsIn.experience) ? sectionsIn.experience : [],
      skills: Array.isArray(sectionsIn.skills) ? sectionsIn.skills : [],
      highlights: highlightsIn
        .map((h) => (typeof h === "string" ? { text: str_(h) } : { text: str_(h?.text) }))
        .filter((h) => h.text),
    },
    job_context: {
      job_key: str_(jobIn.job_key || ctx.jobKey),
      role_title: str_(jobIn.role_title),
      company: str_(jobIn.company),
      job_url: str_(jobIn.job_url),
    },
  };

  const validation = validateReactiveResumeExport_(out);
  const importValidation = validateReactiveResumeImportReadiness_(out);
  out.metadata.contract_valid = validation.ok;
  if (!validation.ok) out.metadata.contract_errors = validation.errors.slice(0, 5);
  out.metadata.import_ready = importValidation.ok;
  if (!importValidation.ok) out.metadata.import_errors = importValidation.errors.slice(0, 10);
  return out;
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

function normalizeRubricProfile_(input) {
  const raw = str_(input).toLowerCase();
  if (!raw) return "auto";
  if (raw === "pm_v1" || raw === "target_generic_v1" || raw === "auto") return raw;
  if (raw === "pm" || raw === "product" || raw === "product_manager") return "pm_v1";
  if (raw === "generic" || raw === "target" || raw === "default") return "target_generic_v1";
  return "auto";
}

function num_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validateReactiveResumeExport_(rr) {
  const errors = [];
  const contractId = str_(rr?.metadata?.contract_id);
  const schemaVersion = num_(rr?.metadata?.schema_version);
  if (contractId !== RR_EXPORT_CONTRACT_ID) errors.push("contract_id_mismatch");
  if (schemaVersion !== RR_EXPORT_SCHEMA_VERSION) errors.push("schema_version_mismatch");
  if (!str_(rr?.job_context?.job_key)) errors.push("missing_job_key");
  if (!rr?.sections || typeof rr.sections !== "object") errors.push("missing_sections");
  return { ok: errors.length === 0, errors };
}

function validateReactiveResumeImportReadiness_(rr) {
  const errors = [];
  const basics = rr?.basics;
  const sections = rr?.sections;
  const jobContext = rr?.job_context;

  if (!basics || typeof basics !== "object") {
    errors.push("missing_basics");
  } else {
    const requiredBasics = ["name", "email", "phone", "location", "summary"];
    for (const k of requiredBasics) {
      if (typeof basics[k] !== "string") errors.push(`basics_${k}_not_string`);
    }
  }

  if (!sections || typeof sections !== "object") {
    errors.push("missing_sections_object");
  } else {
    if (!Array.isArray(sections.experience)) errors.push("experience_not_array");
    if (!Array.isArray(sections.skills)) errors.push("skills_not_array");
    if (!Array.isArray(sections.highlights)) errors.push("highlights_not_array");

    const experience = Array.isArray(sections.experience) ? sections.experience : [];
    for (let i = 0; i < experience.length; i += 1) {
      const item = experience[i];
      if (!item || typeof item !== "object") {
        errors.push(`experience_item_invalid_${i}`);
      }
    }

    const highlights = Array.isArray(sections.highlights) ? sections.highlights : [];
    for (let i = 0; i < highlights.length; i += 1) {
      const h = highlights[i];
      if (!h || typeof h !== "object" || !str_(h.text)) {
        errors.push(`highlight_item_invalid_${i}`);
      }
    }
  }

  if (!jobContext || typeof jobContext !== "object") {
    errors.push("missing_job_context");
  } else if (!str_(jobContext.job_key)) {
    errors.push("missing_job_key");
  }

  return { ok: errors.length === 0, errors };
}

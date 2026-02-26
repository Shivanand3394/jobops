function escapeHtml_(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function cleanText_(value) {
  return String(value || "").trim();
}

function asArray_(value) {
  if (Array.isArray(value)) return value;
  if (!value && value !== 0) return [];
  return [value];
}

function pickFirstText_(values) {
  for (const candidate of values) {
    const text = cleanText_(candidate);
    if (text) return text;
  }
  return "";
}

function parseProfileJson_(profileRow) {
  const row = profileRow && typeof profileRow === "object" ? profileRow : {};
  const raw = row.profile_json;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function flattenProfileSkills_(profileJson) {
  const rootSkills = asArray_(profileJson.skills);
  const fromCategories = asArray_(profileJson.skill_categories).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    return asArray_(entry.keywords || entry.skills || entry.items || entry.values);
  });
  const fromRrSchema = asArray_(profileJson?.sections?.skills?.items).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    return asArray_(entry.keywords || entry.skills);
  });
  const items = [...rootSkills, ...fromCategories, ...fromRrSchema]
    .map((x) => cleanText_(typeof x === "string" ? x : (x?.name || x?.label || x?.keyword)))
    .filter(Boolean);
  return Array.from(new Set(items)).slice(0, 24);
}

function normalizeEvidence_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const requirementText = cleanText_(row?.requirement_text || row?.skill);
    const evidenceText = cleanText_(row?.evidence_text || row?.achievement || row?.notes);
    const requirementType = cleanText_(row?.requirement_type || row?.type).toLowerCase();
    const confidence = Number.isFinite(Number(row?.confidence_score)) ? Math.max(0, Math.min(100, Math.round(Number(row.confidence_score)))) : null;
    return {
      requirement_text: requirementText,
      evidence_text: evidenceText,
      requirement_type: requirementType,
      confidence_score: confidence,
    };
  }).filter((x) => x.requirement_text || x.evidence_text);
}

function collectHighlightTokens_(evidenceRows) {
  const stop = new Set([
    "and", "the", "for", "with", "from", "that", "this", "into", "using", "use", "used", "have", "has",
    "your", "their", "will", "team", "across", "years", "year", "plus", "role", "jobs", "work", "build",
    "built", "high", "level", "must", "nice", "good", "strong", "ability", "experience", "knowledge",
  ]);
  const bag = [];
  for (const row of evidenceRows) {
    const seed = `${row.requirement_text} ${row.evidence_text}`.toLowerCase();
    for (const token of seed.split(/[^a-z0-9+#.-]+/g)) {
      const t = token.trim();
      if (!t || t.length < 3) continue;
      if (stop.has(t)) continue;
      bag.push(t);
    }
  }
  const unique = Array.from(new Set(bag));
  return unique.slice(0, 18);
}

function normalizeExperience_(profileJson) {
  const base = asArray_(profileJson.experience);
  const rr = asArray_(profileJson?.sections?.experience?.items);
  const entries = [...base, ...rr].filter((x) => x && typeof x === "object");
  return entries.map((entry) => {
    const company = pickFirstText_([entry.company, entry.organization, entry.name]);
    const role = pickFirstText_([entry.role, entry.position, entry.title]);
    const start = pickFirstText_([entry.start_date, entry.startDate, entry.from, entry.date_start, entry.dateStart]);
    const end = pickFirstText_([entry.end_date, entry.endDate, entry.to, entry.date_end, entry.dateEnd]);
    const explicitRange = pickFirstText_([entry.date_range, entry.dateRange, entry.dates, entry.period]);
    const dateRange = explicitRange || [start, end].filter(Boolean).join(" - ");
    const bullets = [
      ...asArray_(entry.bullets),
      ...asArray_(entry.highlights),
      ...asArray_(entry.responsibilities),
      ...asArray_(entry.accomplishments),
    ]
      .map((x) => cleanText_(typeof x === "string" ? x : (x?.text || x?.value || x?.content)))
      .filter(Boolean)
      .slice(0, 6);
    const summary = pickFirstText_([entry.summary, entry.description]);
    return {
      company,
      role,
      date_range: dateRange,
      bullets,
      summary,
    };
  }).filter((x) => x.company || x.role || x.bullets.length);
}

function buildContactLine_(profileJson, profileRow) {
  const basics = profileJson?.basics && typeof profileJson.basics === "object" ? profileJson.basics : {};
  const email = pickFirstText_([basics.email, profileJson.email]);
  const phone = pickFirstText_([basics.phone, basics.phoneNumber, profileJson.phone]);
  const location = pickFirstText_([basics.location, profileJson.location]);
  const links = asArray_(basics.profiles).flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    return [x.url, x.link, x.username].map((v) => cleanText_(v)).filter(Boolean);
  }).slice(0, 1);
  const pieces = [email, phone, location, ...links].filter(Boolean);
  if (pieces.length) return pieces.join(" | ");
  const fallback = cleanText_(profileRow?.name);
  return fallback ? `${fallback} profile` : "";
}

function normalizeSummary_(profileJson, jobRow) {
  const base = pickFirstText_([
    profileJson.summary,
    profileJson?.basics?.summary,
    profileJson?.basics?.headline,
  ]);
  const role = cleanText_(jobRow?.role_title) || "the target role";
  const company = cleanText_(jobRow?.company) || "the target company";
  if (base) return base;
  return `Outcome-focused engineer with hands-on delivery experience, tailored for ${role} at ${company}.`;
}

function renderImpactRows_(evidenceRows) {
  if (!evidenceRows.length) {
    return `<li class="impact-item">No matched evidence yet. Run score and evidence rebuild first.</li>`;
  }
  return evidenceRows.slice(0, 8).map((row) => {
    const label = escapeHtml_(row.requirement_text || "Match");
    const detail = escapeHtml_(row.evidence_text || "Relevant evidence available.");
    const score = Number.isFinite(Number(row.confidence_score))
      ? `<span class="impact-score">${row.confidence_score}%</span>`
      : "";
    return `<li class="impact-item"><div class="impact-head"><strong>${label}</strong>${score}</div><div>${detail}</div></li>`;
  }).join("");
}

function renderExperience_(experienceRows, highlightTokens) {
  if (!experienceRows.length) {
    return `<div class="exp-item"><div class="exp-role">No experience entries in active profile.</div></div>`;
  }
  const tokens = Array.isArray(highlightTokens) ? highlightTokens : [];
  return experienceRows.map((exp) => {
    const bullets = exp.bullets.length
      ? exp.bullets.map((bullet) => {
        const low = bullet.toLowerCase();
        const hasHit = tokens.some((token) => low.includes(token));
        return `<li class="bullet${hasHit ? " bullet-hit" : ""}">${escapeHtml_(bullet)}</li>`;
      }).join("")
      : (exp.summary ? `<li class="bullet">${escapeHtml_(exp.summary)}</li>` : "");

    return `
      <div class="exp-item">
        <div class="exp-header">
          <span>${escapeHtml_(exp.company || "Company")}</span>
          <span>${escapeHtml_(exp.date_range || "")}</span>
        </div>
        <div class="exp-role">${escapeHtml_(exp.role || "")}</div>
        <ul class="bullets">${bullets}</ul>
      </div>
    `;
  }).join("");
}

export function generateProfessionalHtml(profileRow, jobRow, evidenceRows) {
  const profileJson = parseProfileJson_(profileRow);
  const evidence = normalizeEvidence_(evidenceRows);
  const experience = normalizeExperience_(profileJson);
  const skills = flattenProfileSkills_(profileJson);
  const highlightTokens = collectHighlightTokens_(evidence);

  const basics = profileJson?.basics && typeof profileJson.basics === "object" ? profileJson.basics : {};
  const name = pickFirstText_([basics.name, profileJson.name, profileRow?.name]) || "Candidate Name";
  const contactLine = buildContactLine_(profileJson, profileRow);
  const summary = normalizeSummary_(profileJson, jobRow);
  const role = cleanText_(jobRow?.role_title) || "Role";
  const company = cleanText_(jobRow?.company) || "Company";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml_(name)} - Resume</title>
  <style>
    @page { size: auto; margin: 0.5in; }
    * { box-sizing: border-box; }
    body {
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      line-height: 1.4;
      color: #1f2937;
      margin: 0;
      padding: 0;
      background: #ffffff;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    .page {
      max-width: 8.5in;
      margin: 0 auto;
      padding: 0.35in 0.45in;
    }
    .header {
      text-align: center;
      border-bottom: 2px solid #111827;
      padding-bottom: 10px;
      margin-bottom: 14px;
    }
    .name {
      font-size: 24pt;
      letter-spacing: 0.03em;
      font-weight: 700;
      margin: 0;
      text-transform: uppercase;
      color: #111827;
    }
    .contact {
      margin-top: 6px;
      font-size: 9pt;
      color: #4b5563;
      word-break: break-word;
    }
    .section-title {
      margin-top: 14px;
      margin-bottom: 8px;
      font-size: 9pt;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 700;
      color: #1d4ed8;
      border-bottom: 1px solid #d1d5db;
      padding-bottom: 3px;
    }
    .summary {
      margin: 0;
      font-size: 10.5pt;
      color: #111827;
    }
    .impact-list {
      margin: 0;
      padding: 10px 12px;
      list-style: none;
      background: #f8fafc;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .impact-item {
      font-size: 10pt;
      color: #111827;
    }
    .impact-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 2px;
    }
    .impact-score {
      font-size: 8.5pt;
      color: #2563eb;
      font-weight: 700;
      white-space: nowrap;
    }
    .exp-item {
      margin-bottom: 10px;
      page-break-inside: avoid;
    }
    .exp-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      font-size: 10.5pt;
      font-weight: 700;
      color: #111827;
    }
    .exp-role {
      font-size: 9.75pt;
      font-style: italic;
      color: #374151;
      margin-top: 1px;
    }
    .bullets {
      margin: 6px 0 0 18px;
      padding: 0;
      font-size: 9.5pt;
    }
    .bullet {
      margin: 4px 0;
    }
    .bullet-hit {
      color: #0f3b9f;
      font-weight: 600;
    }
    .skills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .skill-chip {
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 8.5pt;
      color: #374151;
      background: #f9fafb;
    }
    .meta-note {
      margin-top: 8px;
      font-size: 8pt;
      color: #6b7280;
    }
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .impact-list { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .page { padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="header">
      <h1 class="name">${escapeHtml_(name)}</h1>
      <div class="contact">${escapeHtml_(contactLine)}</div>
    </header>

    <section>
      <div class="section-title">Summary</div>
      <p class="summary">${escapeHtml_(summary)}</p>
    </section>

    <section>
      <div class="section-title">Targeted Impact for ${escapeHtml_(company)} (${escapeHtml_(role)})</div>
      <ul class="impact-list">
        ${renderImpactRows_(evidence)}
      </ul>
    </section>

    <section>
      <div class="section-title">Experience</div>
      ${renderExperience_(experience, highlightTokens)}
    </section>

    <section>
      <div class="section-title">Skills</div>
      <div class="skills">
        ${(skills.length ? skills : ["Skills not listed in active profile."]).map((skill) => `<span class="skill-chip">${escapeHtml_(skill)}</span>`).join("")}
      </div>
    </section>

    <div class="meta-note">Generated by JobOps html_simple renderer.</div>
  </main>
</body>
</html>`;
}

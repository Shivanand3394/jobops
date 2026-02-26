const CONTACT_CHANNELS = Object.freeze(["LINKEDIN", "EMAIL", "OTHER"]);
const STORAGE_PROBE_TTL_MS = 60_000;

let contactsStorageProbeCache_ = {
  checked_at: 0,
  enabled: false,
  error: "not_checked",
};

function safeText_(value, maxLen = 5000) {
  return String(value || "").trim().slice(0, maxLen);
}

function safeLower_(value) {
  return safeText_(value, 5000).toLowerCase();
}

function normalizeEmail_(value) {
  const v = safeLower_(value);
  if (!v || !v.includes("@")) return "";
  return v.slice(0, 320);
}

function normalizeLinkedinUrl_(rawUrl) {
  const input = safeText_(rawUrl, 2000);
  if (!input) return "";
  try {
    const url = new URL(input);
    const host = safeLower_(url.hostname);
    if (!host.includes("linkedin.com")) return "";
    url.hash = "";
    url.search = "";
    const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    return normalized.slice(0, 2000);
  } catch {
    return "";
  }
}

function normalizeChannel_(value) {
  const v = safeUpper_(value);
  return CONTACT_CHANNELS.includes(v) ? v : "OTHER";
}

function safeUpper_(value) {
  return safeText_(value, 200).toUpperCase();
}

function clampInt_(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

function normalizeContactCandidate_(raw, { fallbackCompany = "", source = "" } = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const name = safeText_(
    row.name ?? row.full_name ?? row.contact_name ?? row.person_name ?? "",
    240
  );
  if (!name) return null;

  const title = safeText_(row.title ?? row.role ?? row.designation ?? "", 240);
  const companyName = safeText_(row.company ?? fallbackCompany, 240);
  const linkedinUrl = normalizeLinkedinUrl_(
    row.linkedin_url ?? row.linkedin ?? row.linkedin_profile ?? ""
  );
  const email = normalizeEmail_(row.email ?? row.work_email ?? "");
  const confidence = clampInt_(row.confidence ?? row.score ?? 70, 0, 100);
  const contextSnippet = safeText_(
    row.context_snippet ?? row.context ?? row.evidence ?? "",
    600
  );
  const inferredSource = safeText_(row.source ?? source ?? "ai_inference", 80) || "ai_inference";
  const channel = normalizeChannel_(row.channel || (linkedinUrl ? "LINKEDIN" : (email ? "EMAIL" : "OTHER")));

  return {
    name,
    title: title || null,
    company_name: companyName || null,
    linkedin_url: linkedinUrl || null,
    email: email || null,
    confidence,
    source: inferredSource,
    notes: contextSnippet || null,
    channel,
  };
}

function dedupeContacts_(rows = [], opts = {}) {
  const seen = new Set();
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const normalized = normalizeContactCandidate_(row, opts);
    if (!normalized) continue;
    const key = normalized.linkedin_url
      ? `linkedin|${safeLower_(normalized.linkedin_url)}`
      : normalized.email
        ? `email|${safeLower_(normalized.email)}`
        : `name_company|${safeLower_(normalized.name)}|${safeLower_(normalized.company_name || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

async function hasContactsTableSet_(env) {
  if (!env?.DB) return { enabled: false, error: "missing_db" };
  const now = Date.now();
  if (
    contactsStorageProbeCache_.checked_at > 0 &&
    (now - contactsStorageProbeCache_.checked_at) < STORAGE_PROBE_TTL_MS
  ) {
    return { ...contactsStorageProbeCache_ };
  }

  try {
    const rows = await env.DB.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('contacts', 'contact_touchpoints');
    `.trim()).all();
    const names = new Set((rows?.results || []).map((r) => safeText_(r?.name, 120)));
    const enabled = names.has("contacts") && names.has("contact_touchpoints");
    contactsStorageProbeCache_ = {
      checked_at: now,
      enabled,
      error: enabled ? null : "tables_missing",
    };
  } catch (err) {
    contactsStorageProbeCache_ = {
      checked_at: now,
      enabled: false,
      error: safeText_(err?.message || err, 240) || "schema_probe_failed",
    };
  }

  return { ...contactsStorageProbeCache_ };
}

async function findExistingContact_(env, contact) {
  if (!env?.DB || !contact || typeof contact !== "object") return null;

  if (contact.linkedin_url) {
    const byLinkedin = await env.DB.prepare(`
      SELECT id, name, title, company_name, linkedin_url, email
      FROM contacts
      WHERE linkedin_url = ?
      LIMIT 1;
    `.trim()).bind(contact.linkedin_url).first();
    if (byLinkedin?.id) return byLinkedin;
  }

  if (contact.email) {
    const byEmail = await env.DB.prepare(`
      SELECT id, name, title, company_name, linkedin_url, email
      FROM contacts
      WHERE email = ?
      LIMIT 1;
    `.trim()).bind(contact.email).first();
    if (byEmail?.id) return byEmail;
  }

  if (contact.name && contact.company_name) {
    const byNameCompany = await env.DB.prepare(`
      SELECT id, name, title, company_name, linkedin_url, email
      FROM contacts
      WHERE lower(name) = lower(?)
        AND lower(COALESCE(company_name, '')) = lower(?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1;
    `.trim()).bind(contact.name, contact.company_name).first();
    if (byNameCompany?.id) return byNameCompany;
  }

  return null;
}

async function upsertOneContact_(env, contact, now) {
  const existing = await findExistingContact_(env, contact);
  const id = safeText_(existing?.id, 120) || crypto.randomUUID();

  if (existing?.id) {
    await env.DB.prepare(`
      UPDATE contacts
      SET
        name = ?,
        title = COALESCE(?, title),
        company_name = COALESCE(?, company_name),
        linkedin_url = COALESCE(?, linkedin_url),
        email = COALESCE(?, email),
        confidence = ?,
        source = ?,
        notes = COALESCE(?, notes),
        updated_at = ?
      WHERE id = ?;
    `.trim()).bind(
      contact.name,
      contact.title,
      contact.company_name,
      contact.linkedin_url,
      contact.email,
      contact.confidence,
      contact.source,
      contact.notes,
      now,
      id
    ).run();
    return { id, inserted: false };
  }

  await env.DB.prepare(`
    INSERT INTO contacts (
      id, name, title, company_name, linkedin_url, email,
      confidence, source, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `.trim()).bind(
    id,
    contact.name,
    contact.title,
    contact.company_name,
    contact.linkedin_url,
    contact.email,
    contact.confidence,
    contact.source,
    contact.notes,
    now,
    now
  ).run();

  return { id, inserted: true };
}

async function upsertTouchpoint_(env, {
  contactId,
  jobKey,
  channel,
  content,
  status = "DRAFT",
  now,
} = {}) {
  await env.DB.prepare(`
    INSERT INTO contact_touchpoints (
      id, contact_id, job_key, channel, status, content, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id, job_key, channel) DO UPDATE SET
      status = excluded.status,
      content = COALESCE(excluded.content, contact_touchpoints.content),
      updated_at = excluded.updated_at;
  `.trim()).bind(
    crypto.randomUUID(),
    contactId,
    jobKey,
    normalizeChannel_(channel),
    safeUpper_(status) || "DRAFT",
    safeText_(content, 4000) || null,
    now,
    now
  ).run();
}

export async function upsertPotentialContactsForJob_(env, input = {}) {
  const schema = await hasContactsTableSet_(env);
  const jobKey = safeText_(input.job_key, 120);
  const company = safeText_(input.company, 240);
  const source = safeText_(input.source, 80) || "ai_inference";
  const contacts = dedupeContacts_(input.contacts, { fallbackCompany: company, source });

  if (!schema.enabled) {
    return {
      ok: false,
      enabled: false,
      error: schema.error || "contacts_storage_unavailable",
      job_key: jobKey,
      processed: contacts.length,
      upserted: 0,
      inserted: 0,
      updated: 0,
      touchpoints_linked: 0,
      skipped: contacts.length,
    };
  }

  if (!jobKey) {
    return {
      ok: false,
      enabled: true,
      error: "missing_job_key",
      job_key: "",
      processed: contacts.length,
      upserted: 0,
      inserted: 0,
      updated: 0,
      touchpoints_linked: 0,
      skipped: contacts.length,
    };
  }

  if (!contacts.length) {
    return {
      ok: true,
      enabled: true,
      error: null,
      job_key: jobKey,
      processed: 0,
      upserted: 0,
      inserted: 0,
      updated: 0,
      touchpoints_linked: 0,
      skipped: 0,
    };
  }

  let inserted = 0;
  let updated = 0;
  let touchpointsLinked = 0;
  let skipped = 0;
  const errors = [];
  const persistedContacts = [];
  const now = Date.now();

  for (const contact of contacts) {
    try {
      const result = await upsertOneContact_(env, contact, now);
      if (result.inserted) inserted += 1;
      else updated += 1;

      await upsertTouchpoint_(env, {
        contactId: result.id,
        jobKey,
        channel: contact.channel,
        content: contact.notes,
        status: "DRAFT",
        now,
      });
      touchpointsLinked += 1;
      persistedContacts.push({
        id: result.id,
        name: contact.name,
        title: contact.title,
        company_name: contact.company_name,
        linkedin_url: contact.linkedin_url,
        email: contact.email,
        channel: contact.channel,
        confidence: contact.confidence,
        source: contact.source,
      });
    } catch (err) {
      skipped += 1;
      errors.push(safeText_(err?.message || err, 240));
    }
  }

  return {
    ok: errors.length === 0,
    enabled: true,
    error: errors.length ? "partial_failure" : null,
    errors,
    job_key: jobKey,
    processed: contacts.length,
    upserted: inserted + updated,
    inserted,
    updated,
    touchpoints_linked: touchpointsLinked,
    skipped,
    contacts: persistedContacts,
  };
}

export async function hasContactsStorage_(env) {
  return hasContactsTableSet_(env);
}


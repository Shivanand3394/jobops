const ALLOWED_SOURCES = new Set(["GMAIL", "WHATSAPP", "RSS", "MANUAL"]);

function normalizeText_(v, maxLen = 5000) {
  return String(v || "").trim().slice(0, maxLen);
}

function normalizeExternalId_(v) {
  return normalizeText_(v, 240);
}

export function normalizeIngestSource_(source) {
  const normalized = normalizeText_(source, 32).toUpperCase();
  return ALLOWED_SOURCES.has(normalized) ? normalized : "MANUAL";
}

export function buildCandidateIngestEnvelope_(input = {}) {
  const source = normalizeIngestSource_(input.source);
  const canonicalJobIn = (input.canonical_job && typeof input.canonical_job === "object")
    ? input.canonical_job
    : {};
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ts = Number.isFinite(Number(input.ingest_timestamp))
    ? Math.max(0, Math.floor(Number(input.ingest_timestamp)))
    : nowSeconds;

  return {
    source,
    raw_payload: input.raw_payload ?? null,
    canonical_job: {
      title: normalizeText_(canonicalJobIn.title, 300),
      company: normalizeText_(canonicalJobIn.company, 300),
      description: normalizeText_(canonicalJobIn.description, 20000),
      external_id: normalizeExternalId_(canonicalJobIn.external_id),
      job_url: normalizeText_(canonicalJobIn.job_url, 2000),
      source_domain: normalizeText_(canonicalJobIn.source_domain, 120).toLowerCase(),
    },
    ingest_timestamp: ts,
  };
}

export function envelopeHasCanonicalMinimum_(envelope) {
  if (!envelope || typeof envelope !== "object") return false;
  const job = envelope.canonical_job && typeof envelope.canonical_job === "object"
    ? envelope.canonical_job
    : {};
  return Boolean(
    normalizeText_(job.title, 300) ||
    normalizeText_(job.description, 20000) ||
    normalizeText_(job.job_url, 2000)
  );
}


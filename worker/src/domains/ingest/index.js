import { pollGmailAndIngest_ } from "../../gmail.js";
import { diagnoseRssFeedsAndIngest_, pollRssFeedsAndIngest_ } from "../../rss.js";
import {
  adaptGmailPayload_,
  adaptManualPayload_,
  adaptRssPayload_,
} from "./adapters/index.js";
import {
  buildCandidateIngestEnvelope_,
  envelopeHasCanonicalMinimum_,
  normalizeIngestSource_,
} from "../../shared/contracts/candidate_ingest.js";

export function buildIngestEnvelope_(input = {}) {
  return buildCandidateIngestEnvelope_(input);
}

export function isValidIngestEnvelope_(envelope) {
  return envelopeHasCanonicalMinimum_(envelope);
}

export function normalizeIngestSourceDomain_(source) {
  return normalizeIngestSource_(source);
}

function pickAdapter_(source) {
  const s = normalizeIngestSource_(source);
  if (s === "GMAIL") return adaptGmailPayload_;
  if (s === "RSS") return adaptRssPayload_;
  return adaptManualPayload_;
}

function uniqStrings_(arr) {
  const seen = new Set();
  const out = [];
  for (const item of (Array.isArray(arr) ? arr : [])) {
    const v = String(item || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function processIngest(payload = {}, source = "MANUAL") {
  const normalizedSource = normalizeIngestSource_(source);
  const adapter = pickAdapter_(normalizedSource);
  const adapted = adapter(payload);
  const canonicalJobs = Array.isArray(adapted?.canonical_jobs) ? adapted.canonical_jobs : [];
  const passthrough = (adapted?.passthrough && typeof adapted.passthrough === "object")
    ? adapted.passthrough
    : {};

  const envelopes = canonicalJobs.map((job, idx) => buildCandidateIngestEnvelope_({
    source: normalizedSource,
    raw_payload: {
      source: normalizedSource,
      adapter: String(adapter?.name || "unknown").trim() || "unknown",
      index: idx,
    },
    canonical_job: job,
    ingest_timestamp: Math.floor(Date.now() / 1000),
  }));

  const validEnvelopes = envelopes.filter((e) => envelopeHasCanonicalMinimum_(e));
  const rawUrls = uniqStrings_(validEnvelopes.map((e) => e?.canonical_job?.job_url || ""));

  return {
    source: normalizedSource,
    adapter: String(adapter?.name || "unknown").trim() || "unknown",
    envelopes,
    valid_envelopes: validEnvelopes,
    counts: {
      total: envelopes.length,
      valid: validEnvelopes.length,
      invalid: Math.max(0, envelopes.length - validEnvelopes.length),
    },
    ingest_input: {
      raw_urls: rawUrls,
      email_text: typeof passthrough.email_text === "string" ? passthrough.email_text : "",
      email_html: typeof passthrough.email_html === "string" ? passthrough.email_html : "",
      email_subject: typeof passthrough.email_subject === "string" ? passthrough.email_subject : "",
      email_from: typeof passthrough.email_from === "string" ? passthrough.email_from : "",
    },
  };
}

export async function runGmailIngestConnector_(opts = {}) {
  return pollGmailAndIngest_(opts);
}

export async function runRssIngestConnector_(opts = {}) {
  return pollRssFeedsAndIngest_(opts);
}

export async function runRssDiagnosticsConnector_(opts = {}) {
  return diagnoseRssFeedsAndIngest_(opts);
}

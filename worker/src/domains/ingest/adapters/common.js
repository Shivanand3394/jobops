function safeText_(v, maxLen = 5000) {
  return String(v || "").trim().slice(0, maxLen);
}

function extractDomainFromUrl_(rawUrl) {
  const s = safeText_(rawUrl, 2000);
  if (!s) return "";
  try {
    const u = new URL(s);
    return String(u.hostname || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

export function toCanonicalJobsFromUrls_(urls, { title = "", description = "", externalIdPrefix = "" } = {}) {
  const list = Array.isArray(urls) ? urls : [];
  return list
    .map((u, idx) => {
      const jobUrl = safeText_(u, 2000);
      if (!jobUrl) return null;
      return {
        title: safeText_(title, 300),
        company: "",
        description: safeText_(description, 20000),
        external_id: safeText_(externalIdPrefix ? `${externalIdPrefix}:${idx + 1}` : "", 240),
        job_url: jobUrl,
        source_domain: extractDomainFromUrl_(jobUrl),
      };
    })
    .filter(Boolean);
}

export function buildPassthroughContext_(payload = {}) {
  return {
    email_text: safeText_(payload.email_text, 100000),
    email_html: safeText_(payload.email_html, 200000),
    email_subject: safeText_(payload.email_subject, 300),
    email_from: safeText_(payload.email_from, 500),
  };
}


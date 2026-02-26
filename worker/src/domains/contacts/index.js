function safeText_(v, maxLen = 5000) {
  return String(v || "").trim().slice(0, maxLen);
}

export { hasContactsStorage_, upsertPotentialContactsForJob_ } from "./adapter.js";
export { draftOutreachMessage_, normalizeOutreachChannel_ } from "./outreach.js";

export function buildContactMessageContext_(input = {}) {
  const job = (input.job && typeof input.job === "object") ? input.job : {};
  const profile = (input.profile && typeof input.profile === "object") ? input.profile : {};
  const contact = (input.contact && typeof input.contact === "object") ? input.contact : {};

  return {
    job: {
      job_key: safeText_(job.job_key, 120),
      role_title: safeText_(job.role_title, 240),
      company: safeText_(job.company, 240),
      job_url: safeText_(job.job_url, 2000),
    },
    profile: {
      name: safeText_(profile.name, 240),
      summary: safeText_(profile.summary, 3000),
    },
    contact: {
      full_name: safeText_(contact.full_name || contact.name, 240),
      company: safeText_(contact.company, 240),
      channel: safeText_(contact.channel, 80),
    },
    tone: safeText_(input.tone || "grounded_confident", 80),
    ts: Number.isFinite(Number(input.ts)) ? Number(input.ts) : Date.now(),
  };
}

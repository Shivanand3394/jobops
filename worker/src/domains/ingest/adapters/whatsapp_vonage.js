import { buildPassthroughContext_, toCanonicalJobsFromUrls_ } from "./common.js";

function safeText_(v, maxLen = 5000) {
  return String(v || "").trim().slice(0, maxLen);
}

function pickFirstText_(payload = {}) {
  const p = (payload && typeof payload === "object") ? payload : {};

  const direct = [
    p.text,
    p.body,
    p.message_text,
    p.content?.text,
    p.message?.content?.text,
    p.message?.text,
    p.whatsapp?.text,
    p.data?.text,
  ];
  for (const v of direct) {
    const s = safeText_(v, 20000);
    if (s) return s;
  }
  return "";
}

function extractFirstUrl_(text = "") {
  const s = safeText_(text, 40000);
  if (!s) return "";
  const m = s.match(/https?:\/\/[^\s<>"')\]]+/i);
  return safeText_(m?.[0], 2000);
}

function pickSender_(payload = {}) {
  const p = (payload && typeof payload === "object") ? payload : {};
  return safeText_(
    p.from ||
    p.sender ||
    p.msisdn ||
    p.phone ||
    p.message?.from ||
    p.whatsapp?.from ||
    "",
    500
  );
}

function pickMessageId_(payload = {}) {
  const p = (payload && typeof payload === "object") ? payload : {};
  const raw = safeText_(
    p.message_uuid ||
    p.messageUuid ||
    p.message_id ||
    p.messageId ||
    p.uuid ||
    p.id ||
    "",
    240
  );
  if (raw) return raw;
  const sender = pickSender_(p).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "anon";
  return `wa-${sender}-${Date.now()}`;
}

function syntheticVonageJobUrl_(messageId) {
  const id = safeText_(messageId, 120).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120) || "msg";
  return `https://whatsapp.vonage.local/inbound/${id}`;
}

export function adaptWhatsappVonagePayload_(payload = {}) {
  const text = pickFirstText_(payload);
  const sender = pickSender_(payload);
  const messageId = pickMessageId_(payload);
  const detectedUrl = extractFirstUrl_(text);
  const shouldCreateSynthetic = !detectedUrl && text.length >= 80;
  const rawUrls = detectedUrl
    ? [detectedUrl]
    : (shouldCreateSynthetic ? [syntheticVonageJobUrl_(messageId)] : []);
  const title = safeText_(payload?.subject || payload?.title || "WhatsApp Job Lead", 300) || "WhatsApp Job Lead";

  const passthrough = buildPassthroughContext_({
    email_text: text,
    email_html: "",
    email_subject: title,
    email_from: sender || "whatsapp_vonage",
  });

  return {
    source: "WHATSAPP",
    canonical_jobs: toCanonicalJobsFromUrls_(rawUrls, {
      title,
      description: text,
      externalIdPrefix: `whatsapp_vonage:${messageId}`,
    }),
    passthrough,
    metadata: {
      provider: "vonage",
      sender: sender || null,
      message_id: messageId,
      url_detected: Boolean(detectedUrl),
    },
  };
}

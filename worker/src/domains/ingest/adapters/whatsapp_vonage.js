import { buildPassthroughContext_, toCanonicalJobsFromUrls_ } from "./common.js";

function safeText_(v, maxLen = 5000) {
  return String(v || "").trim().slice(0, maxLen);
}

function pickFirstText_(payload = {}) {
  const p = (payload && typeof payload === "object") ? payload : {};

  const direct = [
    p.text,
    p.caption,
    p.body,
    p.message_text,
    p.content?.text,
    p.content?.caption,
    p.message?.content?.text,
    p.message?.content?.caption,
    p.message?.text,
    p.message?.caption,
    p.file?.caption,
    p.document?.caption,
    p.image?.caption,
    p.message?.file?.caption,
    p.message?.document?.caption,
    p.message?.image?.caption,
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

function normalizeMediaType_(input = "") {
  const s = safeText_(input, 80).toLowerCase();
  if (!s) return "";
  if (s === "file" || s === "document" || s === "doc" || s === "pdf") return "document";
  if (s === "image" || s === "photo" || s === "picture") return "image";
  if (s === "video") return "video";
  if (s === "audio" || s === "voice") return "audio";
  if (s === "sticker") return "sticker";
  return s;
}

function pickMessageType_(payload = {}) {
  const p = (payload && typeof payload === "object") ? payload : {};
  return normalizeMediaType_(
    p.message_type ||
    p.messageType ||
    p.type ||
    p.message?.message_type ||
    p.message?.messageType ||
    p.message?.type ||
    p.content?.type ||
    ""
  );
}

function toMediaRecord_(candidate, fallbackType = "") {
  const c = (candidate && typeof candidate === "object") ? candidate : {};
  const url = safeText_(
    c.url ||
    c.media_url ||
    c.mediaUrl ||
    c.link ||
    c.href ||
    c.download_url ||
    c.downloadUrl ||
    c.file_url ||
    "",
    4000
  );
  const mimeType = safeText_(c.mime_type || c.mimetype || c.content_type || "", 120).toLowerCase();
  const fileName = safeText_(c.name || c.filename || c.file_name || "", 240);
  const caption = safeText_(c.caption || c.title || "", 20000);
  const sizeRaw = Number(c.size || c.file_size || c.fileSize || c.bytes);
  const sizeBytes = Number.isFinite(sizeRaw) ? Math.max(0, Math.floor(sizeRaw)) : null;
  const inferredType = normalizeMediaType_(c.type || c.message_type || c.kind || fallbackType);

  if (!url && !mimeType && !fileName && !inferredType && !caption && sizeBytes === null) return null;
  return {
    present: true,
    type: inferredType || normalizeMediaType_(fallbackType) || "unknown",
    url: url || "",
    mime_type: mimeType || "",
    file_name: fileName || "",
    caption: caption || "",
    size_bytes: sizeBytes,
  };
}

function pickMedia_(payload = {}) {
  const p = (payload && typeof payload === "object") ? payload : {};
  const typeHint = pickMessageType_(p);

  const candidates = [
    { type: "document", value: p.file },
    { type: "document", value: p.document },
    { type: "image", value: p.image },
    { type: "video", value: p.video },
    { type: "audio", value: p.audio },
    { type: "sticker", value: p.sticker },
    { type: "document", value: p.message?.file },
    { type: "document", value: p.message?.document },
    { type: "image", value: p.message?.image },
    { type: "video", value: p.message?.video },
    { type: "audio", value: p.message?.audio },
    { type: "document", value: p.content?.file },
    { type: "document", value: p.content?.document },
    { type: "image", value: p.content?.image },
    { type: "video", value: p.content?.video },
    { type: "audio", value: p.content?.audio },
    { type: typeHint || "", value: p.media },
    { type: typeHint || "", value: p.message?.media },
    { type: typeHint || "", value: p.content?.media },
  ];

  for (const item of candidates) {
    const rec = toMediaRecord_(item?.value, item?.type || typeHint);
    if (rec) return rec;
  }

  if (typeHint === "document" || typeHint === "image" || typeHint === "video" || typeHint === "audio") {
    const direct = toMediaRecord_(p, typeHint);
    if (direct) return direct;
  }

  return {
    present: false,
    type: typeHint || "",
    url: "",
    mime_type: "",
    file_name: "",
    caption: "",
    size_bytes: null,
  };
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
  const media = pickMedia_(payload);
  const text = pickFirstText_(payload) || safeText_(media.caption, 20000);
  const sender = pickSender_(payload);
  const messageId = pickMessageId_(payload);
  const messageType = pickMessageType_(payload);
  const detectedUrl = extractFirstUrl_(text);
  const shouldCreateSynthetic = !detectedUrl && text.length >= 80;
  const rawUrls = detectedUrl
    ? [detectedUrl]
    : (shouldCreateSynthetic ? [syntheticVonageJobUrl_(messageId)] : []);
  const mediaLabel = safeText_(media.file_name || media.type, 80);
  const title = safeText_(payload?.subject || payload?.title || mediaLabel || "WhatsApp Job Lead", 300) || "WhatsApp Job Lead";

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
      message_type: messageType || null,
      media: {
        present: Boolean(media.present),
        type: media.type || null,
        url: media.url || null,
        mime_type: media.mime_type || null,
        file_name: media.file_name || null,
        caption: safeText_(media.caption, 500) || null,
        size_bytes: (media.size_bytes === null || media.size_bytes === undefined || media.size_bytes === "")
          ? null
          : (Number.isFinite(Number(media.size_bytes)) ? Math.max(0, Math.floor(Number(media.size_bytes))) : null),
      },
    },
  };
}

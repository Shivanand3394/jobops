const DEFAULT_PROMPT = [
  "You are a strict extraction engine.",
  "Extract job information from the attached document.",
  "Return JSON only with keys:",
  "title, company, job_description, urls.",
  "If this is not a job description, still return JSON with empty strings/arrays.",
].join(" ");

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders_(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" && request.method === "GET") {
      return json_({
        ok: true,
        service: "whatsapp-media-extractor",
        ts: Date.now(),
      }, env, 200);
    }

    if (path !== "/extract/whatsapp-media" || request.method !== "POST") {
      return json_({ ok: false, error: "Not found" }, env, 404);
    }

    const authErr = authorize_(request, env);
    if (authErr) return authErr;

    const apiKey = String(env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      return json_({ ok: false, error: "Missing GEMINI_API_KEY" }, env, 500);
    }

    const body = await request.json().catch(() => ({}));
    const mediaUrl = String(body?.media?.url || "").trim();
    if (!mediaUrl) {
      return json_({ ok: false, error: "Missing media.url" }, env, 400);
    }

    let mediaParsed;
    try {
      mediaParsed = new URL(mediaUrl);
    } catch {
      return json_({ ok: false, error: "Invalid media.url" }, env, 400);
    }
    if (mediaParsed.protocol !== "https:" && mediaParsed.protocol !== "http:") {
      return json_({ ok: false, error: "Unsupported media URL protocol" }, env, 400);
    }

    const mediaAllowHosts = splitCsv_(env.MEDIA_ALLOWED_HOSTS);
    if (mediaAllowHosts.length && !mediaAllowHosts.includes(mediaParsed.hostname.toLowerCase())) {
      return json_({ ok: false, error: "Media host not allowed" }, env, 403);
    }

    const mediaFetchTimeoutMs = clampInt_(env.MEDIA_FETCH_TIMEOUT_MS || 12000, 2000, 60000);
    const mediaMaxBytes = clampInt_(env.MEDIA_MAX_BYTES || 6291456, 262144, 20971520);

    const mediaHeaders = {
      Accept: "*/*",
    };
    const forwardedVonageAuth = String(request.headers.get("x-vonage-authorization") || "").trim();
    const staticVonageAuth = String(env.VONAGE_MEDIA_AUTH_BEARER || "").trim();
    const generatedVonageAuth = await buildVonageMediaAuthorization_(env);
    let mediaAuthMode = "none";
    if (generatedVonageAuth) {
      mediaHeaders.Authorization = generatedVonageAuth;
      mediaAuthMode = "jwt";
    } else if (staticVonageAuth) {
      mediaHeaders.Authorization = staticVonageAuth;
      mediaAuthMode = "basic";
    } else if (forwardedVonageAuth) {
      mediaHeaders.Authorization = forwardedVonageAuth;
      mediaAuthMode = "forwarded";
    }

    const mediaRes = await fetchWithTimeout_(mediaUrl, {
      method: "GET",
      headers: mediaHeaders,
    }, mediaFetchTimeoutMs).catch((e) => ({ __error: String(e?.message || e || "media_fetch_failed") }));
    if (mediaRes?.__error) {
      return json_({ ok: false, error: `Media fetch failed (${mediaAuthMode}): ${mediaRes.__error}` }, env, 502);
    }
    if (!mediaRes.ok) {
      const bodyText = await mediaRes.text().catch(() => "");
      return json_({
        ok: false,
        error: `Media fetch (${mediaAuthMode}) http_${mediaRes.status}`,
        detail: String(bodyText || "").trim().slice(0, 400),
      }, env, 502);
    }

    const contentLen = Number(mediaRes.headers.get("content-length"));
    if (Number.isFinite(contentLen) && contentLen > mediaMaxBytes) {
      return json_({ ok: false, error: `Media too large (${contentLen} bytes)` }, env, 413);
    }

    const mediaBuffer = await mediaRes.arrayBuffer().catch(() => null);
    if (!mediaBuffer) {
      return json_({ ok: false, error: "Unable to read media body" }, env, 502);
    }
    if (mediaBuffer.byteLength > mediaMaxBytes) {
      return json_({ ok: false, error: `Media too large (${mediaBuffer.byteLength} bytes)` }, env, 413);
    }

    const payloadMime = String(body?.media?.mime_type || "").trim().toLowerCase();
    const headerMime = String(mediaRes.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const mimeType = payloadMime || headerMime || "application/octet-stream";

    const allowedMimeTypes = splitCsv_(env.MEDIA_ALLOWED_MIME_TYPES, [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/webp",
      "text/plain",
    ]);
    if (!isMimeAllowed_(mimeType, allowedMimeTypes)) {
      return json_({ ok: false, error: `Unsupported mime type: ${mimeType}` }, env, 415);
    }

    const mediaBase64 = bytesToBase64_(new Uint8Array(mediaBuffer));

    const model = String(env.GEMINI_MODEL || "gemini-1.5-flash").trim() || "gemini-1.5-flash";
    const prompt = String(env.GEMINI_EXTRACTION_PROMPT || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT;
    const geminiTimeoutMs = clampInt_(env.GEMINI_TIMEOUT_MS || 20000, 2000, 60000);

    const geminiPayload = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: mediaBase64,
            },
          },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    };

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let geminiRes = await fetchWithTimeout_(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload),
    }, geminiTimeoutMs).catch((e) => ({ __error: String(e?.message || e || "gemini_request_failed") }));
    if (geminiRes?.__error) {
      return json_({ ok: false, error: `Gemini request failed: ${geminiRes.__error}` }, env, 502);
    }

    let geminiRawText = await geminiRes.text().catch(() => "");
    let geminiObj = safeJsonParse_(geminiRawText) || {};
    if (!geminiRes.ok) {
      // Compatibility fallback for models/accounts that reject responseMimeType.
      const fallbackPayload = {
        contents: geminiPayload.contents,
        generationConfig: { temperature: 0.1 },
      };
      const retry = await fetchWithTimeout_(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallbackPayload),
      }, geminiTimeoutMs).catch((e) => ({ __error: String(e?.message || e || "gemini_request_failed") }));
      if (retry?.__error) {
        return json_({ ok: false, error: `Gemini request failed: ${retry.__error}` }, env, 502);
      }
      geminiRes = retry;
      geminiRawText = await geminiRes.text().catch(() => "");
      geminiObj = safeJsonParse_(geminiRawText) || {};
    }
    if (!geminiRes.ok) {
      const detail = String(
        geminiObj?.error?.message ||
        geminiObj?.error ||
        geminiRawText ||
        `http_${geminiRes.status}`
      ).trim().slice(0, 500);
      return json_({ ok: false, error: `Gemini http_${geminiRes.status}`, detail }, env, 502);
    }

    const candidateText = extractGeminiText_(geminiObj);
    const parsedJson = parseJsonObjectFromText_(candidateText) || {};

    const extractedTitle = firstNonEmpty_([
      parsedJson.title,
      parsedJson.job_title,
      parsedJson.jobTitle,
      body?.media?.file_name,
    ], 300);
    const extractedCompany = firstNonEmpty_([
      parsedJson.company,
      parsedJson.company_name,
      parsedJson.companyName,
    ], 300);
    const extractedDescription = firstNonEmpty_([
      parsedJson.job_description,
      parsedJson.jobDescription,
      parsedJson.description,
      parsedJson.jd_text,
      parsedJson.jdText,
      candidateText,
    ], 120000);
    const extractedUrls = normalizeUrls_([
      ...(Array.isArray(parsedJson.urls) ? parsedJson.urls : []),
      parsedJson.url,
      parsedJson.job_url,
      extractFirstUrl_(extractedDescription),
    ]);

    return json_({
      ok: true,
      text: extractedDescription,
      title: extractedTitle,
      company: extractedCompany,
      urls: extractedUrls,
      source: {
        provider: "gemini",
        model,
        mime_type: mimeType,
        media_bytes: mediaBuffer.byteLength,
      },
    }, env, 200);
  },
};

function corsHeaders_(env) {
  const allowOrigin = String(env?.ALLOW_ORIGIN || "*").trim() || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,x-vonage-authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json_(obj, env, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders_(env),
    },
  });
}

function authorize_(request, env) {
  const expected = String(env?.WHATSAPP_MEDIA_EXTRACTOR_TOKEN || "").trim();
  if (!expected) return null;
  const auth = String(request.headers.get("authorization") || "").trim();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const provided = String(m?.[1] || "").trim();
  if (!provided || provided !== expected) {
    return json_({ ok: false, error: "Unauthorized" }, env, 401);
  }
  return null;
}

function clampInt_(value, lo, hi) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function splitCsv_(raw, fallback = []) {
  const s = String(raw || "").trim();
  if (!s) return [...fallback];
  return Array.from(new Set(
    s.split(/[\r\n,]+/g)
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean)
  ));
}

function isMimeAllowed_(mimeType, allowList) {
  const m = String(mimeType || "").trim().toLowerCase();
  if (!m) return false;
  const list = Array.isArray(allowList) ? allowList : [];
  if (!list.length) return true;
  if (list.includes(m)) return true;
  const major = m.split("/")[0];
  return list.includes(`${major}/*`);
}

function bytesToBase64_(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function safeJsonParse_(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function parseJsonObjectFromText_(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const direct = safeJsonParse_(raw);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    const parsed = safeJsonParse_(fenced[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

function extractGeminiText_(obj) {
  const candidates = Array.isArray(obj?.candidates) ? obj.candidates : [];
  const lines = [];
  for (const cand of candidates) {
    const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    for (const part of parts) {
      const t = String(part?.text || "").trim();
      if (t) lines.push(t);
    }
  }
  return lines.join("\n").trim().slice(0, 120000);
}

function firstNonEmpty_(values, maxLen = 300) {
  for (const v of (Array.isArray(values) ? values : [])) {
    const s = String(v || "").trim();
    if (s) return s.slice(0, maxLen);
  }
  return "";
}

function extractFirstUrl_(text = "") {
  const s = String(text || "").trim();
  if (!s) return "";
  const m = s.match(/https?:\/\/[^\s<>"')\]]+/i);
  return String(m?.[0] || "").trim().slice(0, 3000);
}

function normalizeUrls_(values) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(values) ? values : [])) {
    const s = String(raw || "").trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const finalUrl = u.toString();
      if (seen.has(finalUrl)) continue;
      seen.add(finalUrl);
      out.push(finalUrl);
    } catch {
      // ignore invalid URL
    }
  }
  return out.slice(0, 20);
}

async function buildVonageMediaAuthorization_(env) {
  const appId = String(env?.VONAGE_APPLICATION_ID || "").trim();
  const privateKeyPem = normalizePrivateKeyPem_(env?.VONAGE_PRIVATE_KEY);
  if (!appId || !privateKeyPem) return "";
  const jwt = await generateRs256Jwt_(appId, privateKeyPem).catch(() => "");
  return jwt ? `Bearer ${jwt}` : "";
}

function normalizePrivateKeyPem_(raw) {
  const src = String(raw || "").trim();
  if (!src) return "";
  if (src.includes("-----BEGIN PRIVATE KEY-----")) return src;
  const body = src.replace(/\s+/g, "");
  if (!body) return "";
  const chunks = body.match(/.{1,64}/g) || [];
  return [
    "-----BEGIN PRIVATE KEY-----",
    ...chunks,
    "-----END PRIVATE KEY-----",
  ].join("\n");
}

async function generateRs256Jwt_(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
    application_id: appId,
  };
  const headerB64 = base64UrlEncodeText_(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeText_(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPkcs8PrivateKey_(privateKeyPem);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput)
  );
  const sigB64 = base64UrlEncodeBytes_(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

async function importPkcs8PrivateKey_(pem) {
  const raw = String(pem || "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bytes = base64DecodeToBytes_(raw);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64DecodeToBytes_(b64) {
  const binary = atob(String(b64 || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlEncodeText_(text) {
  return base64UrlEncodeBytes_(new TextEncoder().encode(String(text || "")));
}

function base64UrlEncodeBytes_(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function fetchWithTimeout_(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

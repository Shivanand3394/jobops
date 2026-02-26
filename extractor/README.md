# WhatsApp Media Extractor Worker

This Worker receives WhatsApp media metadata, downloads the media, and asks Gemini to extract job information.

## Routes
- `GET /health`
- `POST /extract/whatsapp-media`

## Auth
- Optional Bearer auth: set `WHATSAPP_MEDIA_EXTRACTOR_TOKEN`.
- If token is set, requests must send: `Authorization: Bearer <token>`.

## Required Secret
From `extractor/`:

```bash
wrangler secret put GEMINI_API_KEY
```

## Optional Secrets
```bash
wrangler secret put WHATSAPP_MEDIA_EXTRACTOR_TOKEN
wrangler secret put VONAGE_MEDIA_AUTH_BEARER
wrangler secret put VONAGE_APPLICATION_ID
wrangler secret put VONAGE_PRIVATE_KEY
```

## Optional Vars
Configure in `wrangler.jsonc` (or with `wrangler secret/vars` policy):
- `GEMINI_MODEL` (default: `gemini-1.5-flash`)
- `MEDIA_FETCH_TIMEOUT_MS`
- `MEDIA_MAX_BYTES`
- `GEMINI_TIMEOUT_MS`
- `MEDIA_ALLOWED_HOSTS` (CSV/newline, optional host allow list)
- `MEDIA_ALLOWED_MIME_TYPES` (CSV/newline)
- `GEMINI_EXTRACTION_PROMPT`
- `ALLOW_ORIGIN`

Auth precedence for Vonage media fetch:
1. Generated JWT from `VONAGE_APPLICATION_ID` + `VONAGE_PRIVATE_KEY`
2. Static `VONAGE_MEDIA_AUTH_BEARER`
3. Forwarded inbound auth header (`x-vonage-authorization`)

## Deploy
From `extractor/`:

```bash
wrangler deploy
```

## Request Contract
```json
{
  "provider": "vonage",
  "message_id": "string|null",
  "sender": "string|null",
  "media": {
    "url": "https://...",
    "type": "document|image|video|audio|null",
    "mime_type": "string|null",
    "file_name": "string|null",
    "size_bytes": 12345,
    "caption": "string|null"
  },
  "signature": {
    "verified": true,
    "mode": "verified|disabled|null",
    "issuer": "string|null"
  }
}
```

## Response Contract
Canonical success response:

```json
{
  "ok": true,
  "text": "...",
  "title": "...",
  "company": "...",
  "urls": ["https://..."],
  "source": {
    "provider": "gemini",
    "model": "gemini-1.5-flash",
    "mime_type": "application/pdf",
    "media_bytes": 123456
  }
}
```

Main worker also accepts Gemini-style passthrough responses, but canonical JSON is recommended.

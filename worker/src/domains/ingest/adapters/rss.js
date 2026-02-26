import { buildPassthroughContext_, toCanonicalJobsFromUrls_ } from "./common.js";

export function adaptRssPayload_(payload = {}) {
  const rawUrls = Array.isArray(payload.raw_urls) ? payload.raw_urls : [];
  const ctx = buildPassthroughContext_(payload);
  const title = ctx.email_subject || "";
  const description = ctx.email_text || "";

  return {
    source: "RSS",
    canonical_jobs: toCanonicalJobsFromUrls_(rawUrls, {
      title,
      description,
      externalIdPrefix: "rss",
    }),
    passthrough: ctx,
  };
}


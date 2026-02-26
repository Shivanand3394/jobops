export const TRACKING_STATUSES = Object.freeze([
  "NEW",
  "LINK_ONLY",
  "SCORED",
  "SHORTLISTED",
  "READY_TO_APPLY",
  "APPLIED",
  "REJECTED",
  "ARCHIVED",
]);

export function isTerminalTrackingStatus_(status) {
  const s = String(status || "").trim().toUpperCase();
  return s === "APPLIED" || s === "REJECTED" || s === "ARCHIVED";
}

export function normalizeTrackingStatus_(status, fallback = "NEW") {
  const s = String(status || "").trim().toUpperCase();
  return TRACKING_STATUSES.includes(s) ? s : String(fallback || "NEW").trim().toUpperCase();
}


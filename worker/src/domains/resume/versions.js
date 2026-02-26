export const LOCKED_DRAFT_STATUSES = Object.freeze([
  "READY_TO_APPLY",
  "APPLIED",
]);

export function normalizeDraftStatus_(status, fallback = "") {
  const s = String(status || "").trim().toUpperCase();
  return s || String(fallback || "").trim().toUpperCase();
}

export function isDraftLockedStatus_(status) {
  const s = normalizeDraftStatus_(status);
  return LOCKED_DRAFT_STATUSES.includes(s);
}


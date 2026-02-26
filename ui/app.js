const DEFAULT_API_BASE = "https://get-job.shivanand-shah94.workers.dev";
const UI_BUILD_ID = "2026-02-26-triage-pulse-v1";
const RESUME_TEMPLATES_KEY = "jobops_resume_templates_v1";
const DEFAULT_TEMPLATE_ID = "balanced";
const TRACKING_RECOVERY_LAST_KEY = "jobops_tracking_recovery_last";
const ONE_PAGER_STRICT_KEY = "jobops_one_pager_strict_v1";
const WIZARD_STEP_KEY = "jobops_resume_wizard_step_v1";
const PDF_READY_MODE_KEY = "jobops_pdf_ready_mode_v1";

function getCfg() {
  return {
    apiBase: (localStorage.getItem("jobops_api_base") || DEFAULT_API_BASE).replace(/\/+$/, ""),
    uiKey: localStorage.getItem("jobops_ui_key") || "",
  };
}

function setCfg({ apiBase, uiKey }) {
  if (apiBase) localStorage.setItem("jobops_api_base", apiBase.replace(/\/+$/, ""));
  if (uiKey !== undefined) localStorage.setItem("jobops_ui_key", uiKey);
}

const $ = (id) => document.getElementById(id);

function getOnePagerStrictPref_() {
  const raw = String(localStorage.getItem(ONE_PAGER_STRICT_KEY) || "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function setOnePagerStrictPref_(on) {
  localStorage.setItem(ONE_PAGER_STRICT_KEY, on ? "1" : "0");
}

function normalizeWizardStep_(step) {
  const s = String(step || "").trim().toLowerCase();
  if (s === "pitch" || s === "finish") return s;
  return "matches";
}

function wizardStepOrder_(step) {
  const s = normalizeWizardStep_(step);
  if (s === "finish") return 3;
  if (s === "pitch") return 2;
  return 1;
}

function loadWizardStepMap_() {
  try {
    const raw = localStorage.getItem(WIZARD_STEP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    return {};
  }
}

function saveWizardStepMap_(mapObj) {
  try {
    localStorage.setItem(WIZARD_STEP_KEY, JSON.stringify(mapObj || {}));
  } catch {
    // ignore local storage write failure
  }
}

function loadWizardStepPref_(jobKey) {
  const key = String(jobKey || "").trim();
  if (!key) return "";
  const map = loadWizardStepMap_();
  return normalizeWizardStep_(map[key] || "matches");
}

function saveWizardStepPref_(jobKey, step) {
  const key = String(jobKey || "").trim();
  if (!key) return;
  const map = loadWizardStepMap_();
  map[key] = normalizeWizardStep_(step);
  saveWizardStepMap_(map);
}

function isPdfReadyModeOn_() {
  const raw = String(localStorage.getItem(PDF_READY_MODE_KEY) || "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function setPdfReadyMode_(on) {
  const enabled = Boolean(on);
  document.body.classList.toggle("pdf-ready-mode", enabled);
  localStorage.setItem(PDF_READY_MODE_KEY, enabled ? "1" : "0");
  const section = $("appPackSection");
  if (section) section.classList.toggle("pdf-ready", enabled);
  const toggleBtn = $("btnPdfReadyToggle");
  if (toggleBtn) toggleBtn.textContent = enabled ? "Exit PDF-ready view" : "PDF-ready view";
}

function loadLastRecoveryRun_() {
  try {
    const raw = localStorage.getItem(TRACKING_RECOVERY_LAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

function saveLastRecoveryRun_(snapshot) {
  try {
    localStorage.setItem(TRACKING_RECOVERY_LAST_KEY, JSON.stringify(snapshot || {}));
  } catch {
    // ignore local storage write failure
  }
}

const state = {
  view: "jobs",
  jobs: [],
  activeKey: null,
  targets: [],
  activeTargetId: null,
  metrics: null,
  rejectKeywordsEnabled: true,
  rubricProfileEnabled: true,
  resumeProfiles: [],
  activeProfileId: "primary",
  profileJsonDraftById: {},
  resumeTemplates: [],
  activeTemplateId: DEFAULT_TEMPLATE_ID,
  selectedAtsKeywords: [],
  activeJob: null,
  trackingFiltersOpen: false,
  lastRecoveryRun: loadLastRecoveryRun_(),
  workerVersion: "-",
  reviewContext: null,
  jobProfilePreferenceByKey: {},
  triage: {
    items: [],
    by_touchpoint_id: {},
    pulse: null,
    stale_days: 3,
    generated_at: 0,
    loading: false,
    error: "",
    last_fetched_at: 0,
  },
};
const TRACKING_COLUMNS = ["NEW", "SCORED", "SHORTLISTED", "READY_TO_APPLY", "APPLIED", "REJECTED", "ARCHIVED", "LINK_ONLY"];

const AI_NOTICE_SESSION_KEY = "jobops_ai_notice_seen_session";
const AI_NOTICE_DETECTED_KEY = "jobops_ai_notice_detected";

function toast(msg, opts = {}) {
  const t = $("toast");
  const text = String(msg || "");
  const lower = text.toLowerCase();
  const kind = opts.kind || (lower.includes("fail") || lower.includes("error") ? "error" : (lower.includes("saved") || lower.includes("rescored") || lower.includes("copied") ? "success" : "info"));
  const sticky = Boolean(opts.sticky);
  const duration = Number.isFinite(Number(opts.duration))
    ? Number(opts.duration)
    : (kind === "error" ? 5000 : 2200);

  t.textContent = text;
  t.classList.remove("hidden", "info", "success", "error");
  t.classList.add(kind);
  clearTimeout(toast._timer);
  if (!sticky) {
    toast._timer = setTimeout(() => t.classList.add("hidden"), duration);
  }
}

function spin(on) {
  $("spinner").classList.toggle("hidden", !on);
}

function isAiBindingMissingMessage(msg) {
  const s = String(msg || "").toLowerCase();
  return s.includes("missing workers ai binding") || s.includes("workers ai binding is unavailable");
}

function showAiNotice(force = false) {
  const el = $("aiNotice");
  if (!el) return;
  localStorage.setItem(AI_NOTICE_DETECTED_KEY, "1");
  $("btnShowAiNotice")?.classList.remove("hidden");
  if (!force && sessionStorage.getItem(AI_NOTICE_SESSION_KEY) === "1") return;
  sessionStorage.setItem(AI_NOTICE_SESSION_KEY, "1");
  el.classList.remove("hidden");
}

function hideAiNotice() {
  $("aiNotice")?.classList.add("hidden");
}

async function api(path, { method = "GET", body = null, useUiKey = true } = {}) {
  const cfg = getCfg();
  if (!cfg.uiKey) throw new Error("Missing UI_KEY. Open Settings and set UI key.");

  const headers = { "Content-Type": "application/json" };
  if (useUiKey) headers["x-ui-key"] = cfg.uiKey;

  const res = await fetch(cfg.apiBase + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  let data;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) data = await res.json();
  else data = { ok: res.ok, text: await res.text() };

  if (!res.ok || data?.ok === false) {
    const msg = data?.error || data?.detail || data?.text || ("HTTP " + res.status);
    if (isAiBindingMissingMessage(msg)) {
      showAiNotice(false);
    }
    const err = new Error(msg);
    err.httpStatus = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function cacheJobProfilePreference_(jobKey, pref = {}) {
  const key = String(jobKey || "").trim();
  if (!key) return;
  state.jobProfilePreferenceByKey[key] = {
    profile_id: String(pref.profile_id || "").trim(),
    effective_profile_id: String(pref.effective_profile_id || "").trim(),
    effective_source: String(pref.effective_source || "").trim(),
    enabled: Boolean(pref.enabled),
    updated_at: Number(pref.updated_at || 0) || null,
  };
}

async function loadJobProfilePreference_(jobKey, { silent = true } = {}) {
  const key = String(jobKey || "").trim();
  if (!key) return null;
  try {
    const res = await api(`/jobs/${encodeURIComponent(key)}/profile-preference`);
    const pref = res?.data && typeof res.data === "object" ? res.data : {};
    cacheJobProfilePreference_(key, pref);
    const effectiveId = String(pref.effective_profile_id || pref.profile_id || "").trim();
    if (effectiveId) state.activeProfileId = effectiveId;
    return pref;
  } catch (e) {
    if (!silent) toast("Profile preference load failed: " + e.message, { kind: "error" });
    return null;
  }
}

async function saveJobProfilePreference_(jobKey, profileId, { silent = true } = {}) {
  const key = String(jobKey || "").trim();
  if (!key) return null;
  try {
    const res = await api(`/jobs/${encodeURIComponent(key)}/profile-preference`, {
      method: "POST",
      body: { profile_id: String(profileId || "").trim() },
    });
    const pref = res?.data && typeof res.data === "object" ? res.data : {};
    cacheJobProfilePreference_(key, pref);
    const effectiveId = String(pref.effective_profile_id || pref.profile_id || "").trim();
    if (effectiveId) state.activeProfileId = effectiveId;
    return pref;
  } catch (e) {
    if (!silent) toast("Profile preference save failed: " + e.message, { kind: "error" });
    return null;
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderIngestResultBox(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const inserted = Number.isFinite(data?.inserted_count)
    ? data.inserted_count
    : results.filter((r) => r?.action === "inserted").length;
  const updated = Number.isFinite(data?.updated_count)
    ? data.updated_count
    : results.filter((r) => r?.action === "updated").length;
  const ignored = Number.isFinite(data?.ignored)
    ? data.ignored
    : results.filter((r) => r?.action === "ignored").length;
  const linkOnly = Number.isFinite(data?.link_only)
    ? data.link_only
    : results.filter((r) => String(r?.status || "").toUpperCase() === "LINK_ONLY").length;

  const rows = results.map((r) => {
    const action = String(r?.action || "updated");
    const actionLabel = (action === "updated" && r?.was_existing) ? "updated (already existed)" : action;
    const status = String(r?.status || "-");
    const key = String(r?.job_key || "-");
    const raw = String(r?.raw_url || "-");
    return `<li><b>${escapeHtml(actionLabel)}</b> - ${escapeHtml(status)} - ${escapeHtml(key)}<br><span class="muted tiny">${escapeHtml(raw)}</span></li>`;
  }).join("");

  return `
    <div><b>inserted:</b> ${escapeHtml(String(inserted))}</div>
    <div><b>updated:</b> ${escapeHtml(String(updated))}</div>
    <div><b>ignored:</b> ${escapeHtml(String(ignored))}</div>
    <div><b>link_only:</b> ${escapeHtml(String(linkOnly))}</div>
    <details style="margin-top:8px;">
      <summary>Last ingest results (${escapeHtml(String(results.length))})</summary>
      <ul style="margin:8px 0 0 18px; padding:0;">${rows || "<li>-</li>"}</ul>
    </details>
  `;
}

function getDisplayTitle(j) {
  const fromApi = String(j.display_title || "").trim();
  if (fromApi) return fromApi;
  const role = String(j.role_title || "").trim();
  if (role) return role;
  const systemStatus = String(j.system_status || "").trim().toUpperCase();
  if (systemStatus === "AI_UNAVAILABLE") return "(Needs AI)";
  if (systemStatus === "NEEDS_MANUAL_JD") return "(Needs JD)";
  return "(Untitled)";
}

function getDisplayCompany(j) {
  return j.company || j.display_company || j.source_domain || "";
}

function getIngestChannel(j) {
  const raw = String(j?.ingest_channel || j?.fetch_debug?.ingest_channel || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("rss")) return "rss";
  if (raw.startsWith("gmail")) return "gmail";
  if (raw.startsWith("recover")) return "recover";
  if (raw.startsWith("manual")) return "manual";
  if (raw.startsWith("api")) return "api";
  if (raw.startsWith("ui")) return "ui";
  return raw;
}

function getIngestChannelLabel(j) {
  const ch = getIngestChannel(j);
  if (!ch || ch === "ui") return "";
  if (ch === "rss") return "RSS";
  if (ch === "gmail") return "Gmail";
  if (ch === "recover") return "Recover";
  if (ch === "manual") return "Manual";
  if (ch === "api") return "API";
  return ch.toUpperCase();
}

function showView(view) {
  state.view = view;
  document.body.dataset.view = view;
  if (view !== "jobs" && document.body.classList.contains("pdf-ready-mode")) {
    setPdfReadyMode_(false);
  }
  const jobsView = $("jobsView");
  const trackingView = $("trackingView");
  const targetsView = $("targetsView");
  const metricsView = $("metricsView");
  jobsView.classList.toggle("hidden", view !== "jobs");
  trackingView.classList.toggle("hidden", view !== "tracking");
  targetsView.classList.toggle("hidden", view !== "targets");
  metricsView.classList.toggle("hidden", view !== "metrics");

  $("btnTabJobs").classList.toggle("active-tab", view === "jobs");
  $("btnTabTracking").classList.toggle("active-tab", view === "tracking");
  $("btnTabTargets").classList.toggle("active-tab", view === "targets");
  $("btnTabMetrics").classList.toggle("active-tab", view === "metrics");
  $("btnMobileJobs")?.classList.toggle("active-tab", view === "jobs");
  $("btnMobileTracking")?.classList.toggle("active-tab", view === "tracking");

  const jobsActionsHidden = view !== "jobs";
  $("btnAdd").classList.toggle("hidden", jobsActionsHidden);
  $("btnRescore").classList.toggle("hidden", jobsActionsHidden);

  if (view === "tracking" && isSmallMobile_()) {
    state.trackingFiltersOpen = false;
  }
  syncTrackingControlsUi_();

  if (view === "tracking") {
    if (!state.jobs.length) loadJobs({ ignoreStatus: true });
    else renderTracking();
    loadTrackingTriage({ force: false });
  }
  if (view === "targets") loadTargets();
  if (view === "metrics") loadMetrics();
}

function isSmallMobile_() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function syncTrackingControlsUi_() {
  const extras = $("trackingControlsExtras");
  const toggleBtn = $("btnTrackingFiltersToggle");
  if (!extras || !toggleBtn) return;

  if (!isSmallMobile_()) {
    toggleBtn.classList.add("hidden");
    extras.classList.remove("hidden");
    return;
  }

  toggleBtn.classList.remove("hidden");
  extras.classList.toggle("hidden", !state.trackingFiltersOpen);
  toggleBtn.textContent = state.trackingFiltersOpen ? "Hide filters" : "Filters";
}

function fmtNum(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function fmtTsAbs(v) {
  const n = Number(v || 0);
  if (!n) return "-";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTs(v) {
  const n = Number(v || 0);
  if (!n) return "-";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "-";

  const now = Date.now();
  const diffMs = now - n;
  if (!Number.isFinite(diffMs)) return fmtTsAbs(n);
  if (diffMs < 0) return fmtTsAbs(n);

  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;
  const month = 30 * day;
  const year = 365 * day;

  if (diffMs < min) return "just now";
  if (diffMs < hr) return `${Math.floor(diffMs / min)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hr)}h ago`;
  if (diffMs < 2 * day) return "yesterday";
  if (diffMs < month) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs < year) return `${Math.floor(diffMs / month)}mo ago`;
  return `${Math.floor(diffMs / year)}y ago`;
}

function fmtTsWithAbs(v) {
  const rel = fmtTs(v);
  const abs = fmtTsAbs(v);
  if (rel === "-" || abs === "-") return rel;
  return `${rel} (${abs})`;
}

function normalizeEpochMsUi_(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 100000000000 ? Math.round(n * 1000) : Math.round(n);
}

function fmtDaysAgo_(days) {
  const d = Math.max(0, Math.round(Number(days || 0)));
  if (d === 0) return "today";
  if (d === 1) return "1 day";
  return `${d} days`;
}

function triagePriorityClass_(priority) {
  const p = String(priority || "").trim().toUpperCase();
  if (p.startsWith("RESPONSE_PENDING")) return "chip-priority-reply";
  if (p.startsWith("FOLLOW_UP")) return "chip-priority-stale";
  return "";
}

function metricCard(label, value, sub = "") {
  return `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(fmtNum(value))}</div>
      <div class="metric-sub">${escapeHtml(sub)}</div>
    </div>
  `;
}

function renderMetrics() {
  const m = state.metrics || {};
  const statuses = m.statuses || {};
  const systems = m.systems || {};
  const totals = m.totals || {};
  const gmailLatest = m.gmail?.latest || {};
  const gmail24 = m.gmail?.last_24h || {};

  $("metricsGeneratedAt").value = fmtTsAbs(m.generated_at);
  $("metricsHint").textContent = `Jobs: ${fmtNum(totals.jobs_total)} | Gmail polls (24h): ${fmtNum(gmail24.poll_runs)} | Avg score: ${totals.avg_final_score ?? "-"}`;

  $("metricsCards").innerHTML = [
    metricCard("SHORTLISTED", statuses.SHORTLISTED || 0, "ready-to-apply"),
    metricCard("REJECTED", statuses.REJECTED || 0, "screened out"),
    metricCard("ARCHIVED", statuses.ARCHIVED || 0, "parked"),
    metricCard("LINK_ONLY", statuses.LINK_ONLY || 0, "needs enrichment"),
    metricCard("NEEDS_MANUAL_JD", systems.NEEDS_MANUAL_JD || 0, "manual JD required"),
    metricCard("AI_UNAVAILABLE", systems.AI_UNAVAILABLE || 0, "AI config missing"),
    metricCard("Ingested (24h)", gmail24.inserted_or_updated || 0, "inserted + updated"),
    metricCard("Skipped Existing (24h)", gmail24.skipped_existing || 0, "dedupe hits"),
    metricCard("Promo Rejected (24h)", gmail24.skipped_promotional || 0, "ads/premium/newsletters"),
    metricCard("Latest Scanned", gmailLatest.scanned || 0, `query: ${gmailLatest.query_used || "-"}`),
    metricCard("Latest Processed", gmailLatest.processed || 0, `at ${fmtTsWithAbs(gmailLatest.ts)}`),
    metricCard("Scored Jobs", totals.scored_jobs || 0, "jobs with final_score"),
  ].join("");

  const sources = Array.isArray(m.sources) ? m.sources : [];
  $("metricsSources").innerHTML = sources.length
    ? `<ul class="metrics-list">${sources.map((s) => `<li><b>${escapeHtml(s.source || "unknown")}:</b> ${escapeHtml(fmtNum(s.count || 0))}</li>`).join("")}</ul>`
    : "-";

  const events = Array.isArray(m.events_last_24h) ? m.events_last_24h : [];
  $("metricsEvents").innerHTML = events.length
    ? `<ul class="metrics-list">${events.map((e) => `<li><b>${escapeHtml(e.event_type || "-")}:</b> ${escapeHtml(fmtNum(e.count || 0))}</li>`).join("")}</ul>`
    : "-";
}

async function loadMetrics() {
  try {
    spin(true);
    const res = await api("/metrics");
    state.metrics = res.data || {};
    renderMetrics();
  } catch (e) {
    $("metricsHint").textContent = "Metrics load failed";
    toast("Metrics failed: " + e.message);
  } finally {
    spin(false);
  }
}

function isNeedsAttentionJob(j) {
  const status = String(j.status || "").trim().toUpperCase();
  const systemStatus = String(j.system_status || "").trim().toUpperCase();
  const jdConfidence = String(j.jd_confidence || j.fetch_debug?.jd_confidence || "").trim().toLowerCase();
  if (status === "LINK_ONLY") return true;
  if (systemStatus === "NEEDS_MANUAL_JD" || systemStatus === "AI_UNAVAILABLE") return true;
  if (jdConfidence === "low") return true;
  return false;
}

function isMissingDetailsJob(j) {
  const role = String(j.role_title || "").trim();
  const company = String(j.company || "").trim();
  const status = String(j.status || "").trim().toUpperCase();
  const systemStatus = String(j.system_status || "").trim().toUpperCase();
  if (status === "LINK_ONLY") return true;
  if (systemStatus === "NEEDS_MANUAL_JD" || systemStatus === "AI_UNAVAILABLE") return true;
  return !role || !company;
}

function filterJobs(jobs, status, q, queue) {
  let out = jobs;
  if (status) out = out.filter((j) => String(j.status || "").toUpperCase() === status);
  if (queue === "needs_attention") out = out.filter(isNeedsAttentionJob);
  if (q) {
    out = out.filter((j) => {
      const s = `${getDisplayTitle(j)} ${j.company || ""} ${j.location || ""} ${j.source_domain || ""}`.toLowerCase();
      return s.includes(q);
    });
  }
  return out;
}

function sortJobs(jobs, sortBy) {
  const list = Array.isArray(jobs) ? [...jobs] : [];
  const mode = String(sortBy || "updated_desc").toLowerCase();
  const num = (v) => {
    const n = Number(v || 0);
    return Number.isFinite(n) ? n : 0;
  };

  const byTitle = (a, b) => {
    const ta = getDisplayTitle(a).toLowerCase();
    const tb = getDisplayTitle(b).toLowerCase();
    return ta.localeCompare(tb);
  };

  if (mode === "updated_asc") return list.sort((a, b) => num(a.updated_at) - num(b.updated_at));
  if (mode === "created_desc") return list.sort((a, b) => num(b.created_at) - num(a.created_at));
  if (mode === "created_asc") return list.sort((a, b) => num(a.created_at) - num(b.created_at));
  if (mode === "score_desc") return list.sort((a, b) => num(b.final_score) - num(a.final_score));
  if (mode === "score_asc") return list.sort((a, b) => num(a.final_score) - num(b.final_score));
  if (mode === "title_asc") return list.sort(byTitle);
  return list.sort((a, b) => num(b.updated_at) - num(a.updated_at)); // updated_desc default
}

function renderListMeta() {
  const status = $("statusFilter").value;
  const queue = $("queueFilter")?.value || "";
  const q = $("search").value.trim().toLowerCase();
  const filtered = sortJobs(filterJobs(state.jobs, status, q, queue), $("sortBy")?.value || "updated_desc");
  const parts = [`${filtered.length} job(s)`];
  if (status) parts.push(status);
  if (queue === "needs_attention") parts.push("Needs Attention");
  $("listHint").textContent = parts.join(" - ");
}

function getPrimaryActionForJob_(job) {
  const status = String(job?.status || "").trim().toUpperCase();
  if (status === "NEW" || status === "LINK_ONLY") {
    return { id: "score", label: "Score Job" };
  }
  if (status === "SCORED" || status === "SHORTLISTED") {
    return { id: "generate_pack", label: "Generate Pack" };
  }
  if (status === "READY_TO_APPLY" || status === "APPLIED") {
    return { id: "copy_apply", label: "Copy & Apply" };
  }
  return { id: "open", label: "Open" };
}

function jobCard(j) {
  const score = (j.final_score === null || j.final_score === undefined) ? "-" : j.final_score;
  const loc = j.location || "-";
  const comp = getDisplayCompany(j) || "-";
  const role = getDisplayTitle(j);
  const updatedAt = fmtTs(j.updated_at);
  const createdAt = fmtTs(j.created_at);
  const updatedAtAbs = fmtTsAbs(j.updated_at);
  const createdAtAbs = fmtTsAbs(j.created_at);
  const status = String(j.status || "").toUpperCase();
  const systemStatus = String(j.system_status || "").toUpperCase();
  const ingestChannelLabel = getIngestChannelLabel(j);
  const ingestChannelChip = ingestChannelLabel
    ? `<span class="chip chip-ingest">${escapeHtml(ingestChannelLabel)}</span>`
    : "";
  const needsJdBadge = systemStatus === "NEEDS_MANUAL_JD"
    ? `<span class="chip">Needs JD</span>`
    : "";
  const primaryAction = getPrimaryActionForJob_(j);
  const isActive = state.activeKey === j.job_key;

  return `
    <div class="job-card ${isActive ? "active" : ""}" data-key="${escapeHtml(j.job_key)}" tabindex="0">
      <div class="row1">
        <div>
          <div class="title">${escapeHtml(role)}</div>
          <div class="sub">${escapeHtml(comp)} - ${escapeHtml(loc)}</div>
          <div class="sub tiny">
            Updated: <span title="${escapeHtml(updatedAtAbs)}">${escapeHtml(updatedAt)}</span>
            | Created: <span title="${escapeHtml(createdAtAbs)}">${escapeHtml(createdAt)}</span>
          </div>
        </div>
        <div class="score" title="Final score">${escapeHtml(String(score))}</div>
      </div>
      <div class="meta">
        <span class="badge ${escapeHtml(status)}">${escapeHtml(status || "-")}</span>
        ${needsJdBadge}
        ${ingestChannelChip}
        <span class="chip">${escapeHtml(j.source_domain || "-")}</span>
        <span class="chip">${escapeHtml(j.seniority || "-")}</span>
      </div>
      <div class="row" style="justify-content:flex-start; margin-top:10px;">
        <button
          class="btn"
          type="button"
          onclick="event.stopPropagation(); runJobPrimaryAction('${escapeHtml(j.job_key)}','${escapeHtml(primaryAction.id)}')"
        >${escapeHtml(primaryAction.label)}</button>
      </div>
    </div>
  `;
}

function renderJobs() {
  const status = $("statusFilter").value;
  const queue = $("queueFilter")?.value || "";
  const q = $("search").value.trim().toLowerCase();
  const filtered = sortJobs(filterJobs(state.jobs, status, q, queue), $("sortBy")?.value || "updated_desc");
  const container = $("jobList");
  container.innerHTML = filtered.map(jobCard).join("") || `<div class="muted">No jobs found.</div>`;

  container.querySelectorAll(".job-card").forEach((el) => {
    el.addEventListener("click", () => setActive(el.dataset.key));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") setActive(el.dataset.key);
    });
  });
}

function trackingCard(j) {
  const title = getDisplayTitle(j);
  const company = getDisplayCompany(j) || "-";
  const score = (j.final_score === null || j.final_score === undefined) ? "-" : j.final_score;
  const updated = fmtTs(j.updated_at);
  const updatedAbs = fmtTsAbs(j.updated_at);
  const status = String(j.status || "").toUpperCase();
  const ingestChannelLabel = getIngestChannelLabel(j);
  const needsAttention = isNeedsAttentionJob(j);

  return `
    <div class="track-card" data-track-key="${escapeHtml(j.job_key)}">
      <div class="track-row">
        <div class="track-title">${escapeHtml(title)}</div>
        <div class="track-score">${escapeHtml(String(score))}</div>
      </div>
      <div class="track-sub">${escapeHtml(company)} - ${escapeHtml(j.source_domain || "-")}</div>
      <div class="track-sub tiny">Updated: <span title="${escapeHtml(updatedAbs)}">${escapeHtml(updated)}</span></div>
      <div class="track-meta">
        <span class="badge ${escapeHtml(status)}">${escapeHtml(status || "-")}</span>
        ${ingestChannelLabel ? `<span class="chip chip-ingest">${escapeHtml(ingestChannelLabel)}</span>` : ""}
        ${needsAttention ? `<span class="chip">Needs Attention</span>` : ""}
      </div>
      <div class="track-actions">
        <button class="btn btn-ghost btn-xs" data-track-action="open" data-track-key="${escapeHtml(j.job_key)}">Open</button>
        <button class="btn btn-ghost btn-xs" data-track-action="pdf" data-track-key="${escapeHtml(j.job_key)}">PDF</button>
        <button class="btn btn-ghost btn-xs" data-track-action="shortlist" data-track-key="${escapeHtml(j.job_key)}">Shortlist</button>
        <button class="btn btn-ghost btn-xs" data-track-action="applied" data-track-key="${escapeHtml(j.job_key)}">Applied</button>
        <button class="btn btn-ghost btn-xs" data-track-action="archive" data-track-key="${escapeHtml(j.job_key)}">Archive</button>
      </div>
    </div>
  `;
}

function triageCard(item) {
  const it = item && typeof item === "object" ? item : {};
  const touchpointId = String(it.touchpoint_id || "").trim();
  const jobKey = String(it.job_key || "").trim();
  const contactId = String(it.contact_id || "").trim();
  const channel = String(it.channel || "OTHER").trim().toUpperCase() || "OTHER";
  const status = String(it.status || "DRAFT").trim().toUpperCase() || "DRAFT";
  const priority = String(it.priority || "NORMAL").trim().toUpperCase() || "NORMAL";
  const priorityClass = triagePriorityClass_(priority);
  const score = (it.final_score === null || it.final_score === undefined) ? "-" : String(it.final_score);
  const title = String(it.contact_name || "Unknown Contact").trim();
  const role = String(it.contact_title || "").trim();
  const company = String(it.company || it.contact_company || "-").trim() || "-";
  const jobRole = String(it.role_title || "").trim();
  const hasDraft = Boolean(String(it.touchpoint_content || "").trim());
  const updatedAt = normalizeEpochMsUi_(it.touchpoint_updated_at);
  const daysLabel = fmtDaysAgo_(it.days_in_stage);
  const queueLabel = String(it.queue || "").trim().replaceAll("_", " ").toUpperCase();

  return `
    <div class="track-card" data-triage-id="${escapeHtml(touchpointId)}">
      <div class="track-row">
        <div class="track-title">${escapeHtml(title)}${role ? ` - ${escapeHtml(role)}` : ""}</div>
        <div class="track-score">${escapeHtml(score)}</div>
      </div>
      <div class="track-sub">${escapeHtml(jobRole || "(Role missing)")} - ${escapeHtml(company)}</div>
      <div class="track-sub tiny">Touchpoint: <span title="${escapeHtml(fmtTsAbs(updatedAt))}">${escapeHtml(fmtTs(updatedAt))}</span> | In stage: ${escapeHtml(daysLabel)}</div>
      <div class="track-card-priority">
        <span class="chip ${escapeHtml(priorityClass)}">${escapeHtml(priority)}</span>
        <span class="chip">${escapeHtml(status)} / ${escapeHtml(channel)}</span>
        <span class="chip">${escapeHtml(queueLabel || "GENERAL")}</span>
      </div>
      <div class="track-actions">
        <button class="btn btn-ghost btn-xs" data-triage-action="open" data-triage-id="${escapeHtml(touchpointId)}" data-triage-job="${escapeHtml(jobKey)}">Open</button>
        <button class="btn btn-ghost btn-xs" data-triage-action="copy" data-triage-id="${escapeHtml(touchpointId)}" ${hasDraft ? "" : "disabled"}>Copy Draft</button>
        <button class="btn btn-ghost btn-xs" data-triage-action="sent" data-triage-id="${escapeHtml(touchpointId)}" data-triage-job="${escapeHtml(jobKey)}" data-triage-contact="${escapeHtml(contactId)}" data-triage-channel="${escapeHtml(channel)}" ${status === "SENT" ? "disabled" : ""}>Mark Sent</button>
        <button class="btn btn-ghost btn-xs" data-triage-action="replied" data-triage-id="${escapeHtml(touchpointId)}" data-triage-job="${escapeHtml(jobKey)}" data-triage-contact="${escapeHtml(contactId)}" data-triage-channel="${escapeHtml(channel)}" ${status === "REPLIED" ? "disabled" : ""}>Mark Replied</button>
      </div>
    </div>
  `;
}

function renderTrackingTriage_() {
  const triage = state.triage || {};
  const pulse = (triage.pulse && typeof triage.pulse === "object") ? triage.pulse : {};
  const items = Array.isArray(triage.items) ? triage.items : [];
  const staleDays = Number(triage.stale_days || $("trackingTriageDays")?.value || 3);
  const hintEl = $("trackingTriageHint");
  const listEl = $("trackingTriageList");

  $("pulseGoldLeads").textContent = String(pulse.gold_leads_count || 0);
  $("pulseReplies").textContent = String(pulse.replies_7d_count || 0);
  $("pulseStale").textContent = String(pulse.stale_followups_count || 0);

  if (!listEl || !hintEl) return;

  if (triage.loading) {
    hintEl.textContent = `Loading triage (stale >= ${staleDays} days)...`;
    return;
  }

  if (triage.error) {
    hintEl.textContent = `Triage load failed: ${triage.error}`;
    listEl.innerHTML = `<div class="muted tiny">No triage actions available.</div>`;
    return;
  }

  hintEl.textContent = `${items.length} actions | Reply pending: ${pulse.reply_pending_count || 0} | Stale follow-ups (${staleDays}d): ${pulse.stale_followups_count || 0}`;
  listEl.innerHTML = items.length
    ? items.map(triageCard).join("")
    : `<div class="muted tiny">No daily actions right now.</div>`;

  document.querySelectorAll("[data-triage-action][data-triage-id]").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const action = String(el.getAttribute("data-triage-action") || "").trim().toLowerCase();
      const touchpointId = String(el.getAttribute("data-triage-id") || "").trim();
      const jobKey = String(el.getAttribute("data-triage-job") || "").trim();
      const contactId = String(el.getAttribute("data-triage-contact") || "").trim();
      const channel = String(el.getAttribute("data-triage-channel") || "").trim().toUpperCase() || "OTHER";
      await handleTrackingTriageAction_(action, { touchpointId, jobKey, contactId, channel });
    });
  });
}

async function loadTrackingTriage({ force = false } = {}) {
  const triageDays = Math.max(1, Math.min(21, Number($("trackingTriageDays")?.value || state.triage?.stale_days || 3) || 3));
  const now = Date.now();
  const cacheFresh = (now - Number(state.triage?.last_fetched_at || 0)) < 15000;
  const sameWindow = Number(state.triage?.stale_days || 3) === triageDays;
  if (!force && cacheFresh && sameWindow) {
    renderTrackingTriage_();
    return;
  }
  if (state.triage.loading) return;

  state.triage.loading = true;
  state.triage.error = "";
  state.triage.stale_days = triageDays;
  renderTrackingTriage_();

  try {
    const res = await api(`/dashboard/triage?stale_days=${encodeURIComponent(String(triageDays))}&limit=80&gold_limit=3`);
    const data = res?.data && typeof res.data === "object" ? res.data : {};
    const allItems = Array.isArray(data?.queues?.all) ? data.queues.all : [];
    const pulse = data?.pulse && typeof data.pulse === "object" ? data.pulse : {};
    const byTouchpointId = {};
    for (const row of allItems) {
      const tid = String(row?.touchpoint_id || "").trim();
      if (!tid) continue;
      byTouchpointId[tid] = row;
    }

    state.triage.items = allItems;
    state.triage.by_touchpoint_id = byTouchpointId;
    state.triage.pulse = pulse;
    state.triage.generated_at = normalizeEpochMsUi_(data.generated_at);
    state.triage.stale_days = Number(data.stale_days || triageDays) || triageDays;
    state.triage.last_fetched_at = Date.now();
    state.triage.error = "";
  } catch (e) {
    state.triage.error = String(e?.message || "unknown error");
  } finally {
    state.triage.loading = false;
    renderTrackingTriage_();
  }
}

async function handleTrackingTriageAction_(action, ctx = {}) {
  const act = String(action || "").trim().toLowerCase();
  const touchpointId = String(ctx.touchpointId || "").trim();
  const row = state.triage?.by_touchpoint_id?.[touchpointId] || null;
  const jobKey = String(ctx.jobKey || row?.job_key || "").trim();
  const contactId = String(ctx.contactId || row?.contact_id || "").trim();
  const channel = String(ctx.channel || row?.channel || "OTHER").trim().toUpperCase() || "OTHER";

  if (act === "open") {
    if (!jobKey) return;
    showView("jobs");
    await setActive(jobKey);
    return;
  }

  if (act === "copy") {
    const draft = String(row?.touchpoint_content || "").trim();
    if (!draft) return toast("No draft content available", { kind: "error" });
    try {
      await navigator.clipboard.writeText(draft);
      toast("Outreach draft copied");
    } catch {
      toast("Copy failed", { kind: "error" });
    }
    return;
  }

  const statusMap = {
    sent: "SENT",
    replied: "REPLIED",
    draft: "DRAFT",
  };
  const nextStatus = statusMap[act] || "";
  if (!nextStatus || !jobKey || !contactId) return;

  try {
    spin(true);
    await api(`/jobs/${encodeURIComponent(jobKey)}/contacts/${encodeURIComponent(contactId)}/touchpoint-status`, {
      method: "POST",
      body: {
        channel,
        status: nextStatus,
      },
    });
    toast(`Touchpoint marked ${nextStatus}`);
    await loadTrackingTriage({ force: true });
  } catch (e) {
    toast("Touchpoint update failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

async function handleTrackingAction(action, jobKey) {
  const key = String(jobKey || "").trim();
  if (!key) return;
  if (action === "open") {
    showView("jobs");
    await setActive(key);
    return;
  }
  if (action === "pdf") {
    try {
      spin(true);
      const d = await ensureRrPdfForJob_(key, { forceExport: false });
      const pdfUrl = String(d?.rr_pdf_url || "").trim();
      if (!pdfUrl) throw new Error("PDF URL not available after export");
      window.open(pdfUrl, "_blank", "noopener");
      toast("PDF ready");
    } catch (e) {
      toast("PDF failed: " + e.message);
    } finally {
      spin(false);
    }
    return;
  }
  const setTrackingStatus = async (status) => {
    if (status === "ARCHIVED" && !confirm("Mark this job as ARCHIVED?")) return;
    try {
      spin(true);
      await api(`/jobs/${encodeURIComponent(key)}/status`, { method: "POST", body: { status } });
      toast(`Status updated: ${status}`);
      await loadJobs({ ignoreStatus: true });
    } catch (e) {
      toast("Status failed: " + e.message);
    } finally {
      spin(false);
    }
  };
  if (action === "shortlist") {
    await setTrackingStatus("SHORTLISTED");
    return;
  }
  if (action === "applied") {
    await setTrackingStatus("APPLIED");
    return;
  }
  if (action === "archive") {
    await setTrackingStatus("ARCHIVED");
    return;
  }
}

async function ensureRrPdfForJob_(jobKey, { forceExport = false } = {}) {
  const key = String(jobKey || "").trim();
  if (!key) throw new Error("Missing job key");
  const profileId = String(state.activeProfileId || "primary").trim() || "primary";

  let pack = null;
  try {
    const q = `?profile_id=${encodeURIComponent(profileId)}`;
    const res = await api(`/jobs/${encodeURIComponent(key)}/application-pack${q}`);
    pack = res?.data || null;
  } catch (e) {
    if (e.httpStatus !== 404) throw e;
  }

  const existingPdfUrl = String(pack?.rr_pdf_url || "").trim();
  if (existingPdfUrl && !forceExport) {
    return { rr_pdf_url: existingPdfUrl, source: "existing" };
  }
  const packReadiness = pack?.pdf_readiness && typeof pack.pdf_readiness === "object" ? pack.pdf_readiness : null;
  if (packReadiness && !packReadiness.ready && !forceExport) {
    const firstIssue = Array.isArray(packReadiness.failed_checks) && packReadiness.failed_checks.length
      ? String(packReadiness.failed_checks[0]?.detail || packReadiness.failed_checks[0]?.label || packReadiness.failed_checks[0]?.id || "")
      : "";
    throw new Error(firstIssue || "PDF readiness gate failed");
  }

  if (!pack) {
    const onePagerStrict = getOnePagerStrictPref_();
    await api(`/jobs/${encodeURIComponent(key)}/generate-application-pack`, {
      method: "POST",
      body: {
        profile_id: profileId,
        force: false,
        renderer: "reactive_resume",
        one_pager_strict: onePagerStrict,
      },
    });
  }

  const exportRes = await api(`/jobs/${encodeURIComponent(key)}/export-reactive-resume-pdf`, {
    method: "POST",
    body: {
      profile_id: profileId,
      force: Boolean(forceExport),
    },
  });
  return exportRes?.data || {};
}

function renderTracking() {
  const q = String($("trackingSearch")?.value || "").trim().toLowerCase();
  const sort = String($("trackingSort")?.value || "updated_desc").trim();
  const queue = String($("trackingQueue")?.value || "all").trim().toLowerCase();
  const scope = String($("trackingScope")?.value || "active_only").trim().toLowerCase();
  const windowDays = Number($("trackingWindow")?.value || 14);
  const perColumn = Math.max(1, Number($("trackingLimit")?.value || 20));
  const activeOnlyStatuses = new Set(["NEW", "SCORED", "SHORTLISTED", "READY_TO_APPLY", "APPLIED", "LINK_ONLY"]);
  const boardStatuses = scope === "active_only"
    ? TRACKING_COLUMNS.filter((s) => activeOnlyStatuses.has(s))
    : TRACKING_COLUMNS;

  const now = Date.now();
  const windowMs = Number.isFinite(windowDays) && windowDays > 0 ? windowDays * 24 * 60 * 60 * 1000 : 0;

  const scoped = (Array.isArray(state.jobs) ? state.jobs : []).filter((j) => {
    const status = String(j.status || "").toUpperCase();
    if (scope === "active_only" && !activeOnlyStatuses.has(status)) return false;
    if (!windowMs) return true;
    const ts = Number(j.updated_at || j.created_at || 0);
    return ts >= (now - windowMs);
  });

  let filtered = sortJobs(filterJobs(scoped, "", q, ""), sort);
  if (queue === "needs_attention") filtered = filtered.filter(isNeedsAttentionJob);
  if (queue === "missing_details") filtered = filtered.filter(isMissingDetailsJob);

  const needsAttentionAll = filtered.filter(isNeedsAttentionJob);
  const missingDetailsAll = filtered.filter(isMissingDetailsJob);
  const needsAttention = needsAttentionAll.slice(0, perColumn);
  const byStatus = new Map(boardStatuses.map((s) => [s, []]));
  for (const j of filtered) {
    const s = String(j.status || "").toUpperCase();
    if (!byStatus.has(s)) continue;
    byStatus.get(s).push(j);
  }

  $("trackingNeedsCount").textContent = String(needsAttentionAll.length);
  $("trackingMissingCount").textContent = String(missingDetailsAll.length);
  $("trackingNeedsList").innerHTML = needsAttention.length
    ? `
      ${needsAttention.map(trackingCard).join("")}
      ${needsAttentionAll.length > needsAttention.length
        ? `<div class="muted tiny">+${needsAttentionAll.length - needsAttention.length} more (raise Per Column to view)</div>`
        : ""}
    `
    : `<div class="muted tiny">No jobs need attention right now.</div>`;

  $("trackingBoard").innerHTML = boardStatuses.map((status) => {
    const allItems = byStatus.get(status) || [];
    const items = allItems.slice(0, perColumn);
    const hiddenCount = Math.max(0, allItems.length - items.length);
    return `
      <section class="tracking-col">
        <div class="tracking-col-head">
          <div class="h3">${escapeHtml(status)}</div>
          <span class="chip">${escapeHtml(String(allItems.length))}</span>
        </div>
        <div class="tracking-col-body">
          ${items.length ? items.map(trackingCard).join("") : `<div class="muted tiny">No jobs</div>`}
          ${hiddenCount ? `<div class="muted tiny">+${hiddenCount} more (raise Per Column)</div>` : ""}
        </div>
      </section>
    `;
  }).join("");

  const scopeLabel = scope === "active_only" ? "active statuses" : "all statuses";
  const windowLabel = windowMs ? `${windowDays}d` : "all time";
  const queueLabel =
    queue === "needs_attention" ? "needs attention only" :
    queue === "missing_details" ? "missing details only" :
    "all queues";
  $("trackingHint").textContent = `${filtered.length} jobs on board (${scopeLabel}, ${queueLabel}, window ${windowLabel}, cap ${perColumn}/column)`;
  renderTrackingRecoverySummary_();

  document.querySelectorAll("[data-track-action][data-track-key]").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const action = String(el.getAttribute("data-track-action") || "").trim().toLowerCase();
      const key = String(el.getAttribute("data-track-key") || "").trim();
      await handleTrackingAction(action, key);
    });
  });
}

function renderTrackingRecoverySummary_() {
  const el = $("trackingRecoverySummary");
  if (!el) return;

  const last = state.lastRecoveryRun;
  if (!last || !Number(last.ts)) {
    el.textContent = "Recovery Snapshot: no manual recovery run in this browser yet.";
    return;
  }

  const sourceSummary = Array.isArray(last.source_summary) ? last.source_summary : [];
  const sourceText = sourceSummary.length
    ? sourceSummary
      .slice(0, 3)
      .map((s) => {
        const src = String(s.source_domain || "unknown");
        const recovered = Number(s.recovered || 0);
        const manual = Number(s.manual_needed || 0);
        const needsAi = Number(s.needs_ai || 0);
        return `${src}: rec ${recovered}, manual ${manual}, ai ${needsAi}`;
      })
      .join(" | ")
    : "source summary unavailable";

  el.textContent = `Recovery Snapshot (${fmtTsWithAbs(last.ts)}): fetch processed ${fmtNum(last.fetch_processed || 0)}, fetch updated ${fmtNum(last.fetch_updated || 0)}, fields updated ${fmtNum(last.fields_updated || 0)}, rescore updated ${fmtNum(last.rescore_updated || 0)}/${fmtNum(last.rescore_picked || 0)}. ${sourceText}`;
}

async function loadJobs(opts = {}) {
  try {
    spin(true);
    const ignoreStatus = Boolean(opts?.ignoreStatus);
    const status = ignoreStatus ? "" : $("statusFilter").value;
    const qs = status ? `?status=${encodeURIComponent(status)}&limit=200&offset=0` : `?limit=200&offset=0`;
    const res = await api("/jobs" + qs);
    state.jobs = Array.isArray(res.data) ? res.data : [];
    renderJobs();
    renderListMeta();
    if (state.view === "tracking") {
      renderTracking();
      loadTrackingTriage({ force: false });
    }
    if (state.activeKey && !state.jobs.some((j) => j.job_key === state.activeKey)) {
      setActive(null);
    }
  } catch (e) {
    toast("Load failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function setActive(jobKey) {
  state.activeKey = jobKey;
  renderJobs();
  renderListMeta();

  if (!jobKey) {
    setPdfReadyMode_(false);
    $("dRole").textContent = "Select a job";
    $("dCompany").textContent = "";
    $("detailBody").classList.add("empty");
    $("detailBody").innerHTML = `
      <div class="empty-state">
        <div class="empty-hero">Select a row</div>
        <div class="h3">Pick a job from the list.</div>
        <div class="muted">Update status, rescore, or paste JD if needed.</div>
      </div>
    `;
    return;
  }

  try {
    spin(true);
    const res = await api("/jobs/" + encodeURIComponent(jobKey));
    await loadJobProfilePreference_(jobKey, { silent: true });
    renderDetail(res.data);
  } catch (e) {
    toast("Open failed: " + e.message);
  } finally {
    spin(false);
  }
}

function setWizardStep_(stepName, opts = {}) {
  const section = $("appPackSection");
  if (!section) return;
  const step = normalizeWizardStep_(stepName);
  const persist = opts.persist === undefined ? true : Boolean(opts.persist);
  const jobKey = String(opts.jobKey || state.activeJob?.job_key || "").trim();
  section.dataset.wizardStep = step;
  section.querySelectorAll("[data-wizard-pane]").forEach((pane) => {
    const isActive = pane.dataset.wizardPane === step;
    pane.classList.toggle("hidden", !isActive);
  });
  section.querySelectorAll("[data-wizard-node]").forEach((node) => {
    const nodeStep = String(node.dataset.wizardNode || "").trim().toLowerCase();
    const nodeOrder = Number(node.dataset.wizardOrder || 0);
    const stepOrder = step === "matches" ? 1 : (step === "pitch" ? 2 : 3);
    node.classList.toggle("active", nodeStep === step);
    node.classList.toggle("done", nodeOrder > 0 && nodeOrder < stepOrder);
  });
  if (persist && jobKey) {
    saveWizardStepPref_(jobKey, step);
  }
  syncWizardStickyCta_();
}

function resolveWizardStep_(job, packStatus = "") {
  const jobKey = String(job?.job_key || "").trim();
  const jobStatus = String(job?.status || "").trim().toUpperCase();
  const draftStatus = String(packStatus || "").trim().toUpperCase();
  let serverStep = "matches";
  if (jobStatus === "READY_TO_APPLY" || jobStatus === "APPLIED") serverStep = "finish";
  else if (draftStatus === "CONTENT_REVIEW_REQUIRED") serverStep = "pitch";

  const savedStep = loadWizardStepPref_(jobKey);
  if (!savedStep) return serverStep;

  const canUseSavedPitch = (serverStep === "pitch" || serverStep === "finish");
  if (!canUseSavedPitch && savedStep !== "matches") return serverStep;

  return wizardStepOrder_(savedStep) >= wizardStepOrder_(serverStep) ? savedStep : serverStep;
}

function updateNextActionCard_(job, { hasPack = false } = {}) {
  const section = $("appPackSection");
  if (!section) return;
  const titleEl = $("wsNextActionTitle");
  const noteEl = $("wsNextActionNote");
  const btnEl = $("wsNextActionBtn");
  if (!titleEl || !noteEl || !btnEl) return;

  const needsManual = String(job?.system_status || "").toUpperCase() === "NEEDS_MANUAL_JD";
  let title = "Auto-tailor this job";
  let note = "Score + generate ATS/resume outputs in one step.";
  let action = "auto_pilot";
  let btnLabel = "Auto Tailor";

  if (needsManual) {
    title = "Paste JD and rescore";
    note = "This job is blocked by low-quality fetch. Add JD text first.";
    action = "go_jd";
    btnLabel = "Go to JD step";
  } else if (hasPack) {
    title = "Copy & Apply";
    note = "Review the pitch, approve, and copy the final letter.";
    action = "copy_apply";
    btnLabel = "Copy & Apply";
  }

  section.dataset.nextAction = action;
  titleEl.textContent = title;
  noteEl.textContent = note;
  btnEl.textContent = btnLabel;
}

async function runNextAction() {
  const section = $("appPackSection");
  const action = String(section?.dataset?.nextAction || "").trim().toLowerCase();
  const jobKey = String(state.activeJob?.job_key || "").trim();
  if (!action) return;
  if (action === "go_jd") {
    setWizardStep_("matches");
    openWizardAdvancedDrawer_({ focusJd: true });
    return;
  }
  if (action === "go_action") return;
  if (action === "copy_apply" && jobKey) {
    setWizardStep_("finish");
    return;
  }
  if (action === "auto_pilot" && jobKey) {
    await autoPilotJob(jobKey, { force: false });
    return;
  }
  if (action === "generate_pack" && jobKey) {
    await generateApplicationPack(jobKey, false);
    return;
  }
}

function openWizardAdvancedDrawer_({ focusJd = false } = {}) {
  const drawer = $("wizardAdvancedDrawer");
  if (drawer) {
    drawer.open = true;
    drawer.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (focusJd) $("jdCurrentText")?.focus();
}

function syncWizardStickyCta_() {
  const section = $("appPackSection");
  const bar = $("wizardStickyBar");
  const primary = $("wizardStickyPrimary");
  const secondary = $("wizardStickySecondary");
  if (!section || !bar || !primary || !secondary) return;

  const jobKey = String(state.activeJob?.job_key || "").trim();
  if (!jobKey) {
    bar.classList.add("hidden");
    return;
  }

  const step = normalizeWizardStep_(section.dataset.wizardStep || "matches");
  bar.classList.remove("hidden");
  primary.classList.remove("btn-success");
  primary.disabled = false;
  secondary.disabled = false;

  if (step === "matches") {
    const needsManual = String(state.activeJob?.system_status || "").trim().toUpperCase() === "NEEDS_MANUAL_JD";
    if (needsManual) {
      primary.textContent = "Fix JD First";
      primary.onclick = () => openWizardAdvancedDrawer_({ focusJd: true });
      secondary.textContent = "Rescore";
      secondary.onclick = () => rescoreOne(jobKey);
      return;
    }
    primary.textContent = "Generate Pitch";
    primary.onclick = () => autoPilotJob(jobKey, { force: false });
    secondary.textContent = "Open Advanced";
    secondary.onclick = () => openWizardAdvancedDrawer_({ focusJd: false });
    return;
  }

  if (step === "pitch") {
    primary.textContent = "Approve";
    primary.onclick = () => approveWizardPack();
    secondary.textContent = "Save Draft";
    secondary.onclick = () => saveWizardDraft();
    return;
  }

  primary.textContent = "Copy Cover Letter";
  primary.onclick = () => copyWizardCoverLetter(primary);
  secondary.textContent = "Mark APPLIED";
  secondary.onclick = () => updateStatus(jobKey, "APPLIED");
}

function renderDetail(j) {
  state.activeJob = j;
  $("detailBody").classList.remove("empty");
  const jdConfidence = String(j.jd_confidence || j.fetch_debug?.jd_confidence || "").trim().toLowerCase();
  const headerTitle = getDisplayTitle(j);
  const headerCompany = getDisplayCompany(j) || "-";
  const missingCore = !String(j.role_title || "").trim() && !String(j.company || "").trim();
  const fetchedLowQuality =
    (
      String(j.system_status || "").toUpperCase() === "NEEDS_MANUAL_JD" ||
      ["blocked", "low_quality", "failed"].includes(String(j.fetch_status || "").toLowerCase()) ||
      jdConfidence === "low"
    );
  const headerHint = (missingCore && fetchedLowQuality) ? " Paste JD and Save & Rescore." : "";
  $("dRole").textContent = headerTitle;
  $("dCompany").textContent = `${headerCompany}${headerHint}`;

  const openHref = j.job_url || "#";
  const openBtn = $("dOpen");
  openBtn.href = openHref;
  openBtn.style.pointerEvents = openHref === "#" ? "none" : "auto";
  openBtn.style.opacity = openHref === "#" ? 0.5 : 1;

  $("btnCopyKey").onclick = async () => {
    try {
      await navigator.clipboard.writeText(j.job_key);
      toast("Copied job_key");
    } catch {
      toast("Copy failed");
    }
  };

  const status = String(j.status || "").toUpperCase();
  const ingestChannelLabel = getIngestChannelLabel(j) || (getIngestChannel(j) === "ui" ? "UI" : "-");
  const needsManualJd =
    String(j.system_status || "").toUpperCase() === "NEEDS_MANUAL_JD" ||
    jdConfidence === "low";
  const jdText = String(j.jd_text_clean || "").trim();
  const jdHint = needsManualJd
    ? "This job needs manual JD to improve extraction/scoring."
    : "Edit JD only if source content is incomplete.";

  $("detailBody").innerHTML = `
    <div class="kv">
      <div class="k">Status</div><div class="v"><span class="badge ${escapeHtml(status)}">${escapeHtml(status || "-")}</span></div>
      <div class="k">Final score</div><div class="v">${escapeHtml(String(j.final_score ?? "-"))}</div>
      <div class="k">Target</div><div class="v">${escapeHtml(j.primary_target_id || "-")}</div>
      <div class="k">Location</div><div class="v">${escapeHtml(j.location || "-")}</div>
      <div class="k">Seniority</div><div class="v">${escapeHtml(j.seniority || "-")}</div>
      <div class="k">Source</div><div class="v">${escapeHtml(j.source_domain || "-")}</div>
      <div class="k">Ingest channel</div><div class="v">${escapeHtml(ingestChannelLabel)}</div>
      <div class="k">Created</div><div class="v">${escapeHtml(fmtTsWithAbs(j.created_at))}</div>
      <div class="k">Updated</div><div class="v">${escapeHtml(fmtTsWithAbs(j.updated_at))}</div>
    </div>

    <div class="kv">
      <div class="k">Must-have keywords</div><div class="v">${escapeHtml((j.must_have_keywords || []).join(", ") || "-")}</div>
      <div class="k">Nice-to-have</div><div class="v">${escapeHtml((j.nice_to_have_keywords || []).join(", ") || "-")}</div>
      <div class="k">Reject keywords</div><div class="v">${escapeHtml((j.reject_keywords || []).join(", ") || "-")}</div>
      <div class="k">Reason</div><div class="v">${escapeHtml(j.reason_top_matches || "-")}</div>
    </div>

    <div class="kv">
      <div class="k">JD source</div><div class="v">${escapeHtml(j.jd_source || "-")}</div>
      <div class="k">Fetch status</div><div class="v">${escapeHtml(j.fetch_status || "-")}</div>
      <div class="k">JD confidence</div><div class="v">${escapeHtml(jdConfidence || "-")}</div>
      <div class="k">System status</div><div class="v">${escapeHtml(j.system_status || j.next_status || "-")}</div>
      <div class="k">Job URL</div><div class="v"><a class="muted" href="${escapeHtml(j.job_url || "#")}" target="_blank" rel="noopener">${escapeHtml(j.job_url || "-")}</a></div>
    </div>

    <div id="appPackSection" class="workspace-shell">
      <div class="next-action-card">
        <div>
          <div id="wsNextActionTitle" class="h3">Generate application pack</div>
          <div id="wsNextActionNote" class="muted tiny">Build ATS + resume outputs for this job.</div>
        </div>
        <button id="wsNextActionBtn" class="btn" type="button" onclick="runNextAction()">Generate pack</button>
      </div>
      <div class="wizard-progress">
        <div class="wizard-node active" data-wizard-node="matches" data-wizard-order="1">1 Matches</div>
        <div class="wizard-node" data-wizard-node="pitch" data-wizard-order="2">2 Pitch</div>
        <div class="wizard-node" data-wizard-node="finish" data-wizard-order="3">3 Finish</div>
      </div>

      <div class="workspace-pane" data-wizard-pane="matches">
        <div class="workspace-pane-head">
          <div class="h3">Matches</div>
          <div class="muted tiny">Use the fastest path: Generate Pitch, then approve and copy.</div>
        </div>
        <div id="appMatchSummary" class="muted tiny">Loading match summary...</div>
        <div id="appMatchChips" class="meta"></div>
        <div class="kv wizard-kv-compact">
          <div class="k">Pack status</div><div class="v"><span id="appPackStatus"><span class="badge">-</span></span></div>
          <div class="k">ATS score</div><div class="v"><b id="appAtsScore">-</b></div>
          <div class="k">Missing keywords</div><div class="v" id="appMissingKw">-</div>
          <div class="k">Target rubric score</div><div class="v" id="appTargetRubricScore">-</div>
          <div class="k">RR import</div><div class="v" id="appRrImportStatus">-</div>
          <div class="k">PDF readiness</div><div class="v" id="appPdfReadyStatus">-</div>
          <div class="k">Pack state</div><div class="v" id="appPackEmpty">No Application Pack yet</div>
        </div>
      </div>

      <div class="workspace-pane hidden" data-wizard-pane="pitch">
        <div class="workspace-pane-head">
          <div class="h3">Pitch</div>
          <div class="muted tiny">Edit quickly, then approve from the sticky action bar.</div>
        </div>
        <label class="muted tiny">Summary</label>
        <textarea id="wizardSummary" rows="4" placeholder="Tailored summary"></textarea>
        <label class="muted tiny" style="margin-top:8px;">Cover letter</label>
        <div class="pitch-hero-wrap">
          <textarea id="wizardCoverLetter" class="pitch-hero" rows="14" placeholder="Tailored cover letter"></textarea>
        </div>
      </div>

      <div class="workspace-pane hidden" data-wizard-pane="finish">
        <div class="h3">Finish</div>
        <div class="muted tiny" style="margin-top:4px;">Copy and apply. Use PDF-ready when you want print output.</div>
        <div class="kv" style="margin-top:10px;">
          <div class="k">Cover letter</div><div class="v"><textarea id="wizardFinalLetter" rows="10" readonly placeholder="Final letter appears here"></textarea></div>
          <div class="k">Pack status</div><div class="v" id="wizardFinishStatus">-</div>
        </div>
        <div id="wizardNetworkingCard" class="hidden" style="margin-top:10px;">
          <div class="h3">Networking</div>
          <div id="wizardOutreachHint" class="muted tiny" style="margin-top:4px;">Draft targeted outreach for a recruiter or hiring manager.</div>
          <div class="row" style="justify-content:flex-start; margin-top:8px; gap:8px; flex-wrap:wrap;">
            <select id="wizardOutreachContact" class="hidden" style="min-width:220px;"></select>
            <button class="btn btn-secondary" id="btnDraftOutreachLinkedin" onclick="draftWizardOutreach('LINKEDIN')" disabled>Draft LinkedIn DM</button>
            <button class="btn btn-ghost" id="btnDraftOutreachEmail" onclick="draftWizardOutreach('EMAIL')" disabled>Draft Email</button>
            <button class="btn btn-ghost" id="btnCopyOutreach" onclick="copyWizardOutreach(this)" disabled>Copy Draft</button>
          </div>
          <div class="row" style="justify-content:flex-start; margin-top:8px; gap:8px; flex-wrap:wrap;">
            <span id="wizardOutreachStatus" class="chip">Status: -</span>
            <button class="btn btn-ghost" id="btnOutreachStatusDraft" onclick="markWizardOutreachStatus('DRAFT')" disabled>Mark Draft</button>
            <button class="btn btn-ghost" id="btnOutreachStatusSent" onclick="markWizardOutreachStatus('SENT')" disabled>Mark Sent</button>
            <button class="btn btn-ghost" id="btnOutreachStatusReplied" onclick="markWizardOutreachStatus('REPLIED')" disabled>Mark Replied</button>
          </div>
          <textarea id="wizardOutreachDraft" rows="7" style="margin-top:8px;" placeholder="Outreach draft appears here"></textarea>
        </div>
        <div class="actions-grid wizard-finish-actions" style="margin-top:10px;">
          <button class="btn btn-ghost" id="btnPdfReadyToggle" onclick="togglePdfReadyMode()">PDF-ready view</button>
          <button class="btn btn-ghost" onclick="printPdfReadyView()">Print / Save PDF</button>
        </div>
      </div>

      <details id="wizardAdvancedDrawer" class="advanced-drawer">
        <summary>Advanced diagnostics, profile/template controls, and exports</summary>
        <div class="advanced-drawer-body">
          <div class="resume-step">
            <div class="h3">Manual JD and recovery</div>
            <div class="muted tiny">${escapeHtml(jdHint)}</div>
            <textarea id="jdCurrentText" rows="10" placeholder="Paste JD text here...">${escapeHtml(jdText)}</textarea>
            <div class="row" style="justify-content:flex-start; margin-top:10px;">
              <button class="btn btn-secondary" onclick="saveAndRescoreManualJd('${escapeHtml(j.job_key)}')">Save JD & Rescore</button>
              <button class="btn btn-ghost" onclick="rescoreOne('${escapeHtml(j.job_key)}')">Rescore this job</button>
              <button class="btn btn-ghost" type="button" onclick="rebuildEvidence('${escapeHtml(j.job_key)}')">Rebuild Evidence</button>
            </div>
          </div>

          <div class="resume-step">
            <div class="h3">Keyword selection</div>
            <div class="row" style="justify-content:flex-start; margin-top:0;">
              <button class="btn btn-ghost" type="button" onclick="selectAtsKeywords('all')">Select all</button>
              <button class="btn btn-ghost" type="button" onclick="selectAtsKeywords('must')">Must</button>
              <button class="btn btn-ghost" type="button" onclick="selectAtsKeywords('missing')">Missing</button>
              <button class="btn btn-ghost" type="button" onclick="selectAtsKeywords('none')">Clear</button>
            </div>
            <div id="appKeywordPicker" class="kw-grid"></div>
          </div>

          <div class="resume-step">
            <div class="h3">Diagnostics</div>
            <div class="kv">
              <div class="k">Evidence map</div><div class="v"><div id="evidence-container" class="evidence-container"><div class="muted tiny">Loading evidence...</div></div></div>
              <div class="k">Target evidence gaps</div><div class="v" id="appTargetRubricGaps">-</div>
              <div class="k">RR import issues</div><div class="v" id="appRrImportErrors">-</div>
              <div class="k">RR resume id</div><div class="v" id="appRrResumeId">-</div>
              <div class="k">RR push status</div><div class="v" id="appRrPushStatus">-</div>
              <div class="k">RR last pushed</div><div class="v" id="appRrLastPushed">-</div>
              <div class="k">RR dashboard</div><div class="v"><a class="muted" id="appRrDashboardLink" href="#" target="_blank" rel="noopener">-</a></div>
              <div class="k">RR PDF status</div><div class="v" id="appRrPdfStatus">-</div>
              <div class="k">RR PDF exported</div><div class="v" id="appRrPdfExported">-</div>
              <div class="k">PDF blockers</div><div class="v" id="appPdfReadyIssues">-</div>
            </div>
          </div>

          <div class="resume-step">
            <div class="h3">Template and profile controls</div>
            <div class="muted tiny">Use defaults unless you are tuning output behavior.</div>
            <label class="muted tiny">Template</label>
            <select id="appTemplateSelect" style="margin-top:6px;"></select>
            <input id="appTemplateName" placeholder="Template name" style="margin-top:8px;" />
            <div class="row" style="justify-content:flex-start; margin-top:8px;">
              <button class="btn btn-ghost" type="button" onclick="saveResumeTemplateFromUi()">Save Template</button>
              <button class="btn btn-ghost" type="button" onclick="deleteResumeTemplateFromUi()">Delete Template</button>
            </div>
            <label class="muted tiny" style="margin-top:8px;">Renderer</label>
            <select id="appRenderer" style="margin-top:6px;">
              <option value="reactive_resume">reactive_resume</option>
              <option value="html_simple">html_simple</option>
            </select>
            <label class="muted tiny" style="margin-top:8px;">ATS mode</label>
            <select id="appAtsTargetMode" style="margin-top:6px;">
              <option value="all">Use all target keywords</option>
              <option value="selected_only">Use selected ATS keywords only</option>
            </select>
            <label class="muted tiny" style="margin-top:8px;">Length rule</label>
            <label class="tiny" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
              <input type="checkbox" id="appOnePagerStrict" ${getOnePagerStrictPref_() ? "checked" : ""} />
              Enforce 1-page strict (cap summary/sections/bullets)
            </label>
            <label class="muted tiny" style="margin-top:8px;">Resume blocks</label>
            <div class="block-checks" style="margin-top:6px;">
              <label><input type="checkbox" id="blkSummary" checked /> Summary</label>
              <label><input type="checkbox" id="blkExperience" checked /> Experience</label>
              <label><input type="checkbox" id="blkSkills" checked /> Skills</label>
              <label><input type="checkbox" id="blkHighlights" checked /> Highlights</label>
              <label><input type="checkbox" id="blkBullets" checked /> Tailored bullets</label>
            </div>
            <label class="muted tiny" style="margin-top:8px;">Profile</label>
            <select id="appProfileSelect" style="margin-top:6px;"></select>
            <label class="muted tiny" style="margin-top:8px;">Profile ID</label>
            <input id="appProfileId" placeholder="primary" style="margin-top:6px;" />
            <label class="muted tiny" style="margin-top:8px;">Profile name</label>
            <input id="appProfileName" placeholder="Primary" style="margin-top:6px;" />
            <label class="muted tiny" style="margin-top:8px;">Profile JSON</label>
            <textarea id="appProfileJson" rows="6" style="margin-top:6px;" placeholder='{"basics":{},"summary":"","experience":[],"skills":[]}'></textarea>
            <div class="row" style="justify-content:flex-start; margin-top:8px;">
              <button class="btn btn-secondary" onclick="saveResumeProfileFromUi()">Save Profile</button>
            </div>
          </div>

          <div class="resume-step">
            <div class="h3">Generation, export, and status shortcuts</div>
            <div class="row" style="justify-content:flex-start; margin-top:8px;">
              <button class="btn" onclick="generateApplicationPack('${escapeHtml(j.job_key)}', false)">Generate</button>
              <button class="btn btn-secondary" onclick="generateApplicationPack('${escapeHtml(j.job_key)}', true)">Regenerate</button>
              <button class="btn btn-secondary" onclick="openReviewModal('${escapeHtml(j.job_key)}')">Review & Approve</button>
              <button class="btn btn-secondary" id="btnDownloadRrJson" onclick="downloadRrJson()">Download RR JSON</button>
              <button class="btn btn-secondary" id="btnPushRr" onclick="pushToReactiveResume('${escapeHtml(j.job_key)}')">Push to Reactive Resume</button>
              <button class="btn btn-secondary" id="btnGenerateRrPdf" onclick="exportReactiveResumePdf('${escapeHtml(j.job_key)}', false)">Generate PDF</button>
              <button class="btn btn-secondary" id="btnDownloadRrPdf" onclick="downloadLatestRrPdf()">Download latest PDF</button>
            </div>
            <div class="row" style="justify-content:flex-start; margin-top:8px;">
              <button class="btn btn-ghost" onclick="copyPackSummary()">Copy tailored summary</button>
              <button class="btn btn-ghost" onclick="copyPackBullets()">Copy tailored bullets</button>
              <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','APPLIED')">Mark APPLIED</button>
              <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','SHORTLISTED')">Mark SHORTLISTED</button>
              <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','REJECTED')">Mark REJECTED</button>
              <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','ARCHIVED')">Mark ARCHIVED</button>
            </div>
          </div>
        </div>
      </details>

      <div id="wizardStickyBar" class="wizard-sticky-bar hidden">
        <button id="wizardStickySecondary" class="btn btn-ghost" type="button">Save Draft</button>
        <button id="wizardStickyPrimary" class="btn" type="button">Generate Pitch</button>
      </div>
  `;
  if (window.location.hostname.includes("workers.dev")) {
    console.log("Rendering Application Pack", j.job_key);
  }
  updateNextActionCard_(j, { hasPack: false });
  setPdfReadyMode_(false);
  setWizardStep_(resolveWizardStep_(j, ""));
  resetWizardOutreachUi_({ hideCard: true });
  hydrateApplicationPack(j);
  fetchAndRenderEvidence(j.job_key);
}

function getTargetDisplay(t) {
  return `${t.id || "-"} - ${t.name || "(Unnamed)"}`;
}

function filterTargets(targets, q) {
  if (!q) return targets;
  return targets.filter((t) => {
    const s = `${t.id || ""} ${t.name || ""} ${t.primary_role || ""} ${t.seniority_pref || ""} ${t.location_pref || ""}`.toLowerCase();
    return s.includes(q);
  });
}

function targetCard(t) {
  const isActive = state.activeTargetId === t.id;
  const rubricProfile = normalizeRubricProfileUi_(t.rubric_profile ?? t.rubricProfile ?? "auto");
  const rubricLabel = rubricProfile === "pm_v1" ? "PM" : (rubricProfile === "target_generic_v1" ? "Generic" : "Auto");
  return `
    <div class="job-card ${isActive ? "active" : ""}" data-target-id="${escapeHtml(t.id || "")}" tabindex="0">
      <div class="title">${escapeHtml(getTargetDisplay(t))}</div>
      <div class="sub">${escapeHtml(t.primary_role || "-")} | ${escapeHtml(t.seniority_pref || "-")} | ${escapeHtml(t.location_pref || "-")} | rubric: ${escapeHtml(rubricLabel)}</div>
    </div>
  `;
}

function renderTargets() {
  const q = $("targetSearch").value.trim().toLowerCase();
  const filtered = filterTargets(state.targets, q);
  $("targetsHint").textContent = `${filtered.length} target(s)`;
  const container = $("targetsList");
  container.innerHTML = filtered.map(targetCard).join("") || `<div class="muted">No targets found.</div>`;

  container.querySelectorAll(".job-card").forEach((el) => {
    el.addEventListener("click", () => setActiveTarget(el.dataset.targetId));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") setActiveTarget(el.dataset.targetId);
    });
  });
}

function keywordsToText(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "string") {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.join(", ");
    } catch {}
    return v;
  }
  return "";
}

function textToKeywords(text) {
  return String(text || "")
    .split(/[\n,]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeRubricProfileUi_(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return "auto";
  if (raw === "pm_v1" || raw === "target_generic_v1" || raw === "auto") return raw;
  if (raw === "pm" || raw === "product" || raw === "product_manager") return "pm_v1";
  if (raw === "generic" || raw === "target" || raw === "default") return "target_generic_v1";
  return "auto";
}

function appendKeyword(textareaId, inputId) {
  const box = $(textareaId);
  const input = $(inputId);
  if (!box || !input) return;
  const kw = String(input.value || "").trim();
  if (!kw) return;
  const list = textToKeywords(box.value || "");
  const seen = new Set(list.map((x) => x.toLowerCase()));
  if (!seen.has(kw.toLowerCase())) list.push(kw);
  box.value = list.join(", ");
  input.value = "";
  input.focus();
}

function renderTargetEditor(t) {
  $("targetEditor").classList.remove("empty");
  $("tTitle").textContent = t.id || "Target";
  $("tSub").textContent = t.name || "";
  const rubricProfile = normalizeRubricProfileUi_(t.rubric_profile ?? t.rubricProfile ?? "auto");

  const rejectBlock = state.rejectKeywordsEnabled
    ? `
      <div class="field">
        <label>reject_keywords_json</label>
        <textarea id="tReject" rows="3" placeholder="keyword1, keyword2">${escapeHtml(keywordsToText(t.reject_keywords_json ?? t.reject_keywords))}</textarea>
        <div class="target-keyword-row">
          <input id="tRejectAdd" placeholder="Add reject keyword..." />
          <button class="btn btn-ghost" type="button" onclick="appendKeyword('tReject','tRejectAdd')">+ Reject</button>
        </div>
      </div>
    `
    : `<div class="muted tiny">Reject keywords not enabled in DB schema.</div>`;

  const rubricBlock = state.rubricProfileEnabled
    ? `
      <div class="field">
        <label>rubric_profile</label>
        <select id="tRubricProfile">
          <option value="auto"${rubricProfile === "auto" ? " selected" : ""}>auto</option>
          <option value="pm_v1"${rubricProfile === "pm_v1" ? " selected" : ""}>pm_v1</option>
          <option value="target_generic_v1"${rubricProfile === "target_generic_v1" ? " selected" : ""}>target_generic_v1</option>
        </select>
      </div>
    `
    : `<div class="muted tiny">Rubric profile not enabled in DB schema.</div>`;

  $("targetEditor").innerHTML = `
    <div class="target-form">
      <div class="field">
        <label>ID</label>
        <input id="tId" value="${escapeHtml(t.id || "")}" disabled />
      </div>
      <div class="field">
        <label>Name</label>
        <input id="tName" value="${escapeHtml(t.name || "")}" />
      </div>
      <div class="field">
        <label>primary_role</label>
        <input id="tPrimaryRole" value="${escapeHtml(t.primary_role || "")}" />
      </div>
      <div class="field">
        <label>seniority_pref</label>
        <input id="tSeniority" value="${escapeHtml(t.seniority_pref || "")}" />
      </div>
      <div class="field">
        <label>location_pref</label>
        <input id="tLocation" value="${escapeHtml(t.location_pref || "")}" />
      </div>
      ${rubricBlock}
      <div class="field">
        <label>must_keywords_json</label>
        <textarea id="tMust" rows="3" placeholder="keyword1, keyword2">${escapeHtml(keywordsToText(t.must_keywords_json ?? t.must_keywords))}</textarea>
        <div class="target-keyword-row">
          <input id="tMustAdd" placeholder="Add must keyword..." />
          <button class="btn btn-ghost" type="button" onclick="appendKeyword('tMust','tMustAdd')">+ Must</button>
        </div>
      </div>
      <div class="field">
        <label>nice_keywords_json</label>
        <textarea id="tNice" rows="3" placeholder="keyword1, keyword2">${escapeHtml(keywordsToText(t.nice_keywords_json ?? t.nice_keywords))}</textarea>
        <div class="target-keyword-row">
          <input id="tNiceAdd" placeholder="Add nice keyword..." />
          <button class="btn btn-ghost" type="button" onclick="appendKeyword('tNice','tNiceAdd')">+ Nice</button>
        </div>
      </div>
      ${rejectBlock}
      <div class="row" style="justify-content:flex-start;">
        <button class="btn" onclick="saveActiveTarget()">Save Target</button>
      </div>
    </div>
  `;
}

async function loadTargets() {
  try {
    spin(true);
    const res = await api("/targets");
    state.targets = Array.isArray(res.data) ? res.data : [];
    if (typeof res?.meta?.reject_keywords_enabled === "boolean") {
      state.rejectKeywordsEnabled = res.meta.reject_keywords_enabled;
    } else {
      const sample = state.targets[0];
      state.rejectKeywordsEnabled = !sample || Object.prototype.hasOwnProperty.call(sample, "reject_keywords_json");
    }
    if (typeof res?.meta?.rubric_profile_enabled === "boolean") {
      state.rubricProfileEnabled = res.meta.rubric_profile_enabled;
    } else {
      const sample = state.targets[0];
      state.rubricProfileEnabled = !sample || Object.prototype.hasOwnProperty.call(sample, "rubric_profile");
    }
    renderTargets();
    if (state.activeTargetId && !state.targets.some((t) => t.id === state.activeTargetId)) {
      state.activeTargetId = null;
      $("targetEditor").classList.add("empty");
      $("targetEditor").innerHTML = `<div class="empty-state"><div class="h3">Pick a target from the left.</div></div>`;
    }
  } catch (e) {
    toast("Targets load failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function setActiveTarget(targetId) {
  if (!targetId) return;
  state.activeTargetId = targetId;
  renderTargets();
  try {
    spin(true);
    const res = await api("/targets/" + encodeURIComponent(targetId));
    const target = res.data || {};
    if (typeof res?.meta?.reject_keywords_enabled === "boolean") {
      state.rejectKeywordsEnabled = res.meta.reject_keywords_enabled;
    } else {
      state.rejectKeywordsEnabled = Object.prototype.hasOwnProperty.call(target, "reject_keywords_json");
    }
    if (typeof res?.meta?.rubric_profile_enabled === "boolean") {
      state.rubricProfileEnabled = res.meta.rubric_profile_enabled;
    } else {
      state.rubricProfileEnabled = Object.prototype.hasOwnProperty.call(target, "rubric_profile");
    }
    renderTargetEditor(target);
  } catch (e) {
    toast("Target open failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function createNewTarget() {
  const idIn = prompt("New target id (example: TGT-003)");
  const targetId = String(idIn || "").trim();
  if (!targetId) return;
  const nameIn = prompt("Target name", "New Target");
  const name = String(nameIn || "").trim() || targetId;
  const body = {
    name,
    primary_role: "",
    seniority_pref: "",
    location_pref: "",
    must_keywords_json: [],
    nice_keywords_json: [],
  };
  if (state.rejectKeywordsEnabled) body.reject_keywords_json = [];
  if (state.rubricProfileEnabled) body.rubric_profile = "auto";

  try {
    spin(true);
    await api("/targets/" + encodeURIComponent(targetId), { method: "POST", body });
    toast("Target created");
    await loadTargets();
    await setActiveTarget(targetId);
  } catch (e) {
    toast("Create target failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function saveActiveTarget() {
  const targetId = String(state.activeTargetId || $("tId")?.value || "").trim();
  if (!targetId) {
    toast("Target id is required");
    return;
  }

  const body = {
    name: $("tName")?.value || "",
    primary_role: $("tPrimaryRole")?.value || "",
    seniority_pref: $("tSeniority")?.value || "",
    location_pref: $("tLocation")?.value || "",
    must_keywords_json: textToKeywords($("tMust")?.value || ""),
    nice_keywords_json: textToKeywords($("tNice")?.value || ""),
  };

  if (state.rejectKeywordsEnabled) {
    body.reject_keywords_json = textToKeywords($("tReject")?.value || "");
  }
  if (state.rubricProfileEnabled) {
    body.rubric_profile = normalizeRubricProfileUi_($("tRubricProfile")?.value || "auto");
  }

  try {
    spin(true);
    await api("/targets/" + encodeURIComponent(targetId), { method: "POST", body });
    toast("Target saved");
    await loadTargets();
    await setActiveTarget(targetId);
  } catch (e) {
    toast("Target save failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function loadResumeProfiles() {
  try {
    const res = await api("/resume/profiles");
    state.resumeProfiles = Array.isArray(res.data) ? res.data : [];
    if (!state.resumeProfiles.length) return;
    if (!state.resumeProfiles.some((p) => p.id === state.activeProfileId)) {
      state.activeProfileId = state.resumeProfiles[0].id;
    }
  } catch (e) {
    toast("Profiles load failed: " + e.message);
  }
}

function getActiveProfile() {
  return state.resumeProfiles.find((p) => p.id === state.activeProfileId) || null;
}

function defaultProfileTemplate_() {
  return {
    basics: { name: "", email: "", phone: "", location: "" },
    summary: "",
    experience: [],
    skills: [],
  };
}

function defaultResumeTemplates_() {
  return [
    {
      id: "balanced",
      name: "Balanced",
      description: "General-purpose template.",
      ats_target_mode: "all",
      enabled_blocks: ["summary", "experience", "skills", "highlights", "bullets"],
    },
    {
      id: "compact",
      name: "Compact",
      description: "Short format for quick applications.",
      ats_target_mode: "all",
      enabled_blocks: ["summary", "experience", "skills", "bullets"],
    },
    {
      id: "keyword-focus",
      name: "Keyword Focus",
      description: "Bias toward selected ATS keywords.",
      ats_target_mode: "selected_only",
      enabled_blocks: ["summary", "skills", "highlights", "bullets"],
    },
  ];
}

function normalizeTemplate_(tpl) {
  const id = String(tpl?.id || "").trim().toLowerCase();
  const name = String(tpl?.name || id || "Template").trim();
  const description = String(tpl?.description || "").trim();
  const atsTargetMode = String(tpl?.ats_target_mode || "all").trim().toLowerCase();
  const allowed = new Set(["summary", "experience", "skills", "highlights", "bullets"]);
  const enabled = Array.isArray(tpl?.enabled_blocks)
    ? tpl.enabled_blocks.map((x) => String(x || "").trim().toLowerCase()).filter((x) => allowed.has(x))
    : [];
  return {
    id: id || slugify_(name) || crypto.randomUUID().slice(0, 8),
    name: name || "Template",
    description,
    ats_target_mode: (atsTargetMode === "selected_only") ? "selected_only" : "all",
    enabled_blocks: enabled.length ? Array.from(new Set(enabled)) : ["summary", "experience", "skills", "highlights", "bullets"],
  };
}

function loadResumeTemplates_() {
  const defaults = defaultResumeTemplates_();
  let parsed = [];
  try {
    const raw = localStorage.getItem(RESUME_TEMPLATES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    parsed = Array.isArray(arr) ? arr : [];
  } catch {
    parsed = [];
  }
  const normalized = parsed.map(normalizeTemplate_).filter((t) => t.id);
  const merged = [...defaults];
  for (const t of normalized) {
    const idx = merged.findIndex((x) => x.id === t.id);
    if (idx >= 0) merged[idx] = t;
    else merged.push(t);
  }
  state.resumeTemplates = merged;
  if (!state.resumeTemplates.some((t) => t.id === state.activeTemplateId)) {
    state.activeTemplateId = (state.resumeTemplates[0] || {}).id || DEFAULT_TEMPLATE_ID;
  }
}

function saveResumeTemplates_() {
  localStorage.setItem(RESUME_TEMPLATES_KEY, JSON.stringify(state.resumeTemplates || []));
}

function getTemplateById_(id) {
  const key = String(id || "").trim();
  return state.resumeTemplates.find((t) => t.id === key) || null;
}

function templateOptionsHtml_() {
  return (state.resumeTemplates || [])
    .map((t) => {
      const label = (t.name && t.id && t.name !== t.id) ? `${t.name} (${t.id})` : (t.name || t.id);
      return `<option value="${escapeHtml(t.id)}"${t.id === state.activeTemplateId ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function getEnabledBlocksFromUi_() {
  const map = [
    ["summary", "blkSummary"],
    ["experience", "blkExperience"],
    ["skills", "blkSkills"],
    ["highlights", "blkHighlights"],
    ["bullets", "blkBullets"],
  ];
  return map.filter((x) => Boolean($(x[1])?.checked)).map((x) => x[0]);
}

function setEnabledBlocksUi_(blocks) {
  const set = new Set((Array.isArray(blocks) ? blocks : []).map((x) => String(x || "").trim().toLowerCase()));
  const map = [
    ["summary", "blkSummary"],
    ["experience", "blkExperience"],
    ["skills", "blkSkills"],
    ["highlights", "blkHighlights"],
    ["bullets", "blkBullets"],
  ];
  map.forEach(([k, id]) => {
    const el = $(id);
    if (el) el.checked = set.has(k);
  });
}

function readSelectedKeywordsFromUi_() {
  const host = $("appKeywordPicker");
  if (!host) return [];
  return Array.from(host.querySelectorAll("input[type='checkbox'][data-kw]:checked"))
    .map((el) => String(el.dataset.kw || "").trim())
    .filter(Boolean);
}

function renderKeywordPicker_(job, packData = null) {
  const host = $("appKeywordPicker");
  if (!host) return;
  const must = Array.isArray(job?.must_have_keywords) ? job.must_have_keywords : [];
  const nice = Array.isArray(job?.nice_to_have_keywords) ? job.nice_to_have_keywords : [];
  const missing = Array.isArray(packData?.ats_json?.missing_keywords) ? packData.ats_json.missing_keywords : [];
  const fromPack = Array.isArray(packData?.pack_json?.controls?.selected_keywords)
    ? packData.pack_json.controls.selected_keywords
    : [];
  const merged = Array.from(new Set([...must, ...nice, ...missing].map((x) => String(x || "").trim()).filter(Boolean)));
  if (!merged.length) {
    host.innerHTML = `<div class="muted tiny">No extracted keywords yet. Generate or rescore first.</div>`;
    state.selectedAtsKeywords = [];
    return;
  }
  const selectedSet = new Set(
    (state.selectedAtsKeywords.length ? state.selectedAtsKeywords : (fromPack.length ? fromPack : must))
      .map((x) => String(x || "").trim().toLowerCase())
  );
  host.innerHTML = merged.map((kw) => {
    const low = kw.toLowerCase();
    const checked = selectedSet.has(low);
    const isMissing = missing.map((x) => String(x || "").toLowerCase()).includes(low);
    const cls = isMissing ? "kw-pill missing" : "kw-pill";
    return `<label class="${cls}"><input type="checkbox" data-kw="${escapeHtml(kw)}" ${checked ? "checked" : ""}/> ${escapeHtml(kw)}</label>`;
  }).join("");
  host.querySelectorAll("input[type='checkbox'][data-kw]").forEach((el) => {
    el.onchange = () => {
      state.selectedAtsKeywords = readSelectedKeywordsFromUi_();
    };
  });
  state.selectedAtsKeywords = readSelectedKeywordsFromUi_();
}

function applyTemplateToResumeUi_(templateId) {
  const tpl = getTemplateById_(templateId);
  if (!tpl) return;
  state.activeTemplateId = tpl.id;
  if ($("appTemplateSelect")) $("appTemplateSelect").value = tpl.id;
  if ($("appTemplateName")) $("appTemplateName").value = tpl.name;
  if ($("appAtsTargetMode")) $("appAtsTargetMode").value = tpl.ats_target_mode || "all";
  setEnabledBlocksUi_(tpl.enabled_blocks || []);
}

function saveResumeTemplateFromUi() {
  const selectedId = String($("appTemplateSelect")?.value || "").trim();
  const nameInput = String($("appTemplateName")?.value || "").trim();
  const selectedTpl = getTemplateById_(selectedId);
  const defaultIds = new Set(defaultResumeTemplates_().map((t) => t.id));
  const editingDefaultWithNewName =
    Boolean(selectedTpl) &&
    defaultIds.has(selectedTpl.id) &&
    Boolean(nameInput) &&
    nameInput.toLowerCase() !== String(selectedTpl.name || "").toLowerCase();
  let id = selectedId || slugify_(nameInput) || `template-${Date.now()}`;
  if (editingDefaultWithNewName) {
    const base = slugify_(nameInput) || "template";
    id = base;
    let n = 2;
    while (state.resumeTemplates.some((t) => t.id === id)) {
      id = `${base}-${n++}`;
    }
  }
  const template = normalizeTemplate_({
    id,
    name: nameInput || id,
    ats_target_mode: String($("appAtsTargetMode")?.value || "all"),
    enabled_blocks: getEnabledBlocksFromUi_(),
  });
  const idx = state.resumeTemplates.findIndex((t) => t.id === template.id);
  if (idx >= 0) state.resumeTemplates[idx] = template;
  else state.resumeTemplates.push(template);
  state.activeTemplateId = template.id;
  saveResumeTemplates_();
  if ($("appTemplateSelect")) $("appTemplateSelect").innerHTML = templateOptionsHtml_();
  if ($("appTemplateSelect")) $("appTemplateSelect").value = state.activeTemplateId;
  toast("Template saved");
}

function deleteResumeTemplateFromUi() {
  const id = String($("appTemplateSelect")?.value || "").trim();
  if (!id) return;
  if (!confirm(`Delete template ${id}?`)) return;
  state.resumeTemplates = (state.resumeTemplates || []).filter((t) => t.id !== id);
  if (!state.resumeTemplates.length) {
    state.resumeTemplates = defaultResumeTemplates_();
  }
  state.activeTemplateId = (state.resumeTemplates[0] || {}).id || DEFAULT_TEMPLATE_ID;
  saveResumeTemplates_();
  if ($("appTemplateSelect")) {
    $("appTemplateSelect").innerHTML = templateOptionsHtml_();
    $("appTemplateSelect").value = state.activeTemplateId;
  }
  applyTemplateToResumeUi_(state.activeTemplateId);
  toast("Template deleted");
}

function selectAtsKeywords(mode) {
  const host = $("appKeywordPicker");
  if (!host) return;
  const currentJob = state.activeJob || null;
  const mustSet = new Set(Array.isArray(currentJob?.must_have_keywords) ? currentJob.must_have_keywords.map((x) => String(x || "").toLowerCase()) : []);
  host.querySelectorAll("input[type='checkbox'][data-kw]").forEach((el) => {
    const kw = String(el.dataset.kw || "").toLowerCase();
    const label = el.closest("label");
    const isMissing = label?.classList.contains("missing");
    if (mode === "all") el.checked = true;
    else if (mode === "none") el.checked = false;
    else if (mode === "must") el.checked = mustSet.has(kw);
    else if (mode === "missing") el.checked = Boolean(isMissing);
  });
  state.selectedAtsKeywords = readSelectedKeywordsFromUi_();
}

function resumeProfilesOptionsHtml() {
  return state.resumeProfiles
    .map((p) => {
      const label = (p.name && p.id && p.name !== p.id) ? `${p.name} (${p.id})` : (p.name || p.id);
      return `<option value="${escapeHtml(p.id)}"${p.id === state.activeProfileId ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function syncResumeProfileSelectUi_() {
  const profileSelect = $("appProfileSelect");
  if (!profileSelect) return;
  profileSelect.innerHTML = resumeProfilesOptionsHtml() || `<option value="primary">Primary</option>`;
  profileSelect.value = state.activeProfileId || "primary";
}

async function loadResumeProfileDetail(profileId, { silent = false } = {}) {
  const id = String(profileId || "").trim();
  if (!id) return;
  try {
    const res = await api(`/resume/profiles/${encodeURIComponent(id)}`);
    const p = res.data || {};
    const canonicalId = String(p.id || id).trim() || id;
    const canonicalName = String(p.name || canonicalId).trim() || canonicalId;
    const profileObj = (p.profile_json && typeof p.profile_json === "object") ? p.profile_json : defaultProfileTemplate_();
    const txt = JSON.stringify(profileObj, null, 2);
    state.activeProfileId = canonicalId;
    state.profileJsonDraftById[canonicalId] = txt;

    if ($("appProfileId")) $("appProfileId").value = canonicalId;
    if ($("appProfileName")) $("appProfileName").value = canonicalName;
    if ($("appProfileJson")) $("appProfileJson").value = txt;
  } catch (e) {
    if (!silent) toast("Profile load failed: " + e.message, { kind: "error" });
    if ($("appProfileId")) $("appProfileId").value = id;
    if ($("appProfileName")) $("appProfileName").value = id;
    const fallback = state.profileJsonDraftById[id] || JSON.stringify(defaultProfileTemplate_(), null, 2);
    state.profileJsonDraftById[id] = fallback;
    if ($("appProfileJson")) $("appProfileJson").value = fallback;
  }
}

async function saveResumeProfileFromUi() {
  const id = String($("appProfileId")?.value || "primary").trim() || "primary";
  const name = String($("appProfileName")?.value || "Primary").trim() || "Primary";
  const txt = String($("appProfileJson")?.value || "{}").trim();
  let profileObj = {};
  try {
    profileObj = JSON.parse(txt || "{}");
  } catch {
    toast("Profile JSON is invalid");
    return;
  }
  try {
    spin(true);
    await api("/resume/profiles", { method: "POST", body: { id, name, profile_json: profileObj } });
    await loadResumeProfiles();
    state.activeProfileId = id;
    state.profileJsonDraftById[id] = JSON.stringify(profileObj, null, 2);
    syncResumeProfileSelectUi_();
    await loadResumeProfileDetail(id, { silent: true });
    toast("Profile saved");
  } catch (e) {
    toast("Profile save failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function generateApplicationPack(jobKey, force = false) {
  try {
    spin(true);
    const renderer = String($("appRenderer")?.value || "reactive_resume");
    const profileId = String($("appProfileSelect")?.value || state.activeProfileId || "").trim();
    if (profileId) state.activeProfileId = profileId;
    await saveJobProfilePreference_(jobKey, state.activeProfileId, { silent: true });
    const templateId = String($("appTemplateSelect")?.value || state.activeTemplateId || DEFAULT_TEMPLATE_ID).trim() || DEFAULT_TEMPLATE_ID;
    state.activeTemplateId = templateId;
    const enabledBlocks = getEnabledBlocksFromUi_();
    const selectedKeywords = readSelectedKeywordsFromUi_();
    const atsTargetMode = String($("appAtsTargetMode")?.value || "all").trim().toLowerCase() || "all";
    const onePagerStrict = Boolean($("appOnePagerStrict")?.checked ?? getOnePagerStrictPref_());
    setOnePagerStrictPref_(onePagerStrict);
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/generate-application-pack`, {
      method: "POST",
      body: {
        profile_id: state.activeProfileId || "primary",
        force: Boolean(force),
        renderer,
        template_id: templateId,
        enabled_blocks: enabledBlocks,
        selected_keywords: selectedKeywords,
        ats_target_mode: atsTargetMode,
        one_pager_strict: onePagerStrict,
      },
    });
    toast(`Pack ${res?.data?.status || "generated"} (${res?.data?.ats_score ?? "-"})`);
    await hydrateApplicationPack(jobKey);
  } catch (e) {
    toast("Generate pack failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function autoPilotJob(jobKey, { force = false } = {}) {
  const key = String(jobKey || "").trim();
  if (!key) return;
  try {
    spin(true);
    const renderer = String($("appRenderer")?.value || "reactive_resume");
    const profileId = String($("appProfileSelect")?.value || state.activeProfileId || "primary").trim() || "primary";
    state.activeProfileId = profileId;
    await saveJobProfilePreference_(key, state.activeProfileId, { silent: true });
    const templateId = String($("appTemplateSelect")?.value || state.activeTemplateId || DEFAULT_TEMPLATE_ID).trim() || DEFAULT_TEMPLATE_ID;
    state.activeTemplateId = templateId;
    const enabledBlocks = getEnabledBlocksFromUi_();
    const selectedKeywords = readSelectedKeywordsFromUi_();
    const atsTargetMode = String($("appAtsTargetMode")?.value || "all").trim().toLowerCase() || "all";
    const onePagerStrict = Boolean($("appOnePagerStrict")?.checked ?? getOnePagerStrictPref_());
    setOnePagerStrictPref_(onePagerStrict);

    const res = await api(`/jobs/${encodeURIComponent(key)}/auto-pilot`, {
      method: "POST",
      body: {
        profile_id: profileId,
        force: Boolean(force),
        renderer,
        template_id: templateId,
        enabled_blocks: enabledBlocks,
        selected_keywords: selectedKeywords,
        ats_target_mode: atsTargetMode,
        one_pager_strict: onePagerStrict,
      },
    });
    const score = res?.data?.score?.final_score;
    const packStatus = res?.data?.pack?.status || "generated";
    toast(`Auto-tailor done (${packStatus}, score ${score ?? "-"})`);
    await loadJobs({ ignoreStatus: true });
    await setActive(key);
    await hydrateApplicationPack(key);
  } catch (e) {
    toast("Auto-tailor failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

async function runJobPrimaryAction(jobKey, action) {
  const key = String(jobKey || "").trim();
  const act = String(action || "").trim().toLowerCase();
  if (!key || !act) return;
  if (act === "score") {
    await rescoreOne(key);
    return;
  }
  if (act === "generate_pack") {
    await generateApplicationPack(key, false);
    return;
  }
  if (act === "copy_apply") {
    await openReviewModal(key);
    return;
  }
  await setActive(key);
}

async function hydrateApplicationPack(jobOrKey) {
  const section = $("appPackSection");
  if (!section) return;
  const currentJob = (typeof jobOrKey === "object" && jobOrKey)
    ? jobOrKey
    : (state.jobs.find((x) => x.job_key === jobOrKey) || state.activeJob || { job_key: String(jobOrKey || "") });
  const jobKey = String(currentJob?.job_key || "").trim();
  if (!jobKey) return;

  const profileSelect = $("appProfileSelect");
  if (profileSelect) {
    profileSelect.innerHTML = resumeProfilesOptionsHtml() || `<option value="primary">Primary</option>`;
    profileSelect.value = state.activeProfileId || "primary";
    profileSelect.onchange = async () => {
      state.activeProfileId = profileSelect.value || "primary";
      await saveJobProfilePreference_(jobKey, state.activeProfileId, { silent: true });
      await loadResumeProfileDetail(state.activeProfileId, { silent: true });
    };
  }

  if (!state.resumeTemplates.length) loadResumeTemplates_();
  const templateSelect = $("appTemplateSelect");
  if (templateSelect) {
    templateSelect.innerHTML = templateOptionsHtml_();
    templateSelect.value = state.activeTemplateId || DEFAULT_TEMPLATE_ID;
    templateSelect.onchange = () => {
      state.activeTemplateId = templateSelect.value || DEFAULT_TEMPLATE_ID;
      applyTemplateToResumeUi_(state.activeTemplateId);
    };
  }

  const rendererSelect = $("appRenderer");
  if (rendererSelect) {
    rendererSelect.onchange = () => {
      syncRrDownloadUi_();
    };
  }
  const onePagerToggle = $("appOnePagerStrict");
  if (onePagerToggle) {
    onePagerToggle.checked = getOnePagerStrictPref_();
    onePagerToggle.onchange = () => {
      setOnePagerStrictPref_(Boolean(onePagerToggle.checked));
    };
  }

  const p = getActiveProfile();
  if ($("appProfileId")) $("appProfileId").value = p?.id || state.activeProfileId || "primary";
  if ($("appProfileName")) $("appProfileName").value = p?.name || "Primary";
  const profileId = state.activeProfileId || "primary";
  await loadResumeProfileDetail(profileId, { silent: true });
  if ($("appProfileJson")) {
    const draft = state.profileJsonDraftById[profileId];
    if (draft) $("appProfileJson").value = draft;
    $("appProfileJson").oninput = () => {
      const activeId = String($("appProfileId")?.value || state.activeProfileId || "primary").trim() || "primary";
      state.profileJsonDraftById[activeId] = $("appProfileJson").value;
    };
  }

  try {
    const q = state.activeProfileId ? `?profile_id=${encodeURIComponent(state.activeProfileId)}` : "";
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/application-pack${q}`);
    const d = res.data || {};
    if (window.location.hostname.includes("workers.dev")) {
      console.log("Draft response", { status: d.status || null, hasAts: Boolean(d.ats_json) });
    }
    const controls = d?.pack_json?.controls || {};
    const status = String(d.status || "-");
    const ats = d.ats_json || {};
    const missing = Array.isArray(ats.missing_keywords) ? ats.missing_keywords : [];
    const targetRubric = (ats?.target_rubric && typeof ats.target_rubric === "object")
      ? ats.target_rubric
      : ((ats?.pm_rubric && typeof ats.pm_rubric === "object") ? ats.pm_rubric : null);
    const targetApplicable = targetRubric ? Boolean(targetRubric.applicable) : false;
    const targetScore = Number.isFinite(Number(targetRubric?.score)) ? Number(targetRubric.score) : null;
    const targetGaps = Array.isArray(targetRubric?.missing_evidence) ? targetRubric.missing_evidence : [];
    const targetName = String(targetRubric?.target_name || targetRubric?.target_id || "").trim();
    const rrImportReady = (typeof d?.rr_export_import_ready === "boolean")
      ? d.rr_export_import_ready
      : Boolean(d?.rr_export_json?.metadata?.import_ready);
    const rrImportErrors = Array.isArray(d?.rr_export_import_errors)
      ? d.rr_export_import_errors
      : (Array.isArray(d?.rr_export_json?.metadata?.import_errors) ? d.rr_export_json.metadata.import_errors : []);
    const rrResumeId = String(d?.rr_resume_id || "").trim();
    const rrPushStatus = String(d?.rr_last_push_status || "").trim();
    const rrLastPushedAt = Number(d?.rr_last_pushed_at || 0);
    const rrLastPushError = String(d?.rr_last_push_error || "").trim();
    const rrPdfUrl = String(d?.rr_pdf_url || "").trim();
    const rrPdfExportedAt = Number(d?.rr_pdf_last_exported_at || 0);
    const rrPdfStatus = String(d?.rr_pdf_last_export_status || "").trim();
    const rrPdfError = String(d?.rr_pdf_last_export_error || "").trim();
    const pdfReadiness = d?.pdf_readiness && typeof d.pdf_readiness === "object" ? d.pdf_readiness : null;
    const pdfReady = Boolean(pdfReadiness?.ready);
    const pdfIssues = Array.isArray(pdfReadiness?.failed_checks)
      ? pdfReadiness.failed_checks.map((x) => String(x?.detail || x?.label || x?.id || "").trim()).filter(Boolean)
      : [];
    const rrBaseUrl = String(d?.rr_base_url || "").trim();
    $("appPackStatus").innerHTML = `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
    $("appAtsScore").textContent = String(ats.score ?? "-");
    $("appMissingKw").textContent = missing.length ? missing.join(", ") : "-";
    if ($("appTargetRubricScore")) {
      $("appTargetRubricScore").textContent = targetRubric
        ? (targetApplicable ? `${String(targetScore ?? "-")}${targetName ? ` (${targetName})` : ""}` : `N/A (${String(targetRubric.notes || "not applicable")})`)
        : "-";
    }
    if ($("appTargetRubricGaps")) {
      $("appTargetRubricGaps").textContent = targetGaps.length ? targetGaps.slice(0, 8).join(" | ") : "-";
    }
    if ($("appRrImportStatus")) {
      $("appRrImportStatus").textContent = rrImportReady ? "Ready" : "Needs Fix";
    }
    if ($("appRrImportErrors")) {
      $("appRrImportErrors").textContent = rrImportErrors.length ? rrImportErrors.join(", ") : "-";
    }
    if ($("appRrResumeId")) $("appRrResumeId").textContent = rrResumeId || "-";
    if ($("appRrPushStatus")) {
      const pushText = rrPushStatus || "-";
      $("appRrPushStatus").textContent = rrLastPushError ? `${pushText} (${rrLastPushError})` : pushText;
    }
    if ($("appRrLastPushed")) $("appRrLastPushed").textContent = rrLastPushedAt ? fmtTsWithAbs(rrLastPushedAt) : "-";
    if ($("appRrDashboardLink")) {
      if (rrBaseUrl) {
        $("appRrDashboardLink").href = rrBaseUrl;
        $("appRrDashboardLink").textContent = "Open";
      } else {
        $("appRrDashboardLink").href = "#";
        $("appRrDashboardLink").textContent = "-";
      }
    }
    if ($("appRrPdfStatus")) {
      const txt = rrPdfStatus || "-";
      $("appRrPdfStatus").textContent = rrPdfError ? `${txt} (${rrPdfError})` : txt;
    }
    if ($("appRrPdfExported")) $("appRrPdfExported").textContent = rrPdfExportedAt ? fmtTsWithAbs(rrPdfExportedAt) : "-";
    if ($("appPdfReadyStatus")) $("appPdfReadyStatus").textContent = pdfReadiness ? (pdfReady ? "READY" : "BLOCKED") : "-";
    if ($("appPdfReadyIssues")) $("appPdfReadyIssues").textContent = pdfIssues.length ? pdfIssues.join(" | ") : "-";
    $("appPackEmpty").textContent = rrImportReady
      ? "Application Pack loaded"
      : "Application Pack loaded with RR import warnings";
    const packSummary = String(d?.pack_json?.tailoring?.summary || "");
    const packBullets = Array.isArray(d?.pack_json?.tailoring?.bullets) ? d.pack_json.tailoring.bullets.join("\n") : "";
    const packCoverLetter = String(d?.pack_json?.tailoring?.cover_letter || "");
    section.dataset.packSummary = packSummary;
    section.dataset.packBullets = packBullets;
    section.dataset.packCoverLetter = packCoverLetter;
    section.dataset.rrJson = JSON.stringify(d?.rr_export_json || {}, null, 2);
    section.dataset.rrImportReady = rrImportReady ? "1" : "0";
    section.dataset.rrImportErrors = rrImportErrors.join(", ");
    section.dataset.rrPdfUrl = rrPdfUrl;
    section.dataset.pdfReady = pdfReadiness ? (pdfReady ? "1" : "0") : "0";
    section.dataset.pdfReadyIssues = pdfIssues.join(", ");

    const controlTemplateId = String(controls.template_id || "").trim();
    if (controlTemplateId) state.activeTemplateId = controlTemplateId;
    if ($("appTemplateSelect")) {
      $("appTemplateSelect").innerHTML = templateOptionsHtml_();
      $("appTemplateSelect").value = state.activeTemplateId || DEFAULT_TEMPLATE_ID;
    }
    if ($("appTemplateName")) {
      const tpl = getTemplateById_(state.activeTemplateId);
      $("appTemplateName").value = tpl?.name || state.activeTemplateId || "";
    }
    if ($("appAtsTargetMode")) {
      $("appAtsTargetMode").value = String(controls.ats_target_mode || "all");
    }
    if ($("appOnePagerStrict")) {
      const controlOnePager = controls.one_pager_strict;
      const onePager = (typeof controlOnePager === "boolean") ? controlOnePager : getOnePagerStrictPref_();
      $("appOnePagerStrict").checked = onePager;
      setOnePagerStrictPref_(onePager);
    }
    setEnabledBlocksUi_(Array.isArray(controls.enabled_blocks) ? controls.enabled_blocks : getTemplateById_(state.activeTemplateId)?.enabled_blocks || []);
    state.selectedAtsKeywords = Array.isArray(controls.selected_keywords) ? controls.selected_keywords : [];
    if ($("wizardSummary")) $("wizardSummary").value = packSummary;
    if ($("wizardCoverLetter")) $("wizardCoverLetter").value = packCoverLetter;
    if ($("wizardFinalLetter")) $("wizardFinalLetter").value = packCoverLetter;
    if ($("wizardFinishStatus")) $("wizardFinishStatus").textContent = status || "-";
    const outreachVisible = status === "READY_TO_APPLY" || status === "APPLIED";
    await hydrateWizardOutreachContacts_(jobKey, { showCard: outreachVisible });
    const mustKeywords = Array.isArray(d?.pack_json?.tailoring?.must_keywords) ? d.pack_json.tailoring.must_keywords : [];
    const missingSet = new Set(missing.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean));
    const matchedTop = mustKeywords
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .filter((x) => !missingSet.has(x.toLowerCase()))
      .slice(0, 3);
    const missingTop = missing.slice(0, 2);
    if ($("appMatchSummary")) {
      $("appMatchSummary").textContent = `Matched ${matchedTop.length} strong signals, missing ${missingTop.length} must-have keywords.`;
    }
    if ($("appMatchChips")) {
      const matchedHtml = matchedTop.map((kw) => `<span class="chip chip-match-pos">${escapeHtml(kw)}</span>`).join("");
      const missingHtml = missingTop.map((kw) => `<span class="chip chip-match-neg">${escapeHtml(String(kw || ""))}</span>`).join("");
      $("appMatchChips").innerHTML = matchedHtml + missingHtml || `<span class="muted tiny">No keyword chips available yet.</span>`;
    }
    renderKeywordPicker_(currentJob, d);
    syncRrDownloadUi_();
    updateNextActionCard_(currentJob, { hasPack: true });
    setWizardStep_(resolveWizardStep_(currentJob, status));
  } catch (e) {
    $("appPackStatus").innerHTML = `<span class="badge">-</span>`;
    $("appAtsScore").textContent = "-";
    $("appMissingKw").textContent = e.httpStatus === 404 ? "-" : ("Error: " + e.message);
    if ($("appTargetRubricScore")) $("appTargetRubricScore").textContent = "-";
    if ($("appTargetRubricGaps")) $("appTargetRubricGaps").textContent = "-";
    if ($("appRrImportStatus")) $("appRrImportStatus").textContent = "-";
    if ($("appRrImportErrors")) $("appRrImportErrors").textContent = "-";
    if ($("appRrResumeId")) $("appRrResumeId").textContent = "-";
    if ($("appRrPushStatus")) $("appRrPushStatus").textContent = "-";
    if ($("appRrLastPushed")) $("appRrLastPushed").textContent = "-";
    if ($("appRrDashboardLink")) {
      $("appRrDashboardLink").href = "#";
      $("appRrDashboardLink").textContent = "-";
    }
    if ($("appRrPdfStatus")) $("appRrPdfStatus").textContent = "-";
    if ($("appRrPdfExported")) $("appRrPdfExported").textContent = "-";
    if ($("appPdfReadyStatus")) $("appPdfReadyStatus").textContent = "-";
    if ($("appPdfReadyIssues")) $("appPdfReadyIssues").textContent = "-";
    $("appPackEmpty").textContent = e.httpStatus === 404 ? "No Application Pack yet" : ("Application Pack unavailable: " + e.message);
    section.dataset.packSummary = "";
    section.dataset.packBullets = "";
    section.dataset.packCoverLetter = "";
    section.dataset.rrJson = "{}";
    section.dataset.rrImportReady = "0";
    section.dataset.rrImportErrors = "";
    section.dataset.rrPdfUrl = "";
    section.dataset.pdfReady = "0";
    section.dataset.pdfReadyIssues = "";
    if ($("appOnePagerStrict")) $("appOnePagerStrict").checked = getOnePagerStrictPref_();
    if ($("wizardSummary")) $("wizardSummary").value = "";
    if ($("wizardCoverLetter")) $("wizardCoverLetter").value = "";
    if ($("wizardFinalLetter")) $("wizardFinalLetter").value = "";
    if ($("wizardFinishStatus")) $("wizardFinishStatus").textContent = "-";
    resetWizardOutreachUi_({ hideCard: true });
    if ($("appMatchSummary")) $("appMatchSummary").textContent = "No scored evidence yet. Generate pitch to continue.";
    if ($("appMatchChips")) $("appMatchChips").innerHTML = `<span class="muted tiny">No keyword chips available yet.</span>`;
    applyTemplateToResumeUi_(state.activeTemplateId || DEFAULT_TEMPLATE_ID);
    renderKeywordPicker_(currentJob, null);
    syncRrDownloadUi_();
    updateNextActionCard_(currentJob, { hasPack: false });
    setWizardStep_(resolveWizardStep_(currentJob, ""));
  }
}

function renderEvidenceRowsHtml_(rows, { emptyMsg = "No evidence rows found." } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `<div class="muted tiny">${escapeHtml(emptyMsg)}</div>`;
  return list.map((row) => {
    const matched = Boolean(row?.matched);
    const icon = matched ? "OK" : "X";
    const rowClass = matched ? "review-evidence-row evidence-item matched" : "review-evidence-row evidence-item missing";
    const requirementType = String(row?.requirement_type || "-").trim() || "-";
    const requirementText = String(row?.requirement_text || "-").trim() || "-";
    const source = String(row?.evidence_source || "none").trim() || "none";
    const confidence = Number.isFinite(Number(row?.confidence_score)) ? Number(row.confidence_score) : 0;
    const evidenceText = String(row?.evidence_text || "").trim();
    return `
      <div class="${rowClass}">
        <span class="evidence-tag">${escapeHtml(requirementType)} - confidence ${escapeHtml(String(confidence))} - source ${escapeHtml(source)}</span>
        <div style="display:flex; align-items:flex-start; gap:8px;">
          <span style="font-weight:700; color:${matched ? "#23c16b" : "#e44f4f"};">${icon}</span>
          <span>${escapeHtml(requirementText)}</span>
        </div>
        ${evidenceText ? `<blockquote>${escapeHtml(evidenceText)}</blockquote>` : ""}
      </div>
    `;
  }).join("");
}

async function fetchAndRenderEvidence(jobKey) {
  const host = $("evidence-container");
  if (!host) return;
  const key = String(jobKey || "").trim();
  if (!key) {
    host.innerHTML = `<div class="muted tiny">Select a job to view evidence.</div>`;
    return;
  }
  host.innerHTML = `<div class="muted tiny">Loading evidence...</div>`;

  try {
    const res = await api(`/jobs/${encodeURIComponent(key)}/evidence`);
    const rows = Array.isArray(res?.data) ? res.data : [];
    host.innerHTML = renderEvidenceRowsHtml_(rows);
  } catch (e) {
    if (e?.httpStatus === 404) {
      host.innerHTML = `<div class="muted tiny">No evidence yet. Run rescore or manual JD save first.</div>`;
      return;
    }
    host.innerHTML = `<div class="muted tiny">Evidence load failed: ${escapeHtml(String(e?.message || e || "unknown error"))}</div>`;
  }
}

function updateReviewSummaryMeta_() {
  const summary = String($("reviewSummary")?.value || "");
  const meta = $("reviewSummaryMeta");
  if (!meta) return;
  const n = summary.length;
  const stateLabel = (n >= 180 && n <= 250) ? "OK" : "Need 180-250";
  meta.textContent = `${n} / 250 (${stateLabel})`;
}

async function openReviewModal(jobKey) {
  const key = String(jobKey || state.activeJob?.job_key || "").trim();
  if (!key) return;
  const profileId = String(state.activeProfileId || "primary").trim() || "primary";

  $("reviewJobKey").textContent = key;
  $("reviewSummary").value = "";
  $("reviewCoverLetter").value = "";
  $("reviewEvidenceList").innerHTML = `<div class="muted tiny">Loading...</div>`;
  state.reviewContext = { jobKey: key, profileId, bullets: [] };
  updateReviewSummaryMeta_();
  openModal("modalReview");

  try {
    spin(true);
    const evidencePromise = api(`/jobs/${encodeURIComponent(key)}/evidence?limit=200`)
      .then((r) => Array.isArray(r?.data) ? r.data : [])
      .catch((e) => (e?.httpStatus === 404 ? [] : Promise.reject(e)));
    const packPromise = api(`/jobs/${encodeURIComponent(key)}/application-pack?profile_id=${encodeURIComponent(profileId)}`);
    const [evidenceRows, packRes] = await Promise.all([evidencePromise, packPromise]);
    const draft = packRes?.data || {};
    const tailoring = draft?.pack_json?.tailoring && typeof draft.pack_json.tailoring === "object"
      ? draft.pack_json.tailoring
      : {};
    const bullets = Array.isArray(tailoring.bullets) ? tailoring.bullets.map((x) => String(x || "").trim()).filter(Boolean) : [];
    state.reviewContext = {
      jobKey: key,
      profileId: String(draft.profile_id || profileId).trim() || profileId,
      bullets,
    };

    $("reviewSummary").value = String(tailoring.summary || "");
    $("reviewCoverLetter").value = String(tailoring.cover_letter || "");
    $("reviewEvidenceList").innerHTML = renderEvidenceRowsHtml_(evidenceRows, {
      emptyMsg: "No matched evidence yet. Rebuild evidence for stronger auditability.",
    });
    updateReviewSummaryMeta_();

    if (window.location.hostname.includes("workers.dev")) {
      console.log("Draft response", {
        job_key: key,
        status: draft.status || null,
        evidence_rows: evidenceRows.length,
      });
    }
  } catch (e) {
    $("reviewEvidenceList").innerHTML = `<div class="muted tiny">Load failed: ${escapeHtml(String(e?.message || e || "unknown error"))}</div>`;
    toast("Review load failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

async function saveDraft() {
  const ctx = state.reviewContext || {};
  const jobKey = String(ctx.jobKey || "").trim();
  if (!jobKey) return toast("Select a job first");
  const profileId = String(ctx.profileId || state.activeProfileId || "primary").trim() || "primary";
  const summary = String($("reviewSummary")?.value || "").trim();
  const coverLetter = String($("reviewCoverLetter")?.value || "").trim();
  const bullets = Array.isArray(ctx.bullets) ? ctx.bullets : [];
  if (!summary) return toast("Summary is required");
  if (!bullets.length) return toast("Draft has no bullets; generate pack first");

  try {
    spin(true);
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/application-pack/review`, {
      method: "POST",
      body: {
        profile_id: profileId,
        summary,
        bullets,
        cover_letter: coverLetter,
      },
    });
    toast(`Draft saved (${res?.data?.status || "ok"})`);
    if (state.activeKey === jobKey) await setActive(jobKey);
  } catch (e) {
    toast("Save failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

async function approvePack() {
  const ctx = state.reviewContext || {};
  const jobKey = String(ctx.jobKey || "").trim();
  if (!jobKey) return toast("Select a job first");
  const profileId = String(ctx.profileId || state.activeProfileId || "primary").trim() || "primary";
  const summary = String($("reviewSummary")?.value || "").trim();
  const coverLetter = String($("reviewCoverLetter")?.value || "").trim();
  const bullets = Array.isArray(ctx.bullets) ? ctx.bullets : [];
  if (!summary) return toast("Summary is required");
  if (!coverLetter) return toast("Cover letter is required");

  try {
    spin(true);
    const approveBtn = $("btnReviewApprove");
    const originalLabel = approveBtn ? approveBtn.textContent : "";
    const originalBg = approveBtn ? approveBtn.style.background : "";

    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/approve-pack`, {
      method: "POST",
      body: {
        profile_id: profileId,
        summary,
        cover_letter: coverLetter,
        bullets,
      },
    });
    try {
      await navigator.clipboard.writeText(coverLetter);
      if (approveBtn) {
        approveBtn.textContent = "OK Copied to Clipboard";
        approveBtn.style.background = "#28a745";
      }
      toast(`Approved (${res?.data?.status || "READY_TO_APPLY"}). Cover letter copied.`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch {
      toast(`Approved (${res?.data?.status || "READY_TO_APPLY"}). Copy cover letter manually.`);
    } finally {
      if (approveBtn) {
        approveBtn.textContent = originalLabel;
        approveBtn.style.background = originalBg;
      }
    }
    closeModal("modalReview");
    await loadJobs({ ignoreStatus: true });
    if (state.activeKey === jobKey) await setActive(jobKey);
  } catch (e) {
    toast("Approve failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

function getWizardDraftPayload_() {
  const jobKey = String(state.activeJob?.job_key || "").trim();
  const profileId = String(state.activeProfileId || "primary").trim() || "primary";
  const summary = String($("wizardSummary")?.value || "").trim();
  const coverLetter = String($("wizardCoverLetter")?.value || "").trim();
  const bullets = String($("appPackSection")?.dataset?.packBullets || "")
    .split(/\r?\n+/g)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return { jobKey, profileId, summary, coverLetter, bullets };
}

async function saveWizardDraft() {
  const { jobKey, profileId, summary, coverLetter, bullets } = getWizardDraftPayload_();
  if (!jobKey) return toast("Select a job first", { kind: "error" });
  if (!summary) return toast("Summary is required", { kind: "error" });
  if (!bullets.length) return toast("Generate pitch first", { kind: "error" });
  try {
    spin(true);
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/application-pack/review`, {
      method: "POST",
      body: {
        profile_id: profileId,
        summary,
        bullets,
        cover_letter: coverLetter,
      },
    });
    toast(`Draft saved (${res?.data?.status || "ok"})`);
    await hydrateApplicationPack(jobKey);
    setWizardStep_("pitch");
  } catch (e) {
    toast("Save failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

async function approveWizardPack() {
  const { jobKey, profileId, summary, coverLetter, bullets } = getWizardDraftPayload_();
  if (!jobKey) return toast("Select a job first", { kind: "error" });
  if (!summary) return toast("Summary is required", { kind: "error" });
  if (!coverLetter) return toast("Cover letter is required", { kind: "error" });
  try {
    spin(true);
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/approve-pack`, {
      method: "POST",
      body: {
        profile_id: profileId,
        summary,
        cover_letter: coverLetter,
        bullets,
      },
    });
    if ($("wizardFinalLetter")) $("wizardFinalLetter").value = coverLetter;
    if ($("wizardFinishStatus")) $("wizardFinishStatus").textContent = String(res?.data?.status || "READY_TO_APPLY");
    toast(`Approved (${res?.data?.status || "READY_TO_APPLY"})`);
    await loadJobs({ ignoreStatus: true });
    await setActive(jobKey);
    setWizardStep_("finish");
  } catch (e) {
    toast("Approve failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

function flashCopiedState_(btn) {
  if (!(btn instanceof HTMLElement)) return;
  const originalText = btn.textContent;
  btn.textContent = "Copied!";
  btn.classList.add("btn-success");
  btn.disabled = true;
  setTimeout(() => {
    btn.classList.remove("btn-success");
    btn.disabled = false;
    syncWizardStickyCta_();
    if (btn.textContent === "Copied!") btn.textContent = originalText;
  }, 1200);
}

async function copyWizardCoverLetter(sourceBtn = null) {
  const letter = String($("wizardFinalLetter")?.value || $("wizardCoverLetter")?.value || $("appPackSection")?.dataset?.packCoverLetter || "").trim();
  if (!letter) return toast("No cover letter available", { kind: "error" });
  try {
    await navigator.clipboard.writeText(letter);
    toast("Cover letter copied");
    flashCopiedState_(sourceBtn || $("wizardStickyPrimary"));
  } catch {
    toast("Copy failed", { kind: "error" });
  }
}

function setWizardOutreachContacts_(contacts = [], selectedId = "") {
  const select = $("wizardOutreachContact");
  const section = $("appPackSection");
  if (!select) return;
  const list = Array.isArray(contacts) ? contacts : [];
  if (section) {
    try {
      section.dataset.outreachContactsJson = JSON.stringify(list);
    } catch {
      section.dataset.outreachContactsJson = "[]";
    }
  }
  if (!list.length) {
    select.innerHTML = "";
    select.classList.add("hidden");
    syncWizardOutreachLifecycleUi_();
    return;
  }
  const desired = String(selectedId || "").trim();
  select.innerHTML = list.map((c) => {
    const id = String(c?.id || "").trim();
    const name = String(c?.name || "").trim() || "Unknown contact";
    const title = String(c?.title || "").trim();
    const channel = String(c?.channel || "LINKEDIN").trim().toUpperCase();
    const label = `${name}${title ? ` (${title})` : ""} - ${channel}`;
    const selected = desired && desired === id;
    return `<option value="${escapeHtml(id)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  if (!desired && list[0]?.id) {
    select.value = String(list[0].id);
  }
  select.onchange = () => syncWizardOutreachLifecycleUi_();
  select.classList.remove("hidden");
  syncWizardOutreachLifecycleUi_();
}

function getWizardOutreachContacts_() {
  const section = $("appPackSection");
  const raw = String(section?.dataset?.outreachContactsJson || "[]").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeOutreachChannelUi_(channel = "") {
  const s = String(channel || "").trim().toUpperCase();
  if (s === "EMAIL" || s === "OTHER") return s;
  return "LINKEDIN";
}

function getSelectedOutreachContact_() {
  const contactId = String($("wizardOutreachContact")?.value || "").trim();
  if (!contactId) return null;
  const contacts = getWizardOutreachContacts_();
  return contacts.find((x) => String(x?.id || "").trim() === contactId) || null;
}

function syncWizardOutreachLifecycleUi_() {
  const section = $("appPackSection");
  const channel = normalizeOutreachChannelUi_(section?.dataset?.outreachChannel || "LINKEDIN");
  if (section) section.dataset.outreachChannel = channel;
  const contact = getSelectedOutreachContact_();
  const hasContact = Boolean(contact && String(contact.id || "").trim());

  const statuses = (contact?.channel_statuses && typeof contact.channel_statuses === "object")
    ? contact.channel_statuses
    : {};
  const status = String(statuses[channel] || contact?.status || "DRAFT").trim().toUpperCase() || "DRAFT";
  const statusEl = $("wizardOutreachStatus");
  if (statusEl) {
    statusEl.textContent = hasContact ? `Status (${channel}): ${status}` : "Status: -";
  }

  const draftBtn = $("btnOutreachStatusDraft");
  const sentBtn = $("btnOutreachStatusSent");
  const repliedBtn = $("btnOutreachStatusReplied");
  if (draftBtn) {
    draftBtn.disabled = !hasContact;
    draftBtn.classList.toggle("btn-success", hasContact && status === "DRAFT");
  }
  if (sentBtn) {
    sentBtn.disabled = !hasContact;
    sentBtn.classList.toggle("btn-success", hasContact && status === "SENT");
  }
  if (repliedBtn) {
    repliedBtn.disabled = !hasContact;
    repliedBtn.classList.toggle("btn-success", hasContact && status === "REPLIED");
  }
}

function resetWizardOutreachUi_({ hideCard = false } = {}) {
  const section = $("appPackSection");
  if (section) {
    section.dataset.outreachContactsJson = "[]";
    section.dataset.outreachChannel = "LINKEDIN";
  }
  if (hideCard) {
    $("wizardNetworkingCard")?.classList.add("hidden");
  }
  if ($("wizardOutreachHint")) $("wizardOutreachHint").textContent = "Draft targeted outreach for a recruiter or hiring manager.";
  if ($("wizardOutreachStatus")) $("wizardOutreachStatus").textContent = "Status: -";
  if ($("wizardOutreachDraft")) $("wizardOutreachDraft").value = "";
  setWizardOutreachContacts_([]);
  if ($("btnCopyOutreach")) $("btnCopyOutreach").disabled = true;
  if ($("btnDraftOutreachLinkedin")) $("btnDraftOutreachLinkedin").disabled = true;
  if ($("btnDraftOutreachEmail")) $("btnDraftOutreachEmail").disabled = true;
}

async function hydrateWizardOutreachContacts_(jobKey, { showCard = false } = {}) {
  const key = String(jobKey || "").trim();
  if (!key) {
    resetWizardOutreachUi_({ hideCard: true });
    return;
  }
  const card = $("wizardNetworkingCard");
  const section = $("appPackSection");
  if (!card) return;
  if (section && !String(section.dataset.outreachChannel || "").trim()) {
    section.dataset.outreachChannel = "LINKEDIN";
  }
  card.classList.toggle("hidden", !showCard);
  if (!showCard) {
    resetWizardOutreachUi_({ hideCard: false });
    return;
  }

  try {
    const res = await api(`/jobs/${encodeURIComponent(key)}/contacts`);
    const contacts = Array.isArray(res?.data) ? res.data : [];
    const count = Number(res?.meta?.count || contacts.length || 0);
    if ($("wizardOutreachHint")) {
      $("wizardOutreachHint").textContent = count > 0
        ? `Found ${count} contact${count === 1 ? "" : "s"}. Draft a targeted follow-up.`
        : "No saved contacts yet. Rescore to identify potential recruiters.";
    }
    setWizardOutreachContacts_(contacts);
    if ($("btnDraftOutreachLinkedin")) $("btnDraftOutreachLinkedin").disabled = contacts.length === 0;
    if ($("btnDraftOutreachEmail")) $("btnDraftOutreachEmail").disabled = contacts.length === 0;
    if ($("btnCopyOutreach")) $("btnCopyOutreach").disabled = !String($("wizardOutreachDraft")?.value || "").trim();
    syncWizardOutreachLifecycleUi_();
  } catch (e) {
    if ($("wizardOutreachHint")) {
      $("wizardOutreachHint").textContent = `Contact load failed: ${String(e?.message || "unknown error")}`;
    }
    setWizardOutreachContacts_([]);
    if ($("btnDraftOutreachLinkedin")) $("btnDraftOutreachLinkedin").disabled = true;
    if ($("btnDraftOutreachEmail")) $("btnDraftOutreachEmail").disabled = true;
    if ($("btnCopyOutreach")) $("btnCopyOutreach").disabled = true;
    syncWizardOutreachLifecycleUi_();
  }
}

async function draftWizardOutreach(channel = "LINKEDIN") {
  const jobKey = String(state.activeJob?.job_key || "").trim();
  if (!jobKey) return toast("Select a job first", { kind: "error" });
  const selectedContactId = String($("wizardOutreachContact")?.value || "").trim();
  const normalizedChannel = String(channel || "LINKEDIN").trim().toUpperCase() === "EMAIL" ? "EMAIL" : "LINKEDIN";
  const profileId = String(state.activeProfileId || "primary").trim() || "primary";
  const section = $("appPackSection");

  try {
    spin(true);
    if (section) section.dataset.outreachChannel = normalizedChannel;
    const path = selectedContactId
      ? `/jobs/${encodeURIComponent(jobKey)}/contacts/${encodeURIComponent(selectedContactId)}/draft`
      : `/jobs/${encodeURIComponent(jobKey)}/draft-outreach`;
    const res = await api(path, {
      method: "POST",
      body: {
        profile_id: profileId,
        channel: normalizedChannel,
      },
    });
    const data = res?.data || {};
    const draft = String(data?.draft || "").trim();
    if (!draft) throw new Error("Empty outreach draft");
    if ($("wizardOutreachDraft")) $("wizardOutreachDraft").value = draft;
    if ($("btnCopyOutreach")) $("btnCopyOutreach").disabled = false;

    const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
    const selectedId = String(data?.selected_contact?.id || selectedContactId || "").trim();
    setWizardOutreachContacts_(contacts, selectedId);
    syncWizardOutreachLifecycleUi_();

    const selectedName = String(data?.selected_contact?.name || "").trim();
    const count = Number(data?.contacts_count || contacts.length || 0);
    if ($("wizardOutreachHint")) {
      $("wizardOutreachHint").textContent = selectedName
        ? `Draft ready for ${selectedName}. ${count > 1 ? `${count} contacts available.` : ""}`.trim()
        : `Draft ready. ${count > 0 ? `${count} contacts available.` : ""}`.trim();
    }
    toast(`${normalizedChannel === "EMAIL" ? "Email" : "LinkedIn DM"} draft generated`);
  } catch (e) {
    toast("Outreach draft failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

async function markWizardOutreachStatus(status = "SENT") {
  const jobKey = String(state.activeJob?.job_key || "").trim();
  if (!jobKey) return toast("Select a job first", { kind: "error" });
  const contact = getSelectedOutreachContact_();
  if (!contact || !String(contact.id || "").trim()) {
    return toast("Select a contact first", { kind: "error" });
  }
  const section = $("appPackSection");
  const channel = normalizeOutreachChannelUi_(section?.dataset?.outreachChannel || "LINKEDIN");
  const normalizedStatus = String(status || "DRAFT").trim().toUpperCase();
  if (!["DRAFT", "SENT", "REPLIED"].includes(normalizedStatus)) {
    return toast("Invalid status", { kind: "error" });
  }

  try {
    spin(true);
    const res = await api(
      `/jobs/${encodeURIComponent(jobKey)}/contacts/${encodeURIComponent(contact.id)}/touchpoint-status`,
      {
        method: "POST",
        body: {
          channel,
          status: normalizedStatus,
        },
      }
    );
    const touchpoint = res?.data?.touchpoint || {};
    const contacts = getWizardOutreachContacts_();
    const nextContacts = contacts.map((item) => {
      if (String(item?.id || "").trim() !== String(contact.id || "").trim()) return item;
      const channelStatuses = (item?.channel_statuses && typeof item.channel_statuses === "object")
        ? { ...item.channel_statuses }
        : {};
      channelStatuses[channel] = String(touchpoint?.status || normalizedStatus).trim().toUpperCase() || normalizedStatus;
      return {
        ...item,
        status: channelStatuses[channel],
        touchpoint_updated_at: touchpoint?.updated_at ?? item?.touchpoint_updated_at ?? null,
        channel_statuses: channelStatuses,
      };
    });
    setWizardOutreachContacts_(nextContacts, String(contact.id || "").trim());
    syncWizardOutreachLifecycleUi_();
    toast(`Outreach status set to ${normalizedStatus} (${channel})`);
  } catch (e) {
    toast("Status update failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

async function copyWizardOutreach(sourceBtn = null) {
  const draft = String($("wizardOutreachDraft")?.value || "").trim();
  if (!draft) return toast("No outreach draft available", { kind: "error" });
  try {
    await navigator.clipboard.writeText(draft);
    toast("Outreach draft copied");
    flashCopiedState_(sourceBtn || $("btnCopyOutreach"));
  } catch {
    toast("Copy failed", { kind: "error" });
  }
}

function togglePdfReadyMode() {
  setPdfReadyMode_(!document.body.classList.contains("pdf-ready-mode"));
}

function printPdfReadyView() {
  if (!document.body.classList.contains("pdf-ready-mode")) {
    setPdfReadyMode_(true);
  }
  window.print();
}

async function rebuildEvidence(jobKey) {
  const key = String(jobKey || state.activeJob?.job_key || "").trim();
  if (!key) return;
  try {
    spin(true);
    const res = await api(`/jobs/${encodeURIComponent(key)}/evidence/rebuild`, { method: "POST" });
    const d = res?.data || {};
    toast(`Evidence rebuilt (${d.rows_written ?? 0} rows, ${d.matched_count ?? 0} matched)`);
    await fetchAndRenderEvidence(key);
    await hydrateApplicationPack(key);
  } catch (e) {
    toast("Evidence rebuild failed: " + e.message, { kind: "error" });
  } finally {
    spin(false);
  }
}

function syncRrDownloadUi_() {
  const btn = $("btnDownloadRrJson");
  const pushBtn = $("btnPushRr");
  const pdfBtn = $("btnDownloadRrPdf");
  const genPdfBtn = $("btnGenerateRrPdf");
  if (!btn && !pushBtn && !pdfBtn && !genPdfBtn) return;
  const section = $("appPackSection");
  const rrJson = String(section?.dataset?.rrJson || "{}").trim();
  const rrPdfUrl = String(section?.dataset?.rrPdfUrl || "").trim();
  const hasPack = rrJson && rrJson !== "{}";
  const rrImportReady = String(section?.dataset?.rrImportReady || "") === "1";
  const rrImportErrors = String(section?.dataset?.rrImportErrors || "").trim();
  const pdfReady = String(section?.dataset?.pdfReady || "0") === "1";
  const pdfReadyIssues = String(section?.dataset?.pdfReadyIssues || "").trim();
  const renderer = String($("appRenderer")?.value || "reactive_resume").trim().toLowerCase();

  let disabled = !hasPack;
  let reason = hasPack ? "" : "Generate a pack first.";
  if (!disabled && renderer === "reactive_resume" && !rrImportReady) {
    disabled = true;
    reason = rrImportErrors
      ? `RR import checks failed: ${rrImportErrors}`
      : "RR import checks failed.";
  }

  if (btn) {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.6" : "1";
    btn.style.pointerEvents = disabled ? "none" : "auto";
    btn.title = disabled ? reason : "Download Reactive Resume JSON";
  }
  if (pushBtn) {
    pushBtn.disabled = disabled;
    pushBtn.style.opacity = disabled ? "0.6" : "1";
    pushBtn.style.pointerEvents = disabled ? "none" : "auto";
    pushBtn.title = disabled ? reason : "Push RR payload to Reactive Resume";
  }
  if (genPdfBtn) {
    const pdfGenDisabled = disabled || (renderer === "reactive_resume" && !pdfReady);
    const pdfReason = disabled
      ? reason
      : (!pdfReady ? (pdfReadyIssues ? `PDF blocked: ${pdfReadyIssues}` : "PDF readiness gate failed.") : "");
    genPdfBtn.disabled = pdfGenDisabled;
    genPdfBtn.style.opacity = pdfGenDisabled ? "0.6" : "1";
    genPdfBtn.style.pointerEvents = pdfGenDisabled ? "none" : "auto";
    genPdfBtn.title = pdfGenDisabled ? pdfReason : "Generate Reactive Resume PDF";
  }
  if (pdfBtn) {
    const pdfDisabled = !rrPdfUrl;
    pdfBtn.disabled = pdfDisabled;
    pdfBtn.style.opacity = pdfDisabled ? "0.6" : "1";
    pdfBtn.style.pointerEvents = pdfDisabled ? "none" : "auto";
    pdfBtn.title = pdfDisabled ? "Generate PDF first." : "Download latest exported PDF";
  }
}

async function copyPackSummary() {
  const txt = String($("appPackSection")?.dataset?.packSummary || "").trim();
  if (!txt) return toast("No summary");
  try { await navigator.clipboard.writeText(txt); toast("Summary copied"); } catch { toast("Copy failed"); }
}

async function copyPackBullets() {
  const txt = String($("appPackSection")?.dataset?.packBullets || "").trim();
  if (!txt) return toast("No bullets");
  try { await navigator.clipboard.writeText(txt); toast("Bullets copied"); } catch { toast("Copy failed"); }
}

function downloadRrJson() {
  const section = $("appPackSection");
  const txt = String(section?.dataset?.rrJson || "{}").trim();
  const renderer = String($("appRenderer")?.value || "reactive_resume").trim().toLowerCase();
  const rrImportReady = String(section?.dataset?.rrImportReady || "") === "1";
  const rrImportErrors = String(section?.dataset?.rrImportErrors || "").trim();
  if (!txt || txt === "{}") {
    toast("No RR JSON available. Generate pack first.");
    return;
  }
  if (renderer === "reactive_resume" && !rrImportReady) {
    toast(rrImportErrors ? `RR import blocked: ${rrImportErrors}` : "RR import checks failed. Fix profile/pack first.");
    return;
  }
  const blob = new Blob([txt], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "reactive-resume-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadLatestRrPdf() {
  const section = $("appPackSection");
  const url = String(section?.dataset?.rrPdfUrl || "").trim();
  if (!url) {
    toast("No PDF yet. Generate PDF first.");
    return;
  }
  window.open(url, "_blank", "noopener");
}

async function exportReactiveResumePdf(jobKey, force = false) {
  try {
    spin(true);
    const profileId = String($("appProfileId")?.value || state.activeProfileId || "").trim();
    const body = { force: Boolean(force) };
    if (profileId) body.profile_id = profileId;
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/export-reactive-resume-pdf`, {
      method: "POST",
      body,
    });
    const d = res?.data || {};
    toast(`PDF export ${d.rr_pdf_last_export_status || "SUCCESS"}`);
    await hydrateApplicationPack(jobKey);
  } catch (e) {
    toast("PDF export failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function pushToReactiveResume(jobKey) {
  try {
    spin(true);
    const profileId = String($("appProfileId")?.value || state.activeProfileId || "").trim();
    const body = {};
    if (profileId) body.profile_id = profileId;
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/push-reactive-resume`, {
      method: "POST",
      body,
    });
    const d = res?.data || {};
    const rrId = String(d.rr_resume_id || "").trim();
    const mode = String(d.rr_push_mode || "").trim();
    const modeLabel = mode ? ` [${mode}]` : "";
    toast(rrId ? `Pushed to Reactive Resume (${rrId})${modeLabel}` : `Pushed to Reactive Resume${modeLabel}`);
    await hydrateApplicationPack(jobKey);
  } catch (e) {
    toast("Push to Reactive Resume failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function updateStatus(jobKey, status) {
  const upper = String(status || "").toUpperCase();
  if ((upper === "REJECTED" || upper === "ARCHIVED") && !confirm(`Mark this job as ${upper}?`)) {
    return;
  }
  try {
    spin(true);
    await api(`/jobs/${encodeURIComponent(jobKey)}/status`, { method: "POST", body: { status } });
    toast("Status updated: " + status);
    await loadJobs();
    await setActive(jobKey);
  } catch (e) {
    toast("Status failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function saveAndRescoreManualJd(jobKey) {
  const jdText = String($("jdCurrentText")?.value || $("manualJd")?.value || "").trim();
  if (jdText.length < 200) {
    toast("Paste at least 200 characters of JD.");
    return;
  }
  try {
    spin(true);
    await api(`/jobs/${encodeURIComponent(jobKey)}/manual-jd`, {
      method: "POST",
      body: { jd_text_clean: jdText },
    });
    toast("Saved & rescored");
    await loadJobs();
    await setActive(jobKey);
  } catch (e) {
    toast("Manual JD failed: " + e.message);
  } finally {
    setWizardStep_("matches");
    spin(false);
  }
}

async function rescoreOne(jobKey) {
  try {
    spin(true);
    await api(`/jobs/${encodeURIComponent(jobKey)}/rescore`, { method: "POST" });
    toast("Rescored");
    await loadJobs();
    await setActive(jobKey);
  } catch (e) {
    toast("Rescore failed: " + e.message);
  } finally {
    spin(false);
  }
}

function openModal(id) {
  $(id).classList.remove("hidden");
}

function closeModal(id) {
  $(id).classList.add("hidden");
}

async function ingestUrls(text) {
  const urls = String(text || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) throw new Error("Paste at least one URL.");
  return api("/ingest", { method: "POST", body: { raw_urls: urls } });
}

function slugify_(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildManualSyntheticUrl_(refText) {
  const slug = slugify_(refText) || "manual-entry";
  return `https://manual.jobops.local/job/${slug}-${Date.now()}`;
}

function syncAddModeUi() {
  const mode = $("addMode")?.value || "url";
  const isManual = mode === "manual";
  $("addUrlBlock")?.classList.toggle("hidden", isManual);
  $("addManualBlock")?.classList.toggle("hidden", !isManual);
  $("btnAddSubmit").textContent = isManual ? "Create Manual Job" : "Ingest";
}

async function doIngest() {
  const box = $("addResult");
  try {
    spin(true);
    box.classList.add("hidden");
    box.innerHTML = "";
    const mode = $("addMode")?.value || "url";
    const isManual = mode === "manual";

    let data;
    let results;
    let firstKey = null;

    if (isManual) {
      const ref = String($("manualRef")?.value || "").trim();
      const jdText = String($("manualJdText")?.value || "").trim();
      const syntheticUrl = buildManualSyntheticUrl_(ref);
      const ingestRes = await api("/ingest", { method: "POST", body: { raw_urls: [syntheticUrl] } });
      data = ingestRes?.data || {};
      results = Array.isArray(data.results) ? data.results : [];
      firstKey = results[0]?.job_key || null;

      if (jdText.length >= 200 && firstKey) {
        await api(`/jobs/${encodeURIComponent(firstKey)}/manual-jd`, {
          method: "POST",
          body: { jd_text_clean: jdText },
        });
        data = {
          ...data,
          note: "Manual JD saved and rescored",
        };
      } else if (jdText.length > 0 && jdText.length < 200) {
        data = {
          ...data,
          note: "Manual job created; add 200+ chars JD to score.",
        };
      } else {
        data = {
          ...data,
          note: "Manual job created; paste JD in detail view when ready.",
        };
      }
    } else {
      const res = await ingestUrls($("addUrlText").value);
      data = res?.data || {};
      results = Array.isArray(data.results) ? data.results : [];
      firstKey = results[0]?.job_key || null;
    }

    const inserted = Number.isFinite(data?.inserted_count)
      ? data.inserted_count
      : results.filter((r) => r?.action === "inserted").length;
    const updated = Number.isFinite(data?.updated_count)
      ? data.updated_count
      : results.filter((r) => r?.action === "updated").length;
    const ignored = Number.isFinite(data?.ignored)
      ? data.ignored
      : results.filter((r) => r?.action === "ignored").length;
    const linkOnly = Number.isFinite(data?.link_only)
      ? data.link_only
      : results.filter((r) => String(r?.status || "").toUpperCase() === "LINK_ONLY").length;

    const note = data?.note ? `<div style="margin-top:8px;"><b>note:</b> ${escapeHtml(String(data.note))}</div>` : "";
    box.innerHTML = renderIngestResultBox(data) + note;
    box.classList.remove("hidden");
    $("addUrlText").value = "";
    $("manualRef").value = "";
    $("manualJdText").value = "";

    $("statusFilter").value = "";
    $("search").value = "";
    toast(`Ingested: ${inserted} inserted, ${updated} updated, ${ignored} ignored, ${linkOnly} link-only`);
    await loadJobs();

    if (firstKey) await setActive(firstKey);
  } catch (e) {
    box.textContent = "Error: " + e.message + "\n\n" + JSON.stringify(e.payload || {}, null, 2);
    box.classList.remove("hidden");
    toast("Ingest failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function rescorePending(status = "NEW") {
  try {
    spin(true);
    const body = { limit: 50 };
    if (status) body.status = status;
    const res = await api("/score-pending", { method: "POST", body });
    toast(`Rescore ${status || "NEW"} done - picked ${res.data?.picked ?? "-"} - updated ${res.data?.updated ?? "-"}`);
    await loadJobs();
  } catch (e) {
    toast("Rescore failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function rescoreExistingJd(limit = 60) {
  try {
    spin(true);
    const res = await api("/jobs/recover/rescore-existing-jd", {
      method: "POST",
      body: { limit },
    });
    const d = res?.data || {};
    toast(`Rescore existing JD - picked ${d.picked ?? "-"} - updated ${d.updated ?? "-"}`);
    await loadJobs();
    if (state.activeKey) await setActive(state.activeKey);
  } catch (e) {
    toast("Rescore existing JD failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function retryFetchMissingJd(limit = 60) {
  try {
    spin(true);
    const res = await api("/jobs/recover/retry-fetch-missing-jd", {
      method: "POST",
      body: { limit },
    });
    const d = res?.data || {};
    toast(`Retry fetch missing JD - picked ${d.picked ?? "-"} - processed ${d.processed ?? "-"}`);
    await loadJobs();
    if (state.activeKey) await setActive(state.activeKey);
  } catch (e) {
    toast("Retry fetch missing JD failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function recoverMissingFields(limit = 30) {
  try {
    spin(true);
    const res = await api("/jobs/recover/missing-fields", {
      method: "POST",
      body: { limit },
    });
    const d = res?.data || {};
    toast(`Missing fields recover - picked ${d.picked ?? "-"} - updated ${d.updated ?? "-"} - skipped ${d.skipped ?? "-"}`);
    await loadJobs({ ignoreStatus: true });
    if (state.activeKey) await setActive(state.activeKey);
  } catch (e) {
    toast("Recover missing fields failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function canonicalizeTitles(limit = 200) {
  const ok = confirm("Run role-title canonicalization now? This will clean noisy/missing titles from existing URLs.");
  if (!ok) return;
  try {
    spin(true);
    const res = await api("/jobs/canonicalize-titles", {
      method: "POST",
      body: { limit, only_missing: true },
    });
    const d = res?.data || {};
    toast(`Canonicalize titles - scanned ${d.scanned ?? "-"} - updated ${d.updated ?? "-"} - skipped ${d.skipped ?? "-"}`);
    await loadJobs({ ignoreStatus: true });
    if (state.activeKey) await setActive(state.activeKey);
  } catch (e) {
    toast("Canonicalize titles failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function recoverMissingDetailsFromTracking(limit = 10) {
  const ok = confirm("Run recovery now? This retries missing-details fetch and then rescoring.");
  if (!ok) return;
  try {
    spin(true);
    toast(`Recovery started (limit ${limit})...`, { kind: "info", duration: 1800 });
    const backfillRes = await api("/jobs/backfill-missing", {
      method: "POST",
      body: { limit },
    });
    const fillRes = await api("/jobs/recover/missing-fields", {
      method: "POST",
      body: { limit },
    });
    const rescoreRes = await api("/jobs/recover/rescore-existing-jd", {
      method: "POST",
      body: { limit },
    });

    const b = backfillRes?.data || {};
    const f = fillRes?.data || {};
    const r = rescoreRes?.data || {};
    const sourceSummary = Array.isArray(b.source_summary) ? b.source_summary : [];
    const snapshot = {
      ts: Date.now(),
      fetch_processed: Number(b.processed || 0),
      fetch_updated: Number(b.updated_count || 0),
      fields_updated: Number(f.updated || 0),
      rescore_updated: Number(r.updated || 0),
      rescore_picked: Number(r.picked || 0),
      source_summary: sourceSummary,
    };
    state.lastRecoveryRun = snapshot;
    saveLastRecoveryRun_(snapshot);
    renderTrackingRecoverySummary_();

    const sourceText = sourceSummary.length
      ? sourceSummary
        .slice(0, 4)
        .map((s) => {
          const src = String(s.source_domain || "unknown");
          const recovered = Number(s.recovered || 0);
          const manual = Number(s.manual_needed || 0);
          const needsAi = Number(s.needs_ai || 0);
          return `${src}: rec ${recovered}, manual ${manual}, ai ${needsAi}`;
        })
        .join(" | ")
      : "";
    toast(
      `Recovery complete - fetch ${b.processed ?? 0}/${b.updated_count ?? 0}, fields ${f.updated ?? 0}, rescore ${r.updated ?? 0}/${r.picked ?? 0}${sourceText ? ` | ${sourceText}` : ""}`
    );

    await loadJobs({ ignoreStatus: true });
    if (state.activeKey) await setActive(state.activeKey);
  } catch (e) {
    toast("Recover missing details failed: " + e.message);
  } finally {
    spin(false);
  }
}

function hydrateSettingsUI() {
  const cfg = getCfg();
  $("apiHost").textContent = cfg.apiBase.replace(/^https?:\/\//, "");
}

function openSettings() {
  const cfg = getCfg();
  $("setApiBase").value = cfg.apiBase;
  $("setUiKey").value = cfg.uiKey;
  openModal("modalSettings");
}

async function saveSettings() {
  const apiBase = $("setApiBase").value.trim();
  const uiKey = $("setUiKey").value.trim();
  if (!apiBase.startsWith("http")) {
    toast("API base must start with http(s)");
    return;
  }
  if (!uiKey) {
    toast("UI key is required");
    return;
  }
  setCfg({ apiBase, uiKey });
  closeModal("modalSettings");
  hydrateSettingsUI();
  toast("Saved settings");
  if (state.view === "jobs") await loadJobs();
  if (state.view === "tracking") await loadJobs({ ignoreStatus: true });
  if (state.view === "targets") await loadTargets();
  if (state.view === "metrics") await loadMetrics();
}

(function init() {
  setPdfReadyMode_(false);
  $("toast").onclick = () => $("toast").classList.add("hidden");
  $("btnDismissAiNotice").onclick = hideAiNotice;
  $("btnShowAiNotice").onclick = () => showAiNotice(true);
  if (localStorage.getItem(AI_NOTICE_DETECTED_KEY) === "1") {
    $("btnShowAiNotice").classList.remove("hidden");
  }

  $("btnTabJobs").onclick = () => showView("jobs");
  $("btnTabTracking").onclick = () => showView("tracking");
  $("btnTabTargets").onclick = () => showView("targets");
  $("btnTabMetrics").onclick = () => showView("metrics");
  $("btnMobileJobs").onclick = () => showView("jobs");
  $("btnMobileTracking").onclick = () => showView("tracking");
  $("btnMobileAdd").onclick = () => openModal("modalAdd");
  $("btnMobileRescore").onclick = () => rescorePending("NEW");

  $("btnAdd").onclick = () => openModal("modalAdd");
  $("btnCloseAdd").onclick = () => closeModal("modalAdd");
  $("btnAddCancel").onclick = () => closeModal("modalAdd");
  $("btnAddSubmit").onclick = doIngest;
  $("addMode").onchange = syncAddModeUi;

  $("btnSettings").onclick = openSettings;
  $("btnCloseSettings").onclick = () => closeModal("modalSettings");
  $("btnCancelSettings").onclick = () => closeModal("modalSettings");
  $("btnSaveSettings").onclick = saveSettings;

  $("btnRefresh").onclick = loadJobs;
  $("btnTrackingRefresh").onclick = () => loadJobs({ ignoreStatus: true });
  $("btnRescore").onclick = () => rescorePending("NEW");
  $("btnBatchOps").onclick = () => openModal("modalBatch");
  $("btnCloseBatch").onclick = () => closeModal("modalBatch");
  $("btnBatchCancel").onclick = () => closeModal("modalBatch");
  $("btnBatchRescoreNew").onclick = async () => { closeModal("modalBatch"); await rescorePending("NEW"); };
  $("btnBatchRescoreScored").onclick = async () => { closeModal("modalBatch"); await rescorePending("SCORED"); };
  $("btnBatchRescoreExistingJd").onclick = async () => { closeModal("modalBatch"); await rescoreExistingJd(60); };
  $("btnBatchRetryFetchMissingJd").onclick = async () => { closeModal("modalBatch"); await retryFetchMissingJd(60); };
  $("btnCloseReview").onclick = () => closeModal("modalReview");
  $("btnReviewSave").onclick = saveDraft;
  $("btnReviewApprove").onclick = approvePack;
  $("reviewSummary").oninput = updateReviewSummaryMeta_;

  $("btnTargetsRefresh").onclick = loadTargets;
  $("btnTargetNew").onclick = createNewTarget;
  $("btnMetricsRefresh").onclick = loadMetrics;
  $("targetSearch").oninput = renderTargets;

  $("statusFilter").onchange = loadJobs;
  $("search").oninput = () => { renderJobs(); renderListMeta(); };
  $("sortBy").onchange = () => { renderJobs(); renderListMeta(); };
  $("queueFilter").onchange = () => { renderJobs(); renderListMeta(); };
  $("trackingSearch").oninput = () => renderTracking();
  $("trackingSort").onchange = () => renderTracking();
  $("trackingQueue").onchange = () => renderTracking();
  $("trackingScope").onchange = () => renderTracking();
  $("trackingWindow").onchange = () => renderTracking();
  $("trackingLimit").onchange = () => renderTracking();
  $("trackingTriageDays").onchange = () => loadTrackingTriage({ force: true });
  $("btnTrackingTriageRefresh").onclick = () => loadTrackingTriage({ force: true });
  $("btnTrackingRecover").onclick = () => recoverMissingDetailsFromTracking(10);
  $("btnTrackingRecoverFields").onclick = () => recoverMissingFields(30);
  $("btnTrackingCanonicalizeTitles").onclick = () => canonicalizeTitles(200);
  $("btnTrackingFiltersToggle").onclick = () => {
    state.trackingFiltersOpen = !state.trackingFiltersOpen;
    syncTrackingControlsUi_();
  };
  window.addEventListener("resize", syncTrackingControlsUi_);

  const cfg = getCfg();
  if (!cfg.uiKey) setTimeout(() => openSettings(), 50);
  hydrateSettingsUI();
  syncAddModeUi();
  loadResumeProfiles();
  loadResumeTemplates_();
  syncTrackingControlsUi_();
  showView("jobs");
  loadJobs();
})();

window.updateStatus = updateStatus;
window.rescoreOne = rescoreOne;
window.saveAndRescoreManualJd = saveAndRescoreManualJd;
window.saveActiveTarget = saveActiveTarget;
window.createNewTarget = createNewTarget;
window.appendKeyword = appendKeyword;
window.saveResumeProfileFromUi = saveResumeProfileFromUi;
window.saveResumeTemplateFromUi = saveResumeTemplateFromUi;
window.deleteResumeTemplateFromUi = deleteResumeTemplateFromUi;
window.selectAtsKeywords = selectAtsKeywords;
window.runNextAction = runNextAction;
window.runJobPrimaryAction = runJobPrimaryAction;
window.autoPilotJob = autoPilotJob;
window.generateApplicationPack = generateApplicationPack;
window.openReviewModal = openReviewModal;
window.saveDraft = saveDraft;
window.approvePack = approvePack;
window.saveWizardDraft = saveWizardDraft;
window.approveWizardPack = approveWizardPack;
window.copyWizardCoverLetter = copyWizardCoverLetter;
window.draftWizardOutreach = draftWizardOutreach;
window.copyWizardOutreach = copyWizardOutreach;
window.markWizardOutreachStatus = markWizardOutreachStatus;
window.togglePdfReadyMode = togglePdfReadyMode;
window.printPdfReadyView = printPdfReadyView;
window.copyPackSummary = copyPackSummary;
window.copyPackBullets = copyPackBullets;
window.downloadRrJson = downloadRrJson;
window.downloadLatestRrPdf = downloadLatestRrPdf;
window.exportReactiveResumePdf = exportReactiveResumePdf;
window.pushToReactiveResume = pushToReactiveResume;
window.rebuildEvidence = rebuildEvidence;


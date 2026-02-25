const DEFAULT_API_BASE = "https://get-job.shivanand-shah94.workers.dev";

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

const state = {
  view: "jobs",
  jobs: [],
  activeKey: null,
  targets: [],
  activeTargetId: null,
  metrics: null,
  rejectKeywordsEnabled: true,
  resumeProfiles: [],
  activeProfileId: "primary",
  profileJsonDraftById: {},
};

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

function showView(view) {
  state.view = view;
  const jobsView = $("jobsView");
  const targetsView = $("targetsView");
  const metricsView = $("metricsView");
  jobsView.classList.toggle("hidden", view !== "jobs");
  targetsView.classList.toggle("hidden", view !== "targets");
  metricsView.classList.toggle("hidden", view !== "metrics");

  $("btnTabJobs").classList.toggle("active-tab", view === "jobs");
  $("btnTabTargets").classList.toggle("active-tab", view === "targets");
  $("btnTabMetrics").classList.toggle("active-tab", view === "metrics");

  const jobsActionsHidden = view !== "jobs";
  $("btnAdd").classList.toggle("hidden", jobsActionsHidden);
  $("btnRescore").classList.toggle("hidden", jobsActionsHidden);

  if (view === "targets") loadTargets();
  if (view === "metrics") loadMetrics();
}

function fmtNum(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function fmtTs(v) {
  const n = Number(v || 0);
  if (!n) return "-";
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
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

  $("metricsGeneratedAt").value = fmtTs(m.generated_at);
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
    metricCard("Latest Processed", gmailLatest.processed || 0, `at ${fmtTs(gmailLatest.ts)}`),
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

function filterJobs(jobs, status, q) {
  let out = jobs;
  if (status) out = out.filter((j) => String(j.status || "").toUpperCase() === status);
  if (q) {
    out = out.filter((j) => {
      const s = `${getDisplayTitle(j)} ${j.company || ""} ${j.location || ""} ${j.source_domain || ""}`.toLowerCase();
      return s.includes(q);
    });
  }
  return out;
}

function renderListMeta() {
  const status = $("statusFilter").value;
  const q = $("search").value.trim().toLowerCase();
  const filtered = filterJobs(state.jobs, status, q);
  $("listHint").textContent = `${filtered.length} job(s)` + (status ? ` - ${status}` : "");
}

function jobCard(j) {
  const score = (j.final_score === null || j.final_score === undefined) ? "-" : j.final_score;
  const loc = j.location || "-";
  const comp = getDisplayCompany(j) || "-";
  const role = getDisplayTitle(j);
  const status = String(j.status || "").toUpperCase();
  const systemStatus = String(j.system_status || "").toUpperCase();
  const needsJdBadge = systemStatus === "NEEDS_MANUAL_JD"
    ? `<span class="chip">Needs JD</span>`
    : "";
  const isActive = state.activeKey === j.job_key;

  return `
    <div class="job-card ${isActive ? "active" : ""}" data-key="${escapeHtml(j.job_key)}" tabindex="0">
      <div class="row1">
        <div>
          <div class="title">${escapeHtml(role)}</div>
          <div class="sub">${escapeHtml(comp)} - ${escapeHtml(loc)}</div>
        </div>
        <div class="score" title="Final score">${escapeHtml(String(score))}</div>
      </div>
      <div class="meta">
        <span class="badge ${escapeHtml(status)}">${escapeHtml(status || "-")}</span>
        ${needsJdBadge}
        <span class="chip">${escapeHtml(j.source_domain || "-")}</span>
        <span class="chip">${escapeHtml(j.seniority || "-")}</span>
      </div>
    </div>
  `;
}

function renderJobs() {
  const q = $("search").value.trim().toLowerCase();
  const filtered = filterJobs(state.jobs, "", q);
  const container = $("jobList");
  container.innerHTML = filtered.map(jobCard).join("") || `<div class="muted">No jobs found.</div>`;

  container.querySelectorAll(".job-card").forEach((el) => {
    el.addEventListener("click", () => setActive(el.dataset.key));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") setActive(el.dataset.key);
    });
  });
}

async function loadJobs() {
  try {
    spin(true);
    const status = $("statusFilter").value;
    const qs = status ? `?status=${encodeURIComponent(status)}&limit=200&offset=0` : `?limit=200&offset=0`;
    const res = await api("/jobs" + qs);
    state.jobs = Array.isArray(res.data) ? res.data : [];
    renderJobs();
    renderListMeta();
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
    renderDetail(res.data);
  } catch (e) {
    toast("Open failed: " + e.message);
  } finally {
    spin(false);
  }
}

function renderDetail(j) {
  $("detailBody").classList.remove("empty");
  const headerTitle = getDisplayTitle(j);
  const headerCompany = getDisplayCompany(j) || "-";
  const missingCore = !String(j.role_title || "").trim() && !String(j.company || "").trim();
  const fetchedLowQuality =
    String(j.jd_source || "").toLowerCase() === "fetched" &&
    (
      String(j.system_status || "").toUpperCase() === "NEEDS_MANUAL_JD" ||
      ["blocked", "low_quality", "failed"].includes(String(j.fetch_status || "").toLowerCase())
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
  const needsManualJd = String(j.system_status || "").toUpperCase() === "NEEDS_MANUAL_JD" || !String(j.role_title || "").trim();

  $("detailBody").innerHTML = `
    <div class="kv">
      <div class="k">Status</div><div class="v"><span class="badge ${escapeHtml(status)}">${escapeHtml(status || "-")}</span></div>
      <div class="k">Final score</div><div class="v">${escapeHtml(String(j.final_score ?? "-"))}</div>
      <div class="k">Target</div><div class="v">${escapeHtml(j.primary_target_id || "-")}</div>
      <div class="k">Location</div><div class="v">${escapeHtml(j.location || "-")}</div>
      <div class="k">Seniority</div><div class="v">${escapeHtml(j.seniority || "-")}</div>
      <div class="k">Source</div><div class="v">${escapeHtml(j.source_domain || "-")}</div>
      <div class="k">Updated</div><div class="v">${escapeHtml(String(j.updated_at || ""))}</div>
    </div>

    <div class="actions-grid">
      <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','APPLIED')">Mark APPLIED</button>
      <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','SHORTLISTED')">Mark SHORTLISTED</button>
      <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','REJECTED')">Mark REJECTED</button>
      <button class="btn btn-secondary" onclick="updateStatus('${escapeHtml(j.job_key)}','ARCHIVED')">Mark ARCHIVED</button>
      <button class="btn" onclick="rescoreOne('${escapeHtml(j.job_key)}')">Rescore this job</button>
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
      <div class="k">System status</div><div class="v">${escapeHtml(j.system_status || j.next_status || "-")}</div>
      <div class="k">Job URL</div><div class="v"><a class="muted" href="${escapeHtml(j.job_url || "#")}" target="_blank" rel="noopener">${escapeHtml(j.job_url || "-")}</a></div>
    </div>

    <div id="appPackSection" class="kv">
      <div class="k">Application Pack</div><div class="v">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <span id="appPackStatus"><span class="badge">-</span></span>
          <span class="chip">ATS: <b id="appAtsScore">-</b></span>
        </div>
        <div id="appPackEmpty" class="muted tiny" style="margin-top:8px;">No Application Pack yet</div>
      </div>
      <div class="k">Missing keywords</div><div class="v" id="appMissingKw">-</div>
      <div class="k">Profile</div><div class="v">
        <select id="appProfileSelect"></select>
        <select id="appRenderer" style="margin-top:8px;">
          <option value="reactive_resume">reactive_resume</option>
          <option value="html_simple">html_simple</option>
        </select>
      </div>
      <div class="k">Profile ID</div><div class="v"><input id="appProfileId" placeholder="primary" /></div>
      <div class="k">Profile Name</div><div class="v"><input id="appProfileName" placeholder="Primary" /></div>
      <div class="k">Profile JSON</div><div class="v"><textarea id="appProfileJson" rows="5" placeholder='{"basics":{},"summary":"","experience":[],"skills":[]}'></textarea></div>
      <div class="k">Actions</div><div class="v">
        <div class="row" style="justify-content:flex-start; margin-top:0;">
          <button class="btn btn-secondary" onclick="saveResumeProfileFromUi()">Save Profile</button>
          <button class="btn" onclick="generateApplicationPack('${escapeHtml(j.job_key)}', false)">Generate</button>
          <button class="btn btn-secondary" onclick="generateApplicationPack('${escapeHtml(j.job_key)}', true)">Regenerate</button>
          <button class="btn btn-secondary" onclick="copyPackSummary()">Copy tailored summary</button>
          <button class="btn btn-secondary" onclick="copyPackBullets()">Copy tailored bullets</button>
          <button class="btn btn-secondary" onclick="downloadRrJson()">Download RR JSON</button>
        </div>
      </div>
    </div>

    ${needsManualJd ? `
      <div class="h3" style="margin: 12px 0 8px;">Paste JD (Manual)</div>
      <div class="muted tiny" style="margin-bottom: 8px;">Paste full JD text and save to extract + rescore.</div>
      <textarea id="manualJd" rows="8" placeholder="Paste JD text here..."></textarea>
      <div class="row" style="justify-content:flex-start;">
        <button class="btn" onclick="saveAndRescoreManualJd('${escapeHtml(j.job_key)}')">Save & Rescore</button>
      </div>
    ` : ""}
  `;
  if (window.location.hostname.includes("workers.dev")) {
    console.log("Rendering Application Pack", j.job_key);
  }
  hydrateApplicationPack(j.job_key);
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
  return `
    <div class="job-card ${isActive ? "active" : ""}" data-target-id="${escapeHtml(t.id || "")}" tabindex="0">
      <div class="title">${escapeHtml(getTargetDisplay(t))}</div>
      <div class="sub">${escapeHtml(t.primary_role || "-")} | ${escapeHtml(t.seniority_pref || "-")} | ${escapeHtml(t.location_pref || "-")}</div>
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

function resumeProfilesOptionsHtml() {
  return state.resumeProfiles
    .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === state.activeProfileId ? " selected" : ""}>${escapeHtml(p.name || p.id)}</option>`)
    .join("");
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
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/generate-application-pack`, {
      method: "POST",
      body: {
        profile_id: state.activeProfileId || "primary",
        force: Boolean(force),
        renderer,
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

async function hydrateApplicationPack(jobKey) {
  const section = $("appPackSection");
  if (!section) return;

  const profileSelect = $("appProfileSelect");
  if (profileSelect) {
    profileSelect.innerHTML = resumeProfilesOptionsHtml() || `<option value="primary">Primary</option>`;
    profileSelect.value = state.activeProfileId || "primary";
    profileSelect.onchange = async () => {
      state.activeProfileId = profileSelect.value || "primary";
      await loadResumeProfileDetail(state.activeProfileId, { silent: true });
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
    const status = String(d.status || "-");
    const ats = d.ats_json || {};
    const missing = Array.isArray(ats.missing_keywords) ? ats.missing_keywords : [];
    $("appPackStatus").innerHTML = `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
    $("appAtsScore").textContent = String(ats.score ?? "-");
    $("appMissingKw").textContent = missing.length ? missing.join(", ") : "-";
    $("appPackEmpty").textContent = "Application Pack loaded";
    section.dataset.packSummary = String(d?.pack_json?.tailoring?.summary || "");
    section.dataset.packBullets = Array.isArray(d?.pack_json?.tailoring?.bullets) ? d.pack_json.tailoring.bullets.join("\n") : "";
    section.dataset.rrJson = JSON.stringify(d?.rr_export_json || {}, null, 2);
  } catch (e) {
    $("appPackStatus").innerHTML = `<span class="badge">-</span>`;
    $("appAtsScore").textContent = "-";
    $("appMissingKw").textContent = e.httpStatus === 404 ? "-" : ("Error: " + e.message);
    $("appPackEmpty").textContent = e.httpStatus === 404 ? "No Application Pack yet" : ("Application Pack unavailable: " + e.message);
    section.dataset.packSummary = "";
    section.dataset.packBullets = "";
    section.dataset.rrJson = "{}";
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
  const txt = String($("appPackSection")?.dataset?.rrJson || "{}");
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
  const jdText = String($("manualJd")?.value || "").trim();
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
  if (state.view === "targets") await loadTargets();
  if (state.view === "metrics") await loadMetrics();
}

(function init() {
  $("toast").onclick = () => $("toast").classList.add("hidden");
  $("btnDismissAiNotice").onclick = hideAiNotice;
  $("btnShowAiNotice").onclick = () => showAiNotice(true);
  if (localStorage.getItem(AI_NOTICE_DETECTED_KEY) === "1") {
    $("btnShowAiNotice").classList.remove("hidden");
  }

  $("btnTabJobs").onclick = () => showView("jobs");
  $("btnTabTargets").onclick = () => showView("targets");
  $("btnTabMetrics").onclick = () => showView("metrics");

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
  $("btnRescore").onclick = () => rescorePending("NEW");
  $("btnBatchOps").onclick = () => openModal("modalBatch");
  $("btnCloseBatch").onclick = () => closeModal("modalBatch");
  $("btnBatchCancel").onclick = () => closeModal("modalBatch");
  $("btnBatchRescoreNew").onclick = async () => { closeModal("modalBatch"); await rescorePending("NEW"); };
  $("btnBatchRescoreScored").onclick = async () => { closeModal("modalBatch"); await rescorePending("SCORED"); };

  $("btnTargetsRefresh").onclick = loadTargets;
  $("btnTargetNew").onclick = createNewTarget;
  $("btnMetricsRefresh").onclick = loadMetrics;
  $("targetSearch").oninput = renderTargets;

  $("statusFilter").onchange = loadJobs;
  $("search").oninput = () => { renderJobs(); renderListMeta(); };

  const cfg = getCfg();
  if (!cfg.uiKey) setTimeout(() => openSettings(), 50);
  hydrateSettingsUI();
  syncAddModeUi();
  loadResumeProfiles();
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
window.generateApplicationPack = generateApplicationPack;
window.copyPackSummary = copyPackSummary;
window.copyPackBullets = copyPackBullets;
window.downloadRrJson = downloadRrJson;

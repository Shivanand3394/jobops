// JobOps UI V3 Premium+
// - Clickable list -> detail view
// - Add URL -> POST /ingest then refresh
// - Rescore -> POST /score-pending (uses x-ui-key)
// - Filters + search (search is client-side; API doesn't support q)

const DEFAULT_API_BASE = "https://get-job.shivanand-shah94.workers.dev";

function getCfg() {
  return {
    apiBase: (localStorage.getItem("jobops_api_base") || DEFAULT_API_BASE).replace(/\/+$/, ""),
    uiKey: localStorage.getItem("jobops_ui_key") || ""
  };
}

function setCfg({ apiBase, uiKey }) {
  if (apiBase) localStorage.setItem("jobops_api_base", apiBase.replace(/\/+$/, ""));
  if (uiKey !== undefined) localStorage.setItem("jobops_ui_key", uiKey);
}

const $ = (id) => document.getElementById(id);

let state = {
  jobs: [],
  activeKey: null,
};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function spin(on) {
  $("spinner").classList.toggle("hidden", !on);
}

async function api(path, { method="GET", body=null, useUiKey=true } = {}) {
  const cfg = getCfg();
  if (!cfg.uiKey) throw new Error("Missing UI_KEY. Open Settings and set UI key.");

  const headers = { "Content-Type": "application/json" };
  if (useUiKey) headers["x-ui-key"] = cfg.uiKey;

  const res = await fetch(cfg.apiBase + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  // Try JSON; fall back to text
  let data;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) data = await res.json();
  else data = { ok: res.ok, text: await res.text() };

  if (!res.ok || data?.ok === false) {
    const msg = data?.error || data?.detail || data?.text || ("HTTP " + res.status);
    const err = new Error(msg);
    err.httpStatus = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function renderListMeta() {
  const status = $("statusFilter").value;
  const q = $("search").value.trim().toLowerCase();
  const filtered = filterJobs(state.jobs, status, q);
  $("listHint").textContent = `${filtered.length} job(s)` + (status ? ` • ${status}` : "");
}

function filterJobs(jobs, status, q) {
  let out = jobs;
  if (status) out = out.filter(j => String(j.status||"").toUpperCase() === status);
  if (q) {
    out = out.filter(j => {
      const s = `${j.role_title||""} ${j.company||""} ${j.location||""} ${j.source_domain||""}`.toLowerCase();
      return s.includes(q);
    });
  }
  return out;
}

function jobCard(j) {
  const score = (j.final_score === null || j.final_score === undefined) ? "-" : j.final_score;
  const loc = j.location || "—";
  const comp = j.company || "—";
  const role = j.role_title || "(untitled)";
  const status = String(j.status || "").toUpperCase();
  const isActive = state.activeKey === j.job_key;

  return `
    <div class="job-card ${isActive ? "active" : ""}" data-key="${escapeHtml(j.job_key)}" tabindex="0">
      <div class="row1">
        <div>
          <div class="title">${escapeHtml(role)}</div>
          <div class="sub">${escapeHtml(comp)} • ${escapeHtml(loc)}</div>
        </div>
        <div class="score" title="Final score">${escapeHtml(String(score))}</div>
      </div>
      <div class="meta">
        <span class="badge ${escapeHtml(status)}">${escapeHtml(status || "—")}</span>
        <span class="chip">${escapeHtml(j.source_domain || "—")}</span>
        <span class="chip">${escapeHtml(j.seniority || "—")}</span>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadJobs() {
  try {
    spin(true);
    // API doesn't support search query; we fetch and filter client-side.
    const status = $("statusFilter").value;
    // Keep list snappy by fetching by status if filter set; else fetch latest 200.
    const limit = status ? 200 : 200;
    const qs = status ? `?status=${encodeURIComponent(status)}&limit=${limit}&offset=0` : `?limit=${limit}&offset=0`;
    const res = await api("/jobs" + qs);
    const list = Array.isArray(res.data) ? res.data : [];

    // If status filter is set, list already status-filtered. If All, list is All.
    state.jobs = list;

    renderJobs();
    renderListMeta();

    // If active job disappeared (e.g., filter changed), clear detail
    if (state.activeKey && !state.jobs.some(j => j.job_key === state.activeKey)) {
      setActive(null);
    }
  } catch (e) {
    toast("Load failed: " + e.message);
  } finally {
    spin(false);
  }
}

function renderJobs() {
  const status = $("statusFilter").value;
  const q = $("search").value.trim().toLowerCase();
  const filtered = filterJobs(state.jobs, "", q); // if status filter, jobs already filtered server-side; keep client filter only for q

  const container = $("jobList");
  container.innerHTML = filtered.map(jobCard).join("") || `<div class="muted">No jobs found.</div>`;

  // Wire clicks
  container.querySelectorAll(".job-card").forEach(el => {
    el.addEventListener("click", () => setActive(el.dataset.key));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") setActive(el.dataset.key);
    });
  });
}

async function setActive(jobKey) {
  state.activeKey = jobKey;
  // Highlight active in list
  renderJobs();
  renderListMeta();

  if (!jobKey) {
    $("dRole").textContent = "Select a job";
    $("dCompany").textContent = "";
    $("detailBody").classList.add("empty");
    $("detailBody").innerHTML = `
      <div class="empty-state">
        <div class="empty-hero">👈</div>
        <div class="h3">Pick a job from the left.</div>
        <div class="muted">Then update status, rescore, or paste JD if needed.</div>
      </div>
    `;
    return;
  }

  try {
    spin(true);
    const res = await api("/jobs/" + encodeURIComponent(jobKey));
    const j = res.data;
    renderDetail(j);
  } catch (e) {
    toast("Open failed: " + e.message);
  } finally {
    spin(false);
  }
}

function renderDetail(j) {
  $("detailBody").classList.remove("empty");

  const role = j.role_title || "(untitled)";
  const comp = j.company || "—";
  $("dRole").textContent = role;
  $("dCompany").textContent = comp;

  const openHref = j.job_url || "#";
  const openBtn = $("dOpen");
  openBtn.href = openHref;
  openBtn.style.pointerEvents = openHref === "#" ? "none" : "auto";
  openBtn.style.opacity = openHref === "#" ? .5 : 1;

  $("btnCopyKey").onclick = async () => {
    try {
      await navigator.clipboard.writeText(j.job_key);
      toast("Copied job_key");
    } catch {
      toast("Copy failed");
    }
  };

  const status = String(j.status || "").toUpperCase();

  $("detailBody").innerHTML = `
    <div class="kv">
      <div class="k">Status</div><div class="v"><span class="badge ${escapeHtml(status)}">${escapeHtml(status||"—")}</span></div>
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
      <div class="k">Must-have keywords</div><div class="v">${escapeHtml((j.must_have_keywords||[]).join(", ") || "-")}</div>
      <div class="k">Nice-to-have</div><div class="v">${escapeHtml((j.nice_to_have_keywords||[]).join(", ") || "-")}</div>
      <div class="k">Reject keywords</div><div class="v">${escapeHtml((j.reject_keywords||[]).join(", ") || "-")}</div>
      <div class="k">Reason</div><div class="v">${escapeHtml(j.reason_top_matches || "-")}</div>
    </div>

    <div class="kv">
      <div class="k">JD source</div><div class="v">${escapeHtml(j.jd_source || "-")}</div>
      <div class="k">Fetch status</div><div class="v">${escapeHtml(j.fetch_status || "-")}</div>
      <div class="k">System status</div><div class="v">${escapeHtml(j.system_status || j.next_status || "-")}</div>
      <div class="k">Job URL</div><div class="v"><a class="muted" href="${escapeHtml(j.job_url||"#")}" target="_blank" rel="noopener">${escapeHtml(j.job_url||"-")}</a></div>
    </div>

    <div class="h3" style="margin: 12px 0 8px;">Manual JD (only if LINK_ONLY / blocked)</div>
    <div class="muted tiny" style="margin-bottom: 8px;">
      If scraping is blocked (LinkedIn), paste JD text here and we can re-extract + score.
      (Requires worker endpoints: /extract-jd + /score-jd and an upsert route. If you haven't wired that yet, this box is just a note.)
    </div>
    <textarea id="manualJd" rows="7" placeholder="Paste JD text..."></textarea>
    <div class="row" style="justify-content:flex-start;">
      <button class="btn btn-secondary" onclick="toast('Manual JD wiring: next step (we can add endpoint to save + extract + score).')">Save + Extract + Score</button>
    </div>
  `;
}

async function updateStatus(jobKey, status) {
  try {
    spin(true);
    await api(`/jobs/${encodeURIComponent(jobKey)}/status`, { method:"POST", body:{ status } });
    toast("Status updated: " + status);
    await loadJobs();
    await setActive(jobKey);
  } catch (e) {
    toast("Status failed: " + e.message);
  } finally {
    spin(false);
  }
}

// Try to rescore a single job. If endpoint doesn't exist, show guidance.
async function rescoreOne(jobKey) {
  try {
    spin(true);
    // Prefer a single-job endpoint if you add it later.
    // We'll attempt /score-one, fall back to score-pending and refresh.
    try {
      await api(`/score-one`, { method:"POST", body:{ job_key: jobKey } });
      toast("Rescored");
    } catch (e) {
      // fallback: batch scoring (will usually skip SHORTLISTED)
      await api(`/score-pending`, { method:"POST", body:{ limit: 50 } });
      toast("Batch rescore run (if job already SHORTLISTED it may be skipped)");
    }
    await loadJobs();
    await setActive(jobKey);
  } catch (e) {
    toast("Rescore failed: " + e.message);
  } finally {
    spin(false);
  }
}

function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

async function ingestUrls(text) {
  const urls = String(text || "").split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) throw new Error("Paste at least one URL.");
  // /ingest is expected to accept x-ui-key in your worker.
  return api("/ingest", { method:"POST", body:{ raw_urls: urls } });
}

async function doIngest() {
  const box = $("addResult");
  try {
    spin(true);
    box.classList.add("hidden");
    box.textContent = "";

    const res = await ingestUrls($("addUrlText").value);
    box.textContent = JSON.stringify(res.data || res, null, 2);
    box.classList.remove("hidden");

    // Critical UX: user might be on a status filter that hides NEW jobs
    $("statusFilter").value = ""; // All
    $("search").value = "";
    toast("Ingested. Refreshing list…");
    await loadJobs();

    // If ingest returns job_key(s), open the first one.
    const results = res?.data?.results;
    const firstKey = Array.isArray(results) && results[0]?.job_key ? results[0].job_key : null;
    if (firstKey) await setActive(firstKey);
  } catch (e) {
    box.textContent = "Error: " + e.message + "\n\n" + JSON.stringify(e.payload || {}, null, 2);
    box.classList.remove("hidden");
    toast("Ingest failed: " + e.message);
  } finally {
    spin(false);
  }
}

async function rescorePending() {
  try {
    spin(true);
    const res = await api("/score-pending", { method:"POST", body:{ limit: 50 } });
    toast(`Rescore done • picked ${res.data?.picked ?? "-"} • updated ${res.data?.updated ?? "-"}`);
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
  await loadJobs();
}

// Boot
(function init(){
  // Wire controls
  $("btnAdd").onclick = () => openModal("modalAdd");
  $("btnCloseAdd").onclick = () => closeModal("modalAdd");
  $("btnAddCancel").onclick = () => closeModal("modalAdd");
  $("btnAddSubmit").onclick = doIngest;

  $("btnSettings").onclick = openSettings;
  $("btnCloseSettings").onclick = () => closeModal("modalSettings");
  $("btnCancelSettings").onclick = () => closeModal("modalSettings");
  $("btnSaveSettings").onclick = saveSettings;

  $("btnRefresh").onclick = loadJobs;
  $("btnRescore").onclick = rescorePending;
  $("btnRescore2").onclick = rescorePending;

  $("statusFilter").onchange = loadJobs;
  $("search").oninput = () => { renderJobs(); renderListMeta(); };

  // Ensure UI key present
  const cfg = getCfg();
  if (!cfg.uiKey) {
    // lightweight first-run
    setTimeout(() => openSettings(), 50);
  }
  hydrateSettingsUI();
  loadJobs();
})();
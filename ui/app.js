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

function getDisplayTitle(j) {
  return j.display_title || j.role_title || "(Needs JD)";
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
  const comp = j.company || "-";
  const role = getDisplayTitle(j);
  const status = String(j.status || "").toUpperCase();
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
  $("dRole").textContent = getDisplayTitle(j);
  $("dCompany").textContent = j.company || "-";

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

    ${needsManualJd ? `
      <div class="h3" style="margin: 12px 0 8px;">Paste JD (Manual)</div>
      <div class="muted tiny" style="margin-bottom: 8px;">Paste full JD text and save to extract + rescore.</div>
      <textarea id="manualJd" rows="8" placeholder="Paste JD text here..."></textarea>
      <div class="row" style="justify-content:flex-start;">
        <button class="btn" onclick="saveAndRescoreManualJd('${escapeHtml(j.job_key)}')">Save & Rescore</button>
      </div>
    ` : ""}
  `;
}

async function updateStatus(jobKey, status) {
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

async function doIngest() {
  const box = $("addResult");
  try {
    spin(true);
    box.classList.add("hidden");
    box.textContent = "";

    const res = await ingestUrls($("addUrlText").value);
    box.textContent = JSON.stringify(res.data || res, null, 2);
    box.classList.remove("hidden");

    $("statusFilter").value = "";
    $("search").value = "";
    toast("Ingested. Refreshing list...");
    await loadJobs();

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
    const res = await api("/score-pending", { method: "POST", body: { limit: 50 } });
    toast(`Rescore done - picked ${res.data?.picked ?? "-"} - updated ${res.data?.updated ?? "-"}`);
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

(function init() {
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

  const cfg = getCfg();
  if (!cfg.uiKey) setTimeout(() => openSettings(), 50);
  hydrateSettingsUI();
  loadJobs();
})();

window.updateStatus = updateStatus;
window.rescoreOne = rescoreOne;
window.saveAndRescoreManualJd = saveAndRescoreManualJd;

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
  rejectKeywordsEnabled: true,
  resumeProfiles: [],
  activeProfileId: "primary",
};

const AI_NOTICE_SESSION_KEY = "jobops_ai_notice_seen_session";
const AI_NOTICE_DETECTED_KEY = "jobops_ai_notice_detected";

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
  return j.display_title || j.role_title || "(Needs JD)";
}

function showView(view) {
  state.view = view;
  const jobsView = $("jobsView");
  const targetsView = $("targetsView");
  jobsView.classList.toggle("hidden", view !== "jobs");
  targetsView.classList.toggle("hidden", view !== "targets");

  $("btnTabJobs").classList.toggle("active-tab", view === "jobs");
  $("btnTabTargets").classList.toggle("active-tab", view === "targets");

  const jobsActionsHidden = view !== "jobs";
  $("btnAdd").classList.toggle("hidden", jobsActionsHidden);
  $("btnRescore").classList.toggle("hidden", jobsActionsHidden);
  $("btnRescore2").classList.toggle("hidden", jobsActionsHidden);

  if (view === "targets") loadTargets();
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

    <div id="appPackSection" class="kv">
      <div class="k">Application Pack</div><div class="v">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <span id="appPackStatus"><span class="badge">-</span></span>
          <span class="chip">ATS: <b id="appAtsScore">-</b></span>
        </div>
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

function renderTargetEditor(t) {
  $("targetEditor").classList.remove("empty");
  $("tTitle").textContent = t.id || "Target";
  $("tSub").textContent = t.name || "";

  const rejectBlock = state.rejectKeywordsEnabled
    ? `
      <div class="field">
        <label>reject_keywords_json</label>
        <textarea id="tReject" rows="3" placeholder="keyword1, keyword2">${escapeHtml(keywordsToText(t.reject_keywords_json ?? t.reject_keywords))}</textarea>
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
      </div>
      <div class="field">
        <label>nice_keywords_json</label>
        <textarea id="tNice" rows="3" placeholder="keyword1, keyword2">${escapeHtml(keywordsToText(t.nice_keywords_json ?? t.nice_keywords))}</textarea>
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

async function saveActiveTarget() {
  const targetId = state.activeTargetId;
  if (!targetId) {
    toast("Select a target first");
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

function resumeProfilesOptionsHtml() {
  return state.resumeProfiles
    .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === state.activeProfileId ? " selected" : ""}>${escapeHtml(p.name || p.id)}</option>`)
    .join("");
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
    profileSelect.onchange = () => {
      state.activeProfileId = profileSelect.value || "primary";
      const p = getActiveProfile();
      if (p) {
        $("appProfileId").value = p.id || "primary";
        $("appProfileName").value = p.name || "Primary";
      }
    };
  }

  const p = getActiveProfile();
  if ($("appProfileId")) $("appProfileId").value = p?.id || state.activeProfileId || "primary";
  if ($("appProfileName")) $("appProfileName").value = p?.name || "Primary";
  if ($("appProfileJson")) {
    $("appProfileJson").value = JSON.stringify({
      basics: { name: "", email: "", phone: "", location: "" },
      summary: "",
      experience: [],
      skills: [],
    }, null, 2);
  }

  try {
    const q = state.activeProfileId ? `?profile_id=${encodeURIComponent(state.activeProfileId)}` : "";
    const res = await api(`/jobs/${encodeURIComponent(jobKey)}/application-pack${q}`);
    const d = res.data || {};
    const status = String(d.status || "-");
    const ats = d.ats_json || {};
    const missing = Array.isArray(ats.missing_keywords) ? ats.missing_keywords : [];
    $("appPackStatus").innerHTML = `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
    $("appAtsScore").textContent = String(ats.score ?? "-");
    $("appMissingKw").textContent = missing.length ? missing.join(", ") : "-";
    section.dataset.packSummary = String(d?.pack_json?.tailoring?.summary || "");
    section.dataset.packBullets = Array.isArray(d?.pack_json?.tailoring?.bullets) ? d.pack_json.tailoring.bullets.join("\n") : "";
    section.dataset.rrJson = JSON.stringify(d?.rr_export_json || {}, null, 2);
  } catch (e) {
    $("appPackStatus").innerHTML = `<span class="badge">-</span>`;
    $("appAtsScore").textContent = "-";
    $("appMissingKw").textContent = e.httpStatus === 404 ? "No pack yet" : ("Error: " + e.message);
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
    box.innerHTML = "";

    const res = await ingestUrls($("addUrlText").value);
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
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

    box.innerHTML = renderIngestResultBox(data);
    box.classList.remove("hidden");
    $("addUrlText").value = "";

    $("statusFilter").value = "";
    $("search").value = "";
    toast(`Ingested: ${inserted} inserted, ${updated} updated, ${ignored} ignored, ${linkOnly} link-only`);
    await loadJobs();

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
  if (state.view === "jobs") await loadJobs();
  if (state.view === "targets") await loadTargets();
}

(function init() {
  $("btnDismissAiNotice").onclick = hideAiNotice;
  $("btnShowAiNotice").onclick = () => showAiNotice(true);
  if (localStorage.getItem(AI_NOTICE_DETECTED_KEY) === "1") {
    $("btnShowAiNotice").classList.remove("hidden");
  }

  $("btnTabJobs").onclick = () => showView("jobs");
  $("btnTabTargets").onclick = () => showView("targets");

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

  $("btnTargetsRefresh").onclick = loadTargets;
  $("targetSearch").oninput = renderTargets;

  $("statusFilter").onchange = loadJobs;
  $("search").oninput = () => { renderJobs(); renderListMeta(); };

  const cfg = getCfg();
  if (!cfg.uiKey) setTimeout(() => openSettings(), 50);
  hydrateSettingsUI();
  loadResumeProfiles();
  showView("jobs");
  loadJobs();
})();

window.updateStatus = updateStatus;
window.rescoreOne = rescoreOne;
window.saveAndRescoreManualJd = saveAndRescoreManualJd;
window.saveActiveTarget = saveActiveTarget;
window.saveResumeProfileFromUi = saveResumeProfileFromUi;
window.generateApplicationPack = generateApplicationPack;
window.copyPackSummary = copyPackSummary;
window.copyPackBullets = copyPackBullets;
window.downloadRrJson = downloadRrJson;

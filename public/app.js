"use strict";

/* ====================== helpers ====================== */

const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "value") el.value = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error?.message || "Request failed");
    e.code = body.error?.code; e.data = body; e.status = res.status;
    throw e;
  }
  return body;
}
const post = (p, d) => api(p, { method: "POST", body: JSON.stringify(d ?? {}) });
const put = (p, d) => api(p, { method: "PUT", body: JSON.stringify(d) });

function toast(text, kind) {
  const t = h("div", { class: "toast " + (kind || ""), role: kind === "error" ? "alert" : "status", text });
  $("toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 9000 : 4500);
}

const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
const fmtShort = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDur = (ms) => (ms === null || ms === undefined ? "" : ms < 1000 ? "under 1s" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const words = (s) => (String(s).trim() ? String(s).trim().split(/\s+/).length : 0);
const WORD_CAP = 110;
const chip = (label, tone) => h("span", { class: "chip " + (tone || "neutral"), text: label });
const lines = (s) => String(s).split("\n").map((x) => x.trim()).filter(Boolean);

function scoreBar(v, max) {
  const pct = Math.max(0, Math.min(100, ((v ?? 0) / (max || 5)) * 100));
  return h("div", { class: "sbar" }, h("div", { class: "track" }, h("div", { class: "fill", style: `width:${pct}%` })), h("i", { text: v ?? "" }));
}

/* ====================== plain-language dictionaries ====================== */

const TYPES = { funding: "Funding", expansion: "Expansion", ap_hiring: "AP hiring", erp_transformation: "ERP and finance systems", exec_statement: "Executive statement", growth: "Growth", other: "Other" };
const CLAIM_LABELS = { fact: "Fact from a source", inference: "Reasoned guess", hypothesis: "Question to explore", seller_claim: "About our product" };
const FRESH = { current: ["Current", "ok"], older_but_relevant: ["Older but relevant", "warn"], stale: ["Too old", "bad"], undated: ["No date", "neutral"] };
const REJECTIONS = { unverifiable_source: "Quote not found in the page", unparseable_date: "Date could not be read", blocked_category: "Sensitive topic, blocked", duplicate: "Duplicate" };
const WHY_NOT = { undated: "No date, so it cannot be the hook", stale: "Too old", blocked: "Sensitive topic", low_offer_fit: "Offer fit below 3", not_scored: "Over the scoring limit" };
const STAGES = [["company", "Resolve company"], ["verify", "Verify employment"], ["research", "Research"], ["extract", "Extract signals"], ["score", "Score signals"], ["draft", "Write draft"], ["ground", "Fact-check"]];
const ORIGINS = { generated: "Written by the app", regenerated: "Rewritten", edited: "Edited by you", fallback: "Generic draft" };
const NEXT_HELP = {
  tone_ack_missing: "Read the tone note on the right, then acknowledge it.",
  grounding_failed: "Edit the flagged sentences, or press Regenerate.",
  constraint_failed: "Edit the draft to fix the writing rule below.",
  no_grounding: "Press Check again.", grounding_stale: "Press Check again.",
  stale_hook: "Press Regenerate.", stale_person_specific: "Press Regenerate.", stale_claims: "Press Regenerate.", stale_verification: "Press Regenerate.", signal_invalid: "Press Regenerate.",
  employment_pending: "Press Re-check employment.", employment_expired: "Press Re-check employment.", employment_changed: "Press Re-check employment.", employment_failed: "Press Re-check employment.",
  employment_mismatch: "Correct the details with Edit details, then run again.",
};

const AGG = /zoominfo|rocketreach|apollo\.io|signalhire|contactout|leadiq|lusha|clay\.com|dnb\.com|crunchbase|datanyze|adapt\.io|seamless\.ai|theorg\.com|craft\.co|cbinsights|cleartalent/;
const NEWS = /reuters|bloomberg|techcrunch|forbes|economictimes|livemint|moneycontrol|businesswire|prnewswire|globenewswire|cnbc|wsj\.com|ft\.com|thehindu|business-standard|yourstory|inc42|nytimes|theguardian|bbc\.|apnews|venturebeat|fortune\.com|axios|cnn\.com|businessinsider/;
function sourceKind(url, company) {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return ["Web page", "neutral"]; }
  if (/linkedin\.com$/.test(host)) return ["LinkedIn", "neutral"];
  if (AGG.test(host)) return ["Contact-data site", "warn"];
  if (NEWS.test(host)) return ["News", "ok"];
  const c = String(company || "").toLowerCase().replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|plc|gmbh)\b/g, "").replace(/[^a-z0-9]/g, "");
  if (c.length > 2 && host.replace(/[^a-z0-9]/g, "").includes(c)) return ["Company site", "ok"];
  return ["Web page", "neutral"];
}

/* ====================== state ====================== */

const state = {
  view: "dashboard", prospects: [], filter: "", tile: "all", profile: null, gmail: null, runs: [],
  currentId: null, review: null, tab: "draft", lane: "personalised",
  run: null, events: [], lastEventId: 0, runId: null, pollTimer: null, listTimer: null,
  edit: null, addTab: "person", imp: null,
};

/* One function decides every status shown in the list, so the screen can never contradict itself. */
function getProspectStatus(p) {
  const run = p.latest_run;
  const S = (label, tone, next, action, prio, detail) => ({ label, tone, next, action, prio, detail: detail || "" });
  if (run?.status === "running") return S("Working", "warn", "View progress", "open", 1, "Run in progress");
  if (run?.status === "failed") return S("Run failed", "bad", "Run again", "run", 0, "Something went wrong");
  if (run?.status === "needs_input") return S("Needs your input", "warn", run.needs_input_reason === "choose_persona" ? "Choose persona" : "Fix details", "open", 0, run.needs_input_reason === "choose_persona" ? "Role is outside your target personas" : "Details need correcting");
  if (p.verification_status === "mismatch") return S("Employer mismatch", "bad", "Fix employer", "open", 0, "Works somewhere else");
  if (p.draft_status === "gmail_draft") return S("In Gmail drafts", "ok", "Open in Gmail", "gmail", 9, "Saved, not sent");
  if (p.draft_status === "approved") return S("Approved", "ok", "Create Gmail draft", "open", 3, "Ready to save to Gmail");
  if (p.research_status === "skipped") return S("Person not found", "warn", "Fix details", "open", 1, "Only a generic draft exists");
  if (p.draft_status === "review") return S("Draft ready", p.verification_status === "verified" ? "ok" : "warn", "Review draft", "open", 2,
    p.verification_status === "verified" ? "Employment verified" : "Role not confirmed");
  if (p.research_status === "insufficient_evidence") return S("Thin evidence", "warn", "See options", "open", 2, "No usable signal");
  if (p.draft_status === "rejected") return S("Draft rejected", "neutral", "Regenerate", "open", 4);
  if (p.research_status === "none" && p.verification_status === "none") return S("New", "neutral", "Research and draft", "run", 5, "Not started");
  return S("Needs a check", "warn", "Open", "open", 3);
}

const normRole = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function roleFitsPersonas(role, personas) {
  const r = normRole(role);
  if (!r || !personas?.length) return true;
  return personas.some((p) => { const q = normRole(p); return r.includes(q) || q.includes(r); });
}

/* ====================== session, nav, meters ====================== */

function showApp(on) {
  $("loginBox").classList.toggle("hidden", on);
  $("nav").classList.toggle("hidden", !on);
  $("topRight").classList.toggle("hidden", !on);
  if (!on) for (const v of ["Dashboard", "Runs", "Profile"]) $("view" + v).classList.add("hidden");
}

function setView(v) {
  state.view = v;
  for (const [k, id] of [["dashboard", "viewDashboard"], ["runs", "viewRuns"], ["profile", "viewProfile"]]) $(id).classList.toggle("hidden", k !== v);
  document.querySelectorAll(".navtab").forEach((b) => b.setAttribute("aria-current", b.dataset.view === v ? "page" : "false"));
  if (v === "dashboard") { loadList(); loadRecent(); }
  if (v === "runs") renderRunsView();
  if (v === "profile") renderProfileView();
}
document.querySelectorAll(".navtab").forEach((b) => b.addEventListener("click", () => { closeDrawer(true); setView(b.dataset.view); }));

function meter(label, used, cap, tip) {
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
  return h("div", { class: "meter", title: tip },
    h("div", { class: "row" }, h("span", { text: label }), h("span", { text: `${used}/${cap ?? "?"}` })),
    h("div", { class: "track" }, h("div", { class: "fill " + (pct > 90 ? "bad" : pct > 70 ? "warn" : ""), style: `width:${pct}%` })));
}

async function loadMeters() {
  try {
    const [u, g] = await Promise.all([api("/api/usage"), api("/api/gmail/status")]);
    state.gmail = g;
    $("meters").replaceChildren(
      meter("AI calls today", u.gemini_used, u.gemini_cap, "AI calls used today out of your daily limit"),
      meter("Searches this month", u.search_used_month, u.search_cap_month, "Web searches used this month out of the free allowance"));
    const el = $("gmailStatus");
    el.replaceChildren();
    if (!g.configured) el.textContent = "Gmail not set up";
    else if (!g.connected) el.append(h("a", { href: "/api/gmail/connect", text: "Connect Gmail" }));
    else el.append(`Gmail: ${g.email ?? "connected"} `, h("button", { class: "btn ghost sm", type: "button", onclick: disconnectGmail }, "Disconnect"));
    if (state.review) renderBar();
  } catch { /* meters are optional */ }
}

async function disconnectGmail() {
  if (!confirm("Disconnect Gmail? Drafts already in Gmail stay there.")) return;
  try { await post("/api/gmail/disconnect"); toast("Gmail disconnected.", "good"); loadMeters(); } catch (e) { toast(e.message, "error"); }
}

async function start() {
  try {
    await api("/api/me");
    showApp(true);
    api("/api/profile").then((r) => { state.profile = r.profile; }).catch(() => {});
    loadMeters();
    setView("dashboard");
  } catch { showApp(false); }
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await post("/api/login", { password: $("password").value }); $("password").value = ""; await start(); }
  catch (err) { toast(err.message, "error"); }
});
$("logout").addEventListener("click", async () => {
  stopWatch(); clearTimeout(state.listTimer); closeDrawer(true);
  await post("/api/logout"); state.prospects = []; showApp(false);
});

/* ====================== dashboard ====================== */

async function loadList(highlightId) {
  const { prospects } = await api("/api/prospects");
  state.prospects = prospects;
  renderDashboard(highlightId);
  clearTimeout(state.listTimer);
  if (prospects.some((p) => p.latest_run?.status === "running")) state.listTimer = setTimeout(() => state.view === "dashboard" && loadList().catch(() => {}), 4000);
}

const TILES = [
  ["all", "All prospects", () => true],
  ["attention", "Need attention", (p, s) => s.prio <= 1],
  ["ready", "Ready to review", (p, s) => s.label === "Draft ready" || s.label === "Thin evidence"],
  ["approved", "Approved", (p) => ["approved", "gmail_draft"].includes(p.draft_status)],
  ["new", "Not started", (p, s) => s.label === "New"],
];

function renderDashboard(highlightId) {
  const all = state.prospects.map((p) => ({ p, s: getProspectStatus(p) }));
  $("tiles").replaceChildren(...TILES.map(([k, label, fn]) =>
    h("button", { class: "tile" + (k === "attention" ? " attn" : ""), type: "button", "aria-pressed": String(state.tile === k), onclick: () => { state.tile = k; renderDashboard(); } },
      h("b", { text: all.filter((x) => fn(x.p, x.s)).length }), h("span", { text: label }))));

  const tile = TILES.find((t) => t[0] === state.tile) ?? TILES[0];
  const q = state.filter.trim().toLowerCase();
  const rows = all
    .filter((x) => tile[2](x.p, x.s))
    .filter((x) => !q || [x.p.full_name, x.p.company_claimed, x.p.email].some((v) => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => a.s.prio - b.s.prio || new Date(b.p.created_at) - new Date(a.p.created_at));

  const tbody = $("rows");
  tbody.replaceChildren();
  for (const { p, s } of rows) {
    const off = state.profile && !roleFitsPersonas(p.designation, state.profile.personas);
    const next = s.action === "gmail"
      ? h("a", { class: "btn sm", href: "https://mail.google.com/mail/u/0/#drafts", target: "_blank", rel: "noopener noreferrer", text: s.next })
      : h("button", { class: "btn sm" + (s.prio <= 2 ? " primary" : ""), type: "button", onclick: () => (s.action === "run" ? runFor(p.id) : openDrawer(p.id)) }, s.next);
    tbody.append(h("tr", { class: p.id === highlightId ? "fresh" : "" },
      h("td", {}, h("div", { class: "pname", text: p.full_name }),
        h("div", { class: "prole", text: p.designation || "Role not given" }),
        off ? h("div", {}, chip("Role outside your target personas", "warn")) : null),
      h("td", { text: p.company_claimed }),
      h("td", {}, chip(s.label, s.tone), s.detail ? h("div", { class: "prole", text: s.detail }) : null),
      h("td", {}, next),
      h("td", { class: "muted small", text: fmtShort(p.created_at) }),
      h("td", {}, rowMenu(p))));
  }
  $("count").textContent = state.prospects.length ? `${rows.length} of ${state.prospects.length}` : "";
  const empty = $("empty");
  empty.textContent = state.prospects.length ? "No prospects match this view." : "No prospects yet. Use Add prospect to start, or import a list.";
  empty.classList.toggle("hidden", rows.length > 0);
}

function rowMenu(p) {
  const item = (label, fn, cls) => h("button", { type: "button", class: cls || "", onclick: (e) => { e.target.closest("details").open = false; fn(); } }, label);
  return h("details", { class: "menu" }, h("summary", { class: "btn ghost sm", text: "More" }),
    h("div", { class: "menu-pop" }, item("Open review", () => openDrawer(p.id)), item("Run again", () => runFor(p.id)), item("Remove", () => removeProspect(p), "danger")));
}
document.addEventListener("click", (e) => document.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; }));

$("filter").addEventListener("input", (e) => { state.filter = e.target.value; renderDashboard(); });
$("btnAdd").addEventListener("click", () => openAddDialog("person"));
$("btnImport").addEventListener("click", () => openAddDialog("import"));

async function removeProspect(p) {
  if (!confirm(`Remove ${p.full_name}? Their history is kept, and you can add them again later.`)) return;
  try { await post(`/api/prospects/${p.id}/archive`); toast(`Removed ${p.full_name}.`, "good"); await loadList(); }
  catch (e) { toast(e.message, "error"); }
}

async function runFor(id, trigger, extra) {
  try { await post(`/api/prospects/${id}/run`, { trigger: trigger || "manual", ...(extra || {}) }); await openDrawer(id, true); loadList().catch(() => {}); }
  catch (e) { toast(e.message, "error"); }
}

function runOutcome(r) {
  if (r.status === "running") return chip("Running", "warn");
  if (r.status === "completed") return chip("Finished", "ok");
  if (r.status === "needs_input") return chip("Needs input", "warn");
  if (r.status === "failed") return chip("Failed", "bad");
  return chip("Interrupted", "neutral");
}

async function loadRecent() {
  try {
    const { runs } = await api("/api/runs");
    state.runs = runs;
    const box = $("recentRuns");
    if (!runs.length) { box.replaceChildren(h("p", { class: "muted", text: "No runs yet." })); return; }
    box.replaceChildren(runsTable(runs.slice(0, 5)));
  } catch { /* optional */ }
}

function runsTable(runs) {
  return h("table", { class: "simple" },
    h("thead", {}, h("tr", {}, ["Prospect", "Result", "Started", "Took", "Stages reused"].map((x) => h("th", { text: x })))),
    h("tbody", {}, runs.map((r) => h("tr", {},
      h("td", {}, r.prospect ? h("button", { class: "btn ghost sm", type: "button", onclick: () => openDrawer(r.prospect_id) }, `${r.prospect.full_name}, ${r.prospect.company_claimed}`) : "Removed prospect"),
      h("td", {}, runOutcome(r)),
      h("td", { class: "muted", text: `${fmtShort(r.started_at)} ${fmtTime(r.started_at)}` }),
      h("td", { text: fmtDur(r.duration_ms) }),
      h("td", { text: r.stages ? `${r.reused} of ${r.stages}` : "" })))));
}

async function renderRunsView() {
  const v = $("viewRuns");
  v.replaceChildren(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Runs" }), h("p", { class: "sub", text: "Every research run, newest first. Reused stages are free: nothing is re-searched or re-written if the inputs have not changed." }))), h("div", { class: "card" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
  try {
    const { runs } = await api("/api/runs");
    v.replaceChildren(v.firstChild, h("div", { class: "card flush" }, runs.length ? h("div", { class: "table-wrap" }, runsTable(runs)) : h("div", { class: "empty", text: "No runs yet." })));
  } catch (e) { toast(e.message, "error"); }
}

/* ====================== add dialog (one person, LinkedIn fill, import) ====================== */

function openAddDialog(tab) {
  state.addTab = tab; state.imp = { stage: "choose" };
  renderAdd();
  $("addDlg").showModal();
}

function renderAdd() {
  const dlg = $("addDlg");
  const seg = h("div", { class: "seg" }, [["person", "One person"], ["import", "Import a file"]].map(([k, l]) =>
    h("button", { type: "button", "aria-pressed": String(state.addTab === k), onclick: () => { state.addTab = k; renderAdd(); } }, l)));
  dlg.replaceChildren(
    h("div", { class: "dlg-head" }, h("h2", { text: state.addTab === "person" ? "Add a prospect" : "Import a list" }), h("button", { class: "btn ghost sm", type: "button", onclick: () => dlg.close() }, "Close")),
    seg, state.addTab === "person" ? personForm() : importPane());
}

function personForm() {
  const f = {
    linkedin: h("input", { type: "url", placeholder: "https://www.linkedin.com/in/...", "aria-label": "LinkedIn profile link" }),
    name: h("input", { type: "text", required: true }),
    company: h("input", { type: "text", required: true }),
    role: h("input", { type: "text", placeholder: "For example, VP Finance" }),
    email: h("input", { type: "email" }),
  };
  const note = h("div", { class: "note hidden", role: "status" });
  const lookupBtn = h("button", { class: "btn", type: "button" }, "Fill in from LinkedIn");

  async function lookup() {
    const url = f.linkedin.value.trim();
    if (!url) { toast("Paste a LinkedIn profile link first.", "error"); return; }
    lookupBtn.disabled = true; lookupBtn.textContent = "Looking up...";
    note.className = "note hidden";
    try {
      const r = await post("/api/linkedin/lookup", { url });
      f.linkedin.value = r.linkedin_url;
      if (r.name) f.name.value = r.name;
      if (r.company) f.company.value = r.company;
      if (r.role) f.role.value = r.role;
      const missing = [!r.company && "company", !r.role && "role"].filter(Boolean);
      note.className = "note " + (missing.length ? "warn" : "ok");
      note.replaceChildren(`Found ${r.name}${r.role ? `, ${r.role}` : ""}${r.company ? ` at ${r.company}` : ""}. `,
        missing.length ? `Please fill in the ${missing.join(" and ")}. ` : "", "This comes from a public search result, so check it. The employment check verifies it later. ",
        safeUrl(r.source?.url) ? h("a", { href: safeUrl(r.source.url), target: "_blank", rel: "noopener noreferrer", text: "See the result" }) : null);
    } catch (e) {
      note.className = "note bad";
      note.textContent = e.message;
    } finally { lookupBtn.disabled = false; lookupBtn.textContent = "Fill in from LinkedIn"; }
  }
  lookupBtn.addEventListener("click", lookup);
  f.linkedin.addEventListener("change", () => { if (/linkedin\.com\/in\//i.test(f.linkedin.value) && !f.name.value && !f.company.value) lookup(); });

  async function submit(andRun) {
    const body = { full_name: f.name.value.trim(), company: f.company.value.trim(), designation: f.role.value.trim(), email: f.email.value.trim(), linkedin_url: f.linkedin.value.trim() };
    for (const k of Object.keys(body)) if (!body[k]) delete body[k];
    try {
      const { prospect } = await post("/api/prospects", body);
      $("addDlg").close();
      toast(`Added ${prospect.full_name}.`, "good");
      state.tile = "all";
      await loadList(prospect.id);
      if (andRun) runFor(prospect.id);
    } catch (e) { toast(e.message, "error"); }
  }
  const field = (label, input, hint) => h("div", { class: "field" }, h("label", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null);
  return h("form", { onsubmit: (e) => { e.preventDefault(); submit(false); } },
    h("div", { class: "field" }, h("label", { text: "LinkedIn link (optional)" }), h("div", { class: "inline-field" }, f.linkedin, lookupBtn),
      h("span", { class: "hint", text: "Paste a profile link to fill in the name, role and company." })),
    note,
    h("div", { class: "row2", style: "margin-top:14px" }, field("Full name", f.name), field("Company", f.company)),
    h("div", { class: "row2" }, field("Role", f.role), field("Email", f.email)),
    h("div", { class: "head-actions" }, h("button", { class: "btn", type: "submit" }, "Add prospect"),
      h("button", { class: "btn primary", type: "button", onclick: () => { if (!f.name.value.trim() || !f.company.value.trim()) { toast("Name and company are needed.", "error"); return; } submit(true); } }, "Add and research")));
}

/* ----- import (CSV and Excel) ----- */

const ALIASES = {
  full_name: ["fullname", "name", "contactname", "prospect", "prospectname", "person"], first: ["firstname", "givenname"], last: ["lastname", "surname", "familyname"],
  company: ["company", "companyname", "organization", "organisation", "account", "accountname", "employer"],
  designation: ["designation", "title", "jobtitle", "role", "position"], email: ["email", "emailaddress", "workemail", "mail"],
  linkedin_url: ["linkedin", "linkedinurl", "linkedinprofile", "profileurl"],
};
const normHeader = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.trim() !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const heads = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(heads.map((hd, i) => [hd, r[i] ?? ""])));
}

async function readRecords(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) return parseCsv(await file.text());
  if (!name.endsWith(".xlsx") && !name.endsWith(".xls")) throw new Error("Choose a .csv, .xlsx or .xls file.");
  if (!window.XLSX) throw new Error("The Excel reader did not load. Check your internet connection, or save the sheet as CSV.");
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
  return window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
}

function mapColumns(records) {
  if (!records.length) return { rows: [], found: [], missing: ["name", "company"] };
  const heads = Object.keys(records[0]);
  const pick = (key) => heads.find((hd) => ALIASES[key].includes(normHeader(hd)));
  const cols = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, pick(k)]));
  const missing = [];
  if (!(cols.full_name || cols.first)) missing.push("name");
  if (!cols.company) missing.push("company");
  const rows = records.map((r) => ({
    full_name: cols.full_name ? r[cols.full_name] : [cols.first && r[cols.first], cols.last && r[cols.last]].filter(Boolean).join(" "),
    company: cols.company ? r[cols.company] : "", designation: cols.designation ? r[cols.designation] : "",
    email: cols.email ? r[cols.email] : "", linkedin_url: cols.linkedin_url ? r[cols.linkedin_url] : "",
  })).filter((r) => Object.values(r).some((v) => String(v).trim() !== ""));
  return { rows, found: Object.entries(cols).filter(([, v]) => v).map(([k, v]) => `${v} (as ${k.replace("_", " ")})`), missing };
}

function importPane() {
  const s = state.imp;
  const box = h("div");
  if (s.stage === "choose") {
    const input = h("input", { type: "file", accept: ".csv,.xlsx,.xls,.txt", "aria-label": "Choose a file" });
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      try { s.file = file; s.error = null; s.parsed = mapColumns(await readRecords(file)); s.stage = "preview"; } catch (e) { s.error = e.message; }
      renderAdd();
    });
    box.append(h("label", { class: "drop" }, h("strong", { text: "Choose a CSV or Excel file" }), h("div", { class: "muted small", text: "The first row must be column headings. The first sheet is used." }), input),
      h("p", { class: "hint muted small", style: "margin-top:10px" }, "It needs a name column and a company column. Role, email and LinkedIn link are optional. ", h("a", { href: "/api/imports/template", download: "prospects-template.csv", text: "Download a template" }), "."),
      s.error ? h("p", { class: "problems", text: s.error }) : null);
  }
  if (s.stage === "preview") {
    const { rows, found, missing } = s.parsed;
    box.append(h("p", {}, h("strong", { text: `${rows.length} row${rows.length === 1 ? "" : "s"}` }), ` found in ${s.file.name}.`),
      found.length ? h("p", { class: "muted small", text: "Columns used: " + found.join(", ") + "." }) : null,
      missing.length ? h("p", { class: "problems", text: `Could not find a ${missing.join(" or ")} column. Rename the heading to match the template.` }) : null,
      rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "simple" }, h("thead", {}, h("tr", {}, ["Name", "Company", "Role", "Email"].map((x) => h("th", { text: x })))),
        h("tbody", {}, rows.slice(0, 5).map((r) => h("tr", {}, h("td", { text: r.full_name }), h("td", { text: r.company }), h("td", { text: r.designation }), h("td", { text: r.email })))))) : null,
      rows.length > 5 ? h("p", { class: "muted small", text: `Showing the first 5 of ${rows.length}.` }) : null);
    const go = h("button", { class: "btn primary", type: "button", disabled: missing.length > 0 || !rows.length }, `Import ${rows.length} prospect${rows.length === 1 ? "" : "s"}`);
    go.addEventListener("click", async () => {
      go.disabled = true; go.textContent = "Importing...";
      try {
        const total = { accepted: 0, duplicates: 0, invalid: 0 };
        const report = [];
        for (let i = 0; i < rows.length; i += 300) {
          const r = await post("/api/imports", { filename: s.file.name, rows: rows.slice(i, i + 300) });
          for (const k of Object.keys(total)) total[k] += r.import[k];
          report.push(...r.report.map((x) => ({ ...x, row: x.row + i })));
        }
        s.result = { total, report }; s.stage = "done";
        await loadList();
      } catch (e) { s.error = e.message; s.stage = "preview"; }
      renderAdd();
    });
    box.append(h("div", { class: "head-actions", style: "margin-top:14px" }, go, h("button", { class: "btn ghost", type: "button", onclick: () => { state.imp = { stage: "choose" }; renderAdd(); } }, "Choose a different file")),
      s.error ? h("p", { class: "problems", text: s.error }) : null);
  }
  if (s.stage === "done") {
    const { total, report } = s.result;
    const problems = report.filter((r) => r.status !== "accepted");
    box.append(h("p", {}, chip(`${total.accepted} added`, "ok"), " ", chip(`${total.duplicates} duplicates skipped`, total.duplicates ? "warn" : "neutral"), " ", chip(`${total.invalid} invalid`, total.invalid ? "bad" : "neutral")),
      problems.length ? h("div", { class: "report table-wrap" }, h("table", { class: "simple" }, h("thead", {}, h("tr", {}, ["Row", "Name", "Result", "Why"].map((x) => h("th", { text: x })))),
        h("tbody", {}, problems.map((r) => h("tr", {}, h("td", { text: r.row }), h("td", { text: r.name }), h("td", {}, chip(r.status === "duplicate" ? "Duplicate" : "Invalid", r.status === "duplicate" ? "warn" : "bad")), h("td", { text: r.reason })))))) : h("p", { class: "muted", text: "Every row was added." }),
      h("div", { class: "head-actions", style: "margin-top:14px" }, h("button", { class: "btn primary", type: "button", onclick: () => $("addDlg").close() }, "Done")));
  }
  return box;
}

/* ====================== seller profile ====================== */

async function renderProfileView() {
  const v = $("viewProfile");
  v.replaceChildren(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Seller profile" }), h("p", { class: "sub", text: "Who the emails are written for. Every draft uses this profile plus one fact found about the prospect's company." }))),
    h("div", { class: "card" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
  let profile, pre;
  try { [{ profile }, pre] = await Promise.all([api("/api/profile"), api("/api/preflight")]); } catch (e) { toast(e.message, "error"); return; }
  state.profile = profile;

  const ta = (val, rows) => h("textarea", { rows: String(rows || 4), value: val.join("\n") });
  const f = {
    company_name: h("input", { type: "text", value: profile.company_name, placeholder: "For example, Acme Payables" }),
    signature_name: h("input", { type: "text", value: profile.signature_name, placeholder: "Your name" }),
    signature_title: h("input", { type: "text", value: profile.signature_title, placeholder: "Your title" }),
    category: h("input", { type: "text", value: profile.category }),
    capabilities: ta(profile.capabilities, 4), value_props: ta(profile.value_props, 3), personas: ta(profile.personas, 5),
    approved_claims: ta(profile.approved_claims, 7), banned_claims: ta(profile.banned_claims, 3), tone_style: h("input", { type: "text", value: profile.tone_style }),
  };
  const field = (label, input, hint) => h("div", { class: "field" }, h("label", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null);
  const save = h("button", { class: "btn primary", type: "submit" }, "Save profile");
  const form = h("form", { class: "card", onsubmit: async (e) => {
    e.preventDefault(); save.disabled = true;
    try {
      const body = { company_name: f.company_name.value, signature_name: f.signature_name.value, signature_title: f.signature_title.value, category: f.category.value,
        capabilities: lines(f.capabilities.value), value_props: lines(f.value_props.value), personas: lines(f.personas.value),
        approved_claims: lines(f.approved_claims.value), banned_claims: lines(f.banned_claims.value), tone_style: f.tone_style.value };
      const r = await put("/api/profile", body);
      toast(r.unchanged ? "No changes to save." : `Saved as version ${r.version}. Existing drafts update the next time you run them.`, "good");
      api("/api/profile").then((x) => { state.profile = x.profile; }).catch(() => {});
    } catch (err) { toast(err.message, "error"); } finally { save.disabled = false; }
  } },
    h("h2", { text: "About your company" }),
    h("div", { class: "row2" }, field("Company name", f.company_name, "Used in every email and in the signature."), field("What you sell", f.category, "One short phrase.")),
    h("div", { class: "row2" }, field("Sender name", f.signature_name, "Added under \"Best,\" in each draft."), field("Sender title", f.signature_title)),
    field("Capabilities (one per line)", f.capabilities),
    field("Value propositions (one per line)", f.value_props),
    h("h2", { text: "Rules for the writer", style: "margin-top:8px" }),
    field("Target personas (one per line)", f.personas, "Roles you sell to. A role outside this list is flagged, and never silently treated as one of them."),
    field("Approved claims (one per line)", f.approved_claims, "The only statements a draft may make about your product. Anything else is flagged by the fact-check."),
    field("Banned phrases (one per line)", f.banned_claims, "Never allowed in a draft."),
    field("Tone", f.tone_style),
    h("div", { class: "head-actions" }, save));

  const row = (label, p, detail) => h("li", {}, h("div", {}, h("strong", { text: label }), h("div", { class: "muted small", text: detail })), chip(p.ok ? "OK" : "Needs attention", p.ok ? "ok" : "warn"));
  const check = h("div", { class: "card" }, h("h2", { text: "System check" }), h("ul", { class: "checklist" },
    row("Database", pre.database, pre.database.message),
    row("Seller profile", pre.profile, pre.profile.message),
    row("AI writer", pre.gemini, pre.gemini.ok ? `${pre.gemini.model}, ${pre.gemini.used} of ${pre.gemini.cap} calls used today` : "GEMINI_API_KEY is missing in .env"),
    row("Web search", pre.search, pre.search.ok ? `${pre.search.used} of ${pre.search.cap} searches used this month` : "TAVILY_API_KEY is missing in .env"),
    row("Gmail", pre.gmail, pre.gmail.connected ? `Connected as ${pre.gmail.email ?? "your account"}` : pre.gmail.configured ? "Not connected yet. Use Connect Gmail at the top." : "Google values are missing in .env")));
  v.replaceChildren(v.firstChild, form, check);
}

/* ====================== review drawer ====================== */

function stopWatch() { clearTimeout(state.pollTimer); state.pollTimer = null; }

function closeDrawer(silent) {
  stopWatch();
  const was = state.currentId;
  state.currentId = null; state.review = null; state.edit = null;
  $("drawer").classList.add("hidden"); $("backdrop").classList.add("hidden");
  if (was && !silent) { loadList().catch(() => {}); loadRecent(); }
}
$("backdrop").addEventListener("click", () => closeDrawer());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.currentId && !document.querySelector("dialog[open]")) closeDrawer(); });

async function openDrawer(id, fresh) {
  stopWatch();
  Object.assign(state, { currentId: id, tab: "draft", lane: "personalised", edit: null, events: [], lastEventId: 0, runId: null, run: null, review: null });
  $("drawer").classList.remove("hidden"); $("backdrop").classList.remove("hidden");
  $("dHead").replaceChildren(h("div", {}, h("div", { class: "skeleton", style: "width:220px" })));
  $("dScroll").replaceChildren(h("div", { class: "card" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
  $("actionbar").replaceChildren();
  await refreshReview(fresh);
}

async function refreshReview() {
  if (!state.currentId) return;
  try {
    const rv = await api(`/api/prospects/${state.currentId}/review`);
    state.review = rv;
    const last = rv.last_run;
    if (last && last.id !== state.runId) { state.runId = last.id; state.run = last; state.events = []; state.lastEventId = 0; await pullEvents(); }
    if (rv.running && !state.pollTimer) watchRun(last.id);
    renderDrawer();
  } catch (e) { toast(e.message, "error"); if (e.status === 404) closeDrawer(); }
}

async function pullEvents() {
  const d = await api(`/api/runs/${state.runId}?after=${state.lastEventId}`);
  for (const e of d.events) { state.events.push(e); state.lastEventId = e.id; }
  state.run = d.run;
  return d;
}

function watchRun(runId) {
  stopWatch();
  const tick = async () => {
    try {
      if (state.runId !== runId) { state.runId = runId; state.events = []; state.lastEventId = 0; }
      const d = await pullEvents();
      if (d.run.status === "running" && !d.run.stale) { renderDrawer(); state.pollTimer = setTimeout(tick, 1500); return; }
      state.pollTimer = null;
      await refreshReview(); loadList().catch(() => {}); loadMeters(); loadRecent();
      if (d.run.status === "failed") toast("The run failed: " + (d.run.error?.message ?? "unknown error"), "error");
      else if (d.run.status === "needs_input") toast("The run stopped and needs your input.", "error");
      else if (d.run.status === "completed") toast("The run finished.", "good");
    } catch { state.pollTimer = setTimeout(tick, 3000); }
  };
  state.pollTimer = setTimeout(tick, 200);
}

async function runAction(trigger, extra) {
  try {
    const { run } = await post(`/api/prospects/${state.currentId}/run`, { trigger, ...(extra || {}) });
    state.runId = run.id; state.events = []; state.lastEventId = 0; state.tab = "draft";
    toast(trigger === "regenerate" ? "Regenerating the draft..." : trigger === "reverify" ? "Re-checking employment..." : "Run started.", "good");
    await refreshReview(); loadList().catch(() => {});
  } catch (e) { toast(e.message, "error"); }
}

async function act(btn, fn, okText) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Working..."; }
  try { await fn(); if (okText) toast(okText, "good"); }
  catch (e) { toast(e.message + (e.data?.error?.reasons ? " " + e.data.error.reasons.map((r) => r.message).join(" ") : ""), "error"); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    await refreshReview(); loadList().catch(() => {}); loadMeters();
  }
}

/* ----- stage model for the live run view ----- */

function stageModel(events) {
  const m = {};
  for (const e of events) {
    const k = e.stage ? e.stage.split(":")[0] : null;
    if (e.type === "research_skipped") for (const x of ["research", "extract", "score"]) m[x] = { s: "skipped", msg: "Skipped: person not identified" };
    if (e.type === "draft_blocked") m.draft = { s: "blocked", msg: "No personalised draft: not enough evidence" };
    if (!k) continue;
    m[k] ??= {};
    if (e.type === "stage_started") { m[k] = { ...m[k], start: e.created_at, s: "working" }; }
    else if (e.type === "stage_finished") {
      const o = String(e.payload?.outcome ?? "");
      m[k] = { ...m[k], end: e.created_at, msg: e.message, s: o.startsWith("skipped") ? "reused" : o.startsWith("refreshed") ? "refreshed" : "done" };
    } else if (e.type === "stage_failed") m[k] = { ...m[k], end: e.created_at, msg: e.message, s: "failed" };
  }
  return m;
}
const STEP_TEXT = { waiting: "Waiting", working: "Running", done: "Done", reused: "Reused", refreshed: "Refreshed", failed: "Failed", blocked: "Blocked", skipped: "Skipped" };

function stepper(rv, running) {
  const run = state.run ?? rv.last_run;
  const m = stageModel(state.events);
  const ol = h("ol", { class: "stepper" });
  STAGES.forEach(([k, label], i) => {
    const s = m[k] ?? { s: "waiting" };
    const dur = s.start && s.end ? fmtDur(new Date(s.end) - new Date(s.start)) : "";
    const icon = s.s === "working" ? h("span", { class: "spin" }) : s.s === "done" || s.s === "reused" || s.s === "refreshed" ? "\u2713" : s.s === "failed" || s.s === "blocked" ? "!" : String(i + 1);
    ol.append(h("li", { class: "step " + s.s },
      h("span", { class: "dot" }, icon), h("span", { class: "name", text: label }),
      h("span", { class: "meta" }, chip(STEP_TEXT[s.s] ?? s.s, { done: "ok", reused: "neutral", refreshed: "neutral", working: "warn", failed: "bad", blocked: "bad" }[s.s] ?? "neutral"), dur ? ` ${dur}` : ""),
      s.msg && s.s !== "working" ? h("span", { class: "msg", text: s.msg }) : null));
  });
  if (!running && run) {
    const text = run.status === "completed" ? (rv.lanes.personalised || rv.lanes.fallback ? "Draft ready for review" : "Finished: no draft was written")
      : run.status === "needs_input" ? "Needs your input" : run.status === "failed" ? "Stopped: " + (run.error?.message ?? "something went wrong") : "Interrupted";
    ol.append(h("li", { class: "step " + (run.status === "completed" ? "done" : run.status === "failed" ? "failed" : "blocked") },
      h("span", { class: "dot" }, run.status === "completed" ? "\u2713" : "!"), h("span", { class: "name", text: "Outcome" }), h("span", { class: "meta" }), h("span", { class: "msg", text })));
  }
  return ol;
}

function runPanel(rv) {
  const run = state.run ?? rv.last_run;
  const running = rv.running || run?.status === "running";
  if (!run) return h("div", { class: "card" }, h("h3", { text: "Not researched yet" }), h("p", { class: "muted", text: "Nothing has been run for this person." }), h("button", { class: "btn primary", type: "button", onclick: () => runAction("manual") }, "Research and draft"));
  const model = stageModel(state.events);
  const reused = Object.values(model).filter((x) => x.s === "reused").length;
  const done = Object.values(model).filter((x) => ["done", "reused", "refreshed"].includes(x.s)).length;
  if (running) {
    return h("div", { class: "card" }, h("div", { class: "dlg-head" }, h("h3", { text: run.stale ? "This run seems to have stopped" : "Working on it", style: "margin:0" }), chip("Running", "warn")),
      run.stale ? h("p", { class: "muted" }, "No progress for a while. ", h("button", { class: "btn sm", type: "button", onclick: () => runAction("manual") }, "Run again")) : null, stepper(rv, true));
  }
  const label = { completed: "Last run finished", needs_input: "Last run needs your input", failed: "Last run failed", interrupted: "Last run was interrupted" }[run.status];
  return h("div", { class: "card" }, h("div", { class: "dlg-head" }, h("div", {}, h("strong", { text: label + " " }), chip(`${reused} of ${done} stages reused`, "neutral"), h("span", { class: "muted small", text: `  ${fmtShort(run.started_at)} ${fmtTime(run.started_at)}` })),
    h("div", { class: "head-actions" }, h("button", { class: "btn sm", type: "button", onclick: () => runAction("manual") }, "Run again"), h("button", { class: "btn sm", type: "button", onclick: () => runAction("reverify") }, "Re-check employment"))),
    h("details", {}, h("summary", { text: "Show the steps" }), stepper(rv, false)));
}

/* ----- verdict, rail, tabs ----- */

function verdictModel(rv, L) {
  const run = state.run ?? rv.last_run;
  if (rv.running) return { tone: "warn", title: "Working on it", why: "The run is in progress. This page updates by itself.", next: "Wait for it to finish." };
  if (!L) {
    if (run?.status === "needs_input") {
      const persona = run.needs_input_reason === "choose_persona";
      return { tone: "warn", title: "Needs your input", why: persona ? "This person's role does not match any of your target personas." : "The employment check found a mismatch.",
        next: persona ? "Choose a persona for a generic draft below, or correct the role with Edit details." : "Correct the details with Edit details, then run again." };
    }
    if (run?.status === "failed") return { tone: "bad", title: "The last run failed", why: run.error?.message ?? "Something went wrong.", next: "Press Run again. Finished steps are reused, so it picks up where it stopped." };
    if (rv.hook?.signal_strength === "insufficient") return { tone: "warn", title: "Not enough evidence for a personalised draft", why: "No dated, relevant signal about the company was found.", next: "Write a generic draft below, or check the Evidence tab." };
    return { tone: "neutral", title: "No draft yet", why: "Nothing has been written for this person.", next: "Press Research and draft." };
  }
  const d = L.latest, g = L.gate;
  if (d.status === "gmail_draft") return { tone: "ok", title: "Saved to Gmail", why: "It is in your Drafts folder. Nothing has been sent.", next: "Open Gmail to review and send it yourself." };
  if (d.status === "approved") return { tone: "ok", title: "Approved", why: "You approved this version.", next: "Create the Gmail draft with the button at the bottom." };
  if (d.status === "rejected") return { tone: "neutral", title: "Rejected", why: d.rejection_reason || "You rejected this version.", next: "Press Regenerate for a new version." };
  if (g.allowed) return { tone: "ok", title: "Ready to approve", why: "The person is matched, every sentence is backed by evidence, and the writing rules pass.", next: "Read it once, then press Approve." };
  const first = g.reasons[0];
  const next = first.code === "employment_unconfirmed"
    ? (rv.can_confirm_employment ? "Confirm how you verified their role (right panel), or correct the details." : "Correct the details with Edit details, then run again.")
    : NEXT_HELP[first.code] ?? "Fix the issue described above.";
  return { tone: "warn", title: "Not ready to approve yet", why: first.message + (g.reasons.length > 1 ? ` (${g.reasons.length - 1} more issue${g.reasons.length > 2 ? "s" : ""})` : ""), next };
}

function verdictCard(rv, L) {
  const v = verdictModel(rv, L);
  return h("div", { class: "card verdict " + v.tone }, h("div", { class: "t", text: v.title }),
    h("div", { class: "kv" }, h("span", { text: "Why" }), h("span", { text: v.why }), h("span", { text: "Next" }), h("span", { text: v.next })));
}

function personCard(rv) {
  const v = rv.verification, e = rv.employment;
  const status = !v ? ["Not checked", "neutral"] : e.expired ? ["Expired", "warn"] : { verified: ["Verified", "ok"], uncertain: ["Needs a check", "warn"], mismatch: ["Mismatch", "bad"], failed: ["Failed", "bad"] }[v.status];
  const m = v?.evidence?.matched;
  const card = h("div", { class: "card" }, h("div", { class: "label", text: "THE PERSON" }), h("div", {}, chip(status[0], status[1]), " ", chip(e.identity_state === "established" ? "Person matched" : "Not matched", e.identity_state === "established" ? "ok" : "neutral")));
  if (m) card.append(h("div", { class: "small", style: "margin-top:8px", text: `${m.role ?? "Role unknown"} at ${m.employer}${m.evidence_date ? `, source dated ${m.evidence_date}` : ", source has no date"}` }));
  else if (v) card.append(h("div", { class: "small muted", style: "margin-top:8px", text: v.evidence?.summary ?? "" }));
  if (rv.can_confirm_employment) card.append(confirmForm());
  return card;
}

function confirmForm() {
  const note = h("input", { type: "text", placeholder: "How did you confirm it?", "aria-label": "Confirmation note" });
  const btn = h("button", { class: "btn sm", type: "button" }, "Confirm employment");
  btn.addEventListener("click", () => act(btn, () => post(`/api/prospects/${state.currentId}/confirm-employment`, { note: note.value }), "Employment confirmed. Run again to personalise the draft."));
  return h("div", { style: "margin-top:10px; display:grid; gap:6px" }, h("span", { class: "small muted", text: "Identified, but the evidence is not enough to verify. If you checked it yourself, record how." }), note, btn);
}

function hookCard(rv) {
  const hk = rv.hook;
  const card = h("div", { class: "card" }, h("div", { class: "label", text: "THE HOOK" }));
  if (!hk) return card.append(h("div", { class: "small muted", text: "No hook chosen yet." })) || card;
  const chosen = hk.scored_signals.find((s) => s.outcome === "chosen");
  const tone = { strong: "ok", moderate: "warn", insufficient: "bad" }[hk.signal_strength];
  card.append(h("div", {}, chip(hk.signal_strength === "insufficient" ? "Not enough evidence" : `${hk.signal_strength[0].toUpperCase()}${hk.signal_strength.slice(1)} match`, tone)));
  if (chosen) card.append(h("div", { class: "small", style: "margin-top:8px", text: chosen.claim }), h("div", { class: "small muted", text: `${TYPES[chosen.signal_type] ?? chosen.signal_type}, ${chosen.event_date ?? "no date"}` }));
  if (hk.persona_unassessed && hk.signal_strength === "moderate") card.append(h("div", { class: "small muted", style: "margin-top:6px", text: "Capped at moderate because the person's role is not confirmed." }));
  return card;
}

function checkCard(rv, L) {
  const card = h("div", { class: "card" }, h("div", { class: "label", text: "FACT-CHECK" }));
  if (!L) return card.append(h("div", { class: "small muted", text: "Nothing to check yet." })) || card;
  const g = L.grounding;
  if (!g) return card.append(h("div", { class: "small muted", text: "Not checked yet." })) || card;
  const stale = L.gate.stale;
  const bad = g.rule_results.filter((r) => !r.ok).length;
  card.append(h("div", {}, stale ? chip("Out of date", "neutral") : chip(g.result === "passed" ? "Passed" : "Failed", g.result === "passed" ? "ok" : "bad")),
    h("div", { class: "small muted", style: "margin-top:6px", text: stale ? "The evidence changed after this check. Press Check again or Regenerate." : g.result === "passed" ? "Every sentence is backed by a source or your approved claims." : `${bad} sentence${bad === 1 ? "" : "s"} flagged. See the Draft tab.` }));
  return card;
}

function toneCard(rv, L) {
  if (!rv.hook?.tone_constraints?.tone_review) return null;
  const card = h("div", { class: "card" }, h("div", { class: "label", text: "TONE NOTE" }),
    h("div", { class: "small", text: `The chosen signal touches a sensitive topic (${rv.hook.tone_constraints.category.replace("_", " ")}). The draft is written neutrally, with no congratulations or guesses.` }));
  if (L?.latest.requires_tone_ack) {
    if (L.latest.tone_ack_at) card.append(h("div", { style: "margin-top:8px" }, chip("Acknowledged", "ok")));
    else { const b = h("button", { class: "btn sm", type: "button", style: "margin-top:8px" }, "Acknowledge tone review"); b.addEventListener("click", () => act(b, () => post(`/api/drafts/${L.latest.id}/ack-tone`), "Tone review acknowledged.")); card.append(b); }
  }
  return card;
}

function basisCard(rv, L) {
  const p = rv.profile;
  const chosen = rv.hook?.scored_signals.find((s) => s.outcome === "chosen");
  const sig = chosen && rv.signals.find((s) => s.id === chosen.signal_id);
  const d = h("details", { class: "card" }, h("summary", { text: "How this draft was made" }));
  const dl = h("dl", { class: "facts" });
  const row = (k, v) => dl.append(h("dt", { text: k }), h("dd", {}, v));
  row("Written for", p.company_name ? `${p.company_name}, which sells ${p.category ?? "your product"}` : "Your company name is not set. Add it in Seller profile.");
  row("About the prospect's company", L?.latest.lane === "fallback" ? "Nothing. A generic draft makes no claims about the company." : sig ? `${sig.claim}${sig.event_date ? ` (${sig.event_date})` : ""}` : "No signal chosen.");
  row("About your product", p.approved_claims.length ? `${p.approved_claims.length} approved claims, such as "${p.approved_claims[0]}"` : "No approved claims.");
  row("About the person", rv.employment.person_specific ? "Role confirmed, so it may refer to them directly." : "Role not confirmed, so it only talks about the company.");
  row("Sign-off", p.signature?.name ? `${p.signature.name}${p.signature.title ? `, ${p.signature.title}` : ""}` : "No sender name set.");
  d.append(dl);
  return d;
}

function rail(rv, L) { return h("div", { class: "rail" }, personCard(rv), hookCard(rv), checkCard(rv, L), toneCard(rv, L), basisCard(rv, L)); }

/* ----- draft tab ----- */

const isDirty = (L) => !!state.edit && state.edit.draftId === L.latest.id && (state.edit.subject !== L.latest.subject || state.edit.body !== L.latest.body);

function fallbackCard(rv) {
  const sel = h("select", { "aria-label": "Persona" }, rv.profile.personas.map((x) => h("option", { value: x, text: x })));
  const btn = h("button", { class: "btn", type: "button" }, "Write a generic draft");
  btn.addEventListener("click", () => runAction("fallback", { persona: sel.value }));
  return h("div", { class: "card" }, h("h3", { text: "Generic draft" }),
    h("p", { class: "muted small", text: "Use this when there is not enough evidence for a personalised draft. It makes no claims about the company and is labelled generic." }),
    h("div", { class: "inline-field" }, sel, btn));
}

function draftTab(rv, L) {
  const box = h("div", { class: "main" });
  const have = ["personalised", "fallback"].filter((l) => rv.lanes[l]);
  if (!have.length) return h("div", { class: "main" }, fallbackCard(rv));
  if (have.length > 1) box.append(h("div", { class: "seg" }, have.map((l) => h("button", { type: "button", "aria-pressed": String(state.lane === l), onclick: () => { state.lane = l; state.edit = null; renderDrawer(); } }, l === "personalised" ? "Personalised draft" : "Generic draft"))));
  const d = L.latest;
  if (!state.edit || state.edit.draftId !== d.id) state.edit = { draftId: d.id, subject: d.subject, body: d.body };
  const subject = h("input", { type: "text", value: state.edit.subject, "aria-label": "Subject" });
  const body = h("textarea", { rows: "13", "aria-label": "Email body" });
  body.value = state.edit.body;
  const counter = h("div", { class: "counter" });
  const upd = () => { const n = words(body.value); counter.textContent = `${n} words (the limit is ${WORD_CAP}, not counting the sign-off)`; counter.className = "counter" + (n - 8 > WORD_CAP ? " over" : ""); };
  const onInput = () => { state.edit.subject = subject.value; state.edit.body = body.value; upd(); renderBar(); };
  subject.addEventListener("input", onInput); body.addEventListener("input", onInput); upd();

  box.append(h("div", { class: "chips", style: "margin:0" }, chip(`Version ${d.version}`, "neutral"), chip(ORIGINS[d.origin] ?? d.origin, "neutral"),
    L.gate.stale ? chip("Out of date", "warn") : null, d.is_generic_fallback ? chip("Generic", "neutral") : null),
    h("div", { class: "card editor" }, h("div", { class: "field", style: "margin:0" }, h("label", { text: "Subject" }), subject), h("div", { class: "field", style: "margin:0" }, h("label", { text: "Email" }), body, counter),
      d.constraint_failed ? h("ul", { class: "problems" }, (d.constraint_violations || []).map((v) => h("li", { text: v }))) : null),
    sentencePanel(rv, L));
  if (L.gate.reasons.length && d.status === "review") box.append(reasonsCard(rv, L));
  if (state.lane === "personalised") box.append(fallbackCard(rv));
  box.append(h("p", { class: "muted small", text: "Versions: " + L.versions.map((v) => `v${v.version} ${(ORIGINS[v.origin] ?? v.origin).toLowerCase()} (${v.status})`).join(", ") }));
  return box;
}

function reasonsCard(rv, L) {
  const d = L.latest;
  const btn = (label, fn) => { const b = h("button", { class: "btn sm", type: "button" }, label); b.addEventListener("click", () => act(b, fn)); return b; };
  const action = (code) => {
    if (["employment_pending", "employment_failed", "employment_expired", "employment_changed", "stale_verification"].includes(code)) return btn("Re-check employment", () => runAction("reverify"));
    if (["stale_hook", "stale_person_specific", "stale_claims", "signal_invalid"].includes(code)) return btn("Regenerate", () => runAction("regenerate"));
    if (["no_grounding", "grounding_stale"].includes(code)) return btn("Check again", () => post(`/api/drafts/${d.id}/recheck`));
    return null;
  };
  return h("div", { class: "card" }, h("h3", { text: "What is stopping approval" }), h("ul", { class: "checklist" }, L.gate.reasons.map((r) =>
    h("li", {}, h("span", { text: r.message }), action(r.code)))), ...L.gate.notices.map((n) => h("p", { class: "muted small", text: n })));
}

function sentencePanel(rv, L) {
  const g = L.grounding;
  const card = h("div", { class: "card" }, h("h3", { text: "Sentence by sentence" }));
  if (!g) { card.append(h("p", { class: "muted", text: "This version has not been fact-checked yet." })); return card; }
  const quiet = g.rule_results.filter((r, i) => g.items[i]?.kind !== "claim" && r.ok);
  const ul = h("ul", { class: "sentences" });
  g.rule_results.forEach((r, i) => {
    const it = g.items[i] || {};
    if (it.kind !== "claim" && r.ok) return;
    const label = it.kind === "claim" ? (CLAIM_LABELS[it.claim_type] ?? "Claim") : it.kind === "greeting" ? "Greeting" : it.kind === "closing" ? "Sign-off" : "Question";
    ul.append(h("li", { class: r.ok ? "" : "bad" }, h("div", { class: "kind", text: label.toUpperCase() }), h("div", { text: r.text_span }),
      h("div", { class: "why", text: r.ok ? (it.supporting_quote ? `Backed by: "${it.supporting_quote}"` : it.hedged ? "Worded as a possibility, not a fact" : "") : r.message })));
  });
  card.append(ul);
  if (quiet.length) card.append(h("p", { class: "muted small", style: "margin-top:8px", text: `Greeting, question and sign-off checked (${quiet.length}).` }));
  return card;
}

/* ----- evidence tab ----- */

function evidenceTab(rv) {
  const box = h("div", { class: "main" });
  const v = rv.verification, ev = v?.evidence;
  const emp = h("div", { class: "card" }, h("h3", { text: "Employment check" }));
  if (!v) emp.append(h("p", { class: "muted", text: "Not checked yet." }));
  else {
    emp.append(h("p", {}, ev?.summary ?? ""));
    const dl = h("dl", { class: "facts" });
    const row = (k, val) => { if (val) dl.append(h("dt", { text: k }), h("dd", {}, val)); };
    row("Person matched", rv.employment.identity_state === "established" ? "Yes" : "No");
    row("Checked", fmtDate(v.created_at)); row("Valid until", fmtDate(v.expires_at));
    const src = ev?.sources?.[0];
    if (src && safeUrl(src.url)) { const [k, tone] = sourceKind(src.url, rv.prospect.company_claimed); row("Based on", h("span", {}, chip(k, tone), " ", h("a", { href: safeUrl(src.url), target: "_blank", rel: "noopener noreferrer", text: src.title || src.url }))); }
    row("Source date", ev?.matched?.evidence_date ?? (ev?.matched ? "No date on the page" : null));
    if (v.confirmation) row("Confirmed by you", `${v.confirmation.note} (${fmtDate(v.confirmation.confirmed_at)})`);
    emp.append(dl);
    if (ev?.matched?.evidence_quote) emp.append(h("blockquote", { text: ev.matched.evidence_quote }));
  }
  box.append(emp);

  const rs = h("div", { class: "card" }, h("h3", { text: "Company research" }));
  if (rv.company) rs.append(h("p", { class: "muted small", text: `Researched as "${rv.company.display_name}". Check this is the right company.` }));
  rs.append(rv.research.length ? h("table", { class: "simple" }, h("thead", {}, h("tr", {}, ["Topic", "Pages found", "Fetched", "Valid until"].map((x) => h("th", { text: x })))),
    h("tbody", {}, rv.research.map((r) => h("tr", {}, h("td", { text: r.label }), h("td", { class: "num", text: r.finding_count }), h("td", { text: fmtDate(r.fetched_at) }), h("td", {}, r.expired ? chip("Expired", "warn") : fmtDate(r.expires_at))))))
    : h("p", { class: "muted", text: "No research yet." }));
  box.append(rs);

  const usable = rv.signals.filter((s) => s.status === "valid"), rejected = rv.signals.filter((s) => s.status === "rejected");
  const sg = h("div", { class: "card" }, h("h3", { text: `Signals (${usable.length} usable)` }), h("p", { class: "muted small", text: "A signal needs a quote that really appears on the page. Signals with no date or that are too old are kept but can never be the hook." }));
  sg.append(usable.length ? signalTable(rv, usable) : h("p", { class: "muted", text: "No usable signals." }));
  if (rejected.length) sg.append(h("details", { style: "margin-top:10px" }, h("summary", { text: `${rejected.length} rejected signal${rejected.length === 1 ? "" : "s"}` }), signalTable(rv, rejected)));
  box.append(sg);
  return box;
}

function signalTable(rv, list) {
  const chosen = rv.hook?.chosen_signal_id;
  return h("table", { class: "simple" }, h("thead", {}, h("tr", {}, ["Signal", "Date", "Status"].map((x) => h("th", { text: x })))),
    h("tbody", {}, list.map((s) => {
      const url = safeUrl(s.source_url);
      const [k, tone] = url ? sourceKind(url, rv.prospect.company_claimed) : ["Web page", "neutral"];
      return h("tr", { class: s.id === chosen ? "chosen" : "" },
        h("td", {}, s.id === chosen ? chip("Chosen hook", "ok") : null, h("div", { text: s.claim }), h("div", { class: "muted small", text: `${TYPES[s.signal_type] ?? s.signal_type}${s.scope === "person" ? ", about the person" : ""}` }),
          h("details", {}, h("summary", { text: "Source and quote" }), h("div", {}, chip(k, tone), " ", url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: s.source_title || url }) : null), h("blockquote", { text: s.evidence_quote }))),
        h("td", { class: "small", text: s.event_date ? `${s.event_date}${s.date_source === "published" ? " (page date)" : ""}` : "None" }),
        h("td", {}, s.status === "valid" ? chip(FRESH[s.freshness]?.[0] ?? s.freshness, FRESH[s.freshness]?.[1]) : chip(REJECTIONS[s.rejection_reason] ?? "Rejected", "bad"),
          s.sensitivity === "tone_review_required" ? h("div", {}, chip("Tone review", "warn")) : null));
    })));
}

/* ----- scoring tab ----- */

function scoringTab(rv) {
  const hk = rv.hook;
  if (!hk) return h("div", { class: "main" }, h("div", { class: "card" }, h("p", { class: "muted", text: "No scoring yet. Run the research first." })));
  const chosen = hk.scored_signals.find((s) => s.outcome === "chosen");
  let summary;
  if (hk.signal_strength === "insufficient") summary = chosen ? `The best signal scored ${chosen.total}, below the 3.0 needed.` : "No signal was dated, recent, safe and relevant enough to use as the hook.";
  else if (hk.persona_unassessed && hk.signal_strength === "moderate") summary = "Moderate. It would be stronger, but the person's role is not confirmed, so persona fit was not scored.";
  else summary = hk.signal_strength === "strong" ? "Strong. A recent, specific signal that fits the offer and the role." : "Moderate. A usable signal, with room to be more specific.";
  const heads = ["Signal", "Specific", "Persona", "Offer", "Recency", "Total", "Result"];
  const body = hk.scored_signals.map((r) => {
    const result = r.outcome === "chosen" ? chip("Chosen", "ok")
      : h("span", { class: "small muted", text: r.reason ? (WHY_NOT[r.reason] ?? r.reason) : r.outcome === "eligible" ? "Eligible, ranked lower" : "" });
    const persona = !r.scored ? "" : r.persona_fit === null ? h("span", { class: "muted small", text: "not scored" }) : scoreBar(r.persona_fit, 5);
    return h("tr", { class: r.outcome === "chosen" ? "chosen" : "" },
      h("td", {}, h("div", { text: r.claim }), r.potential_implication ? h("div", { class: "muted small", text: r.potential_implication }) : null),
      h("td", {}, r.scored ? scoreBar(r.specificity, 5) : ""), h("td", {}, persona),
      h("td", {}, r.scored ? scoreBar(r.offer_fit, 5) : ""), h("td", {}, r.scored ? scoreBar(r.recency, 5) : ""),
      h("td", { class: "num", text: r.total ?? "" }), h("td", {}, result));
  });
  const intro = h("div", { class: "card" }, h("h3", { text: "Why this hook" }), h("p", { text: summary }),
    h("p", { class: "muted small", text: "Total = offer fit 35%, persona fit 25%, specificity 20%, recency 20%. A tone-review topic loses 0.5. A hook also needs a date, to be recent enough, and offer fit of at least 3." }));
  const table = h("div", { class: "card" }, h("div", { class: "table-wrap" }, h("table", { class: "simple" },
    h("thead", {}, h("tr", {}, heads.map((x, i) => h("th", { class: i > 0 && i < 6 ? "num" : "", text: x })))), h("tbody", {}, body))));
  return h("div", { class: "main" }, intro, table);
}

/* ----- activity tab ----- */

function activityTab() {
  if (!state.events.length) return h("div", { class: "main" }, h("div", { class: "card" }, h("p", { class: "muted", text: "No activity yet." })));
  return h("div", { class: "main" }, h("div", { class: "card" }, h("h3", { text: "Technical log" }), h("p", { class: "muted small", text: "Every step of the most recent run, in order." }),
    h("ul", { class: "events" }, state.events.map((e) => h("li", { class: e.level }, h("span", { class: "t", text: fmtTime(e.created_at) }), h("span", { class: "muted", text: e.stage ? e.stage.split(":")[0] : e.type.replace(/_/g, " ") }), h("span", { text: e.message }))))));
}

/* ----- drawer shell and action bar ----- */

function renderDrawer() {
  const rv = state.review;
  if (!rv || !state.currentId) return;
  const p = rv.prospect;
  const have = ["personalised", "fallback"].filter((l) => rv.lanes[l]);
  if (have.length && !have.includes(state.lane)) state.lane = have[0];
  const L = have.length ? rv.lanes[state.lane] : null;
  const st = getProspectStatus({ ...p, latest_run: rv.running ? { status: "running" } : (state.run ?? rv.last_run) });

  $("dHead").replaceChildren(
    h("div", {}, h("h2", { text: p.full_name }), h("div", { class: "muted", text: [p.designation, p.company_claimed].filter(Boolean).join(" at ") }),
      h("div", { class: "chips" }, chip(st.label, st.tone), rv.employment.person_specific ? chip("Can refer to the person", "ok") : chip("Writing about the company only", "neutral"),
        state.profile && !roleFitsPersonas(p.designation, state.profile.personas) ? chip("Role outside your target personas", "warn") : null)),
    h("div", { class: "head-actions" }, h("button", { class: "btn sm", type: "button", onclick: openEditDialog }, "Edit details"), h("button", { class: "btn sm", type: "button", onclick: () => closeDrawer() }, "Close")));

  const tabs = h("div", { class: "tabs", role: "tablist" }, [["draft", "Draft"], ["evidence", "Evidence"], ["scoring", "Scoring"], ["activity", "Activity"]].map(([k, l]) =>
    h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(state.tab === k), onclick: () => { state.tab = k; renderDrawer(); } }, l)));
  const content = state.tab === "draft" ? draftTab(rv, L) : state.tab === "evidence" ? evidenceTab(rv) : state.tab === "scoring" ? scoringTab(rv) : activityTab();

  const scroller = $("dScroll");
  const top = scroller.scrollTop;
  scroller.replaceChildren(verdictCard(rv, L), runPanel(rv), h("div", { class: "cols" }, h("div", { class: "main" }, tabs, content), rail(rv, L)));
  scroller.scrollTop = top;
  renderBar();
}

async function copyDraft() {
  const L = state.review?.lanes[state.lane];
  if (!L) return;
  const subject = state.edit?.draftId === L.latest.id ? state.edit.subject : L.latest.subject;
  const body = state.edit?.draftId === L.latest.id ? state.edit.body : L.latest.body;
  try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); toast("Draft copied.", "good"); }
  catch { toast("Could not copy. Select the text and copy it by hand.", "error"); }
}

function renderBar() {
  const rv = state.review, bar = $("actionbar");
  if (!rv) return;
  bar.replaceChildren();
  const L = rv.lanes[state.lane];
  const why = (text, ok) => h("div", { class: "why" + (ok ? " ok" : ""), text });
  const btn = (label, cls, fn) => { const b = h("button", { class: "btn " + cls, type: "button" }, label); b.addEventListener("click", () => act(b, fn)); return b; };
  if (!L) { bar.append(why("No draft yet."), h("button", { class: "btn primary", type: "button", onclick: () => runAction("manual") }, "Research and draft")); return; }
  const d = L.latest, dirty = isDirty(L);
  const copy = h("button", { class: "btn", type: "button", onclick: copyDraft }, "Copy draft");

  if (d.status === "gmail_draft") { bar.append(why("Saved to Gmail. Nothing was sent.", true), copy, h("a", { class: "btn primary", href: "https://mail.google.com/mail/u/0/#drafts", target: "_blank", rel: "noopener noreferrer", text: "Open Gmail drafts" })); return; }
  if (d.status === "approved") {
    const g = state.gmail, unknown = L.gmail && ["unknown", "creating"].includes(L.gmail.status);
    let primary;
    if (!g?.configured) { bar.append(why("Gmail is not set up. Add the Google values to .env.")); bar.append(copy); return; }
    if (!g.connected) primary = h("a", { class: "btn primary", href: "/api/gmail/connect", text: "Connect Gmail" });
    else primary = btn(unknown ? "Create anyway" : "Create Gmail draft", "primary", () => post(`/api/drafts/${d.id}/gmail`, unknown ? { force: true } : {}).then(() => toast("Saved to your Gmail drafts. Nothing was sent.", "good")));
    bar.append(why(unknown ? "An earlier attempt may or may not have saved. Check your Gmail Drafts folder first." : `Saves to ${g.email ?? "your Gmail"} as a draft. ${rv.prospect.email ? `Addressed to ${rv.prospect.email}.` : "This prospect has no email, so it will have no recipient."}`), copy, primary);
    return;
  }
  if (d.status === "rejected") { bar.append(why("This version was rejected."), copy, state.lane === "personalised" ? btn("Regenerate", "primary", () => runAction("regenerate")) : null); return; }

  const reason = dirty ? "You have unsaved edits. Save them as a new version first." : L.gate.allowed ? "Ready to approve." : L.gate.reasons[0]?.message;
  const save = btn("Save as new version", "", () => post(`/api/drafts/${d.id}/edit`, { subject: state.edit.subject, body: state.edit.body }).then((r) => { state.edit = null; if (r.warning) toast(r.warning, "error"); else toast("Saved as a new version and fact-checked.", "good"); }));
  save.disabled = !dirty;
  const reject = h("button", { class: "btn danger", type: "button" }, "Reject");
  reject.addEventListener("click", () => { const r = prompt("Why are you rejecting this draft? (optional)"); if (r === null) return; act(reject, () => post(`/api/drafts/${d.id}/reject`, r.trim() ? { reason: r.trim() } : {})); });
  const approve = btn("Approve", "primary", () => post(`/api/drafts/${d.id}/approve`).then(() => toast("Approved. You can now create the Gmail draft.", "good")));
  approve.disabled = !L.gate.allowed || dirty;
  approve.title = approve.disabled ? reason : "";
  bar.append(why(reason, L.gate.allowed && !dirty), copy, save, reject, approve);
}

/* ====================== edit details ====================== */

function openEditDialog() {
  const p = state.review.prospect, dlg = $("editDlg");
  const f = { full_name: h("input", { type: "text", value: p.full_name, required: true }), company: h("input", { type: "text", value: p.company_claimed, required: true }),
    designation: h("input", { type: "text", value: p.designation ?? "" }), email: h("input", { type: "email", value: p.email ?? "" }), linkedin_url: h("input", { type: "url", value: p.linkedin_url ?? "" }) };
  const field = (label, input) => h("div", { class: "field" }, h("label", { text: label }), input);
  const save = h("button", { class: "btn primary", type: "submit" }, "Save changes");
  dlg.replaceChildren(h("div", { class: "dlg-head" }, h("h2", { text: "Edit details" })),
    h("p", { class: "muted small", text: "Changing the name, company or role means the employment check runs again. Every change is recorded." }),
    h("form", { onsubmit: async (e) => {
      e.preventDefault(); save.disabled = true;
      try {
        const body = {};
        for (const [k, el] of Object.entries(f)) body[k] = el.value.trim();
        await api(`/api/prospects/${p.id}`, { method: "PATCH", body: JSON.stringify(body) });
        dlg.close(); toast("Details saved. Press Run again to re-check and refresh the draft.", "good");
        await refreshReview(); loadList().catch(() => {});
      } catch (err) { toast(err.message, "error"); save.disabled = false; }
    } }, field("Full name", f.full_name), field("Company", f.company), field("Role", f.designation), field("Email", f.email), field("LinkedIn link", f.linkedin_url),
    h("div", { class: "head-actions" }, save, h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "Cancel"))));
  dlg.showModal();
}

/* ====================== boot ====================== */

{
  const g = new URLSearchParams(location.search).get("gmail");
  if (g) {
    const msg = { connected: ["Gmail connected.", "good"], denied: ["Gmail access was not granted.", "error"], bad_state: ["That sign-in link expired. Try connecting again.", "error"],
      no_refresh_token: ["Google did not give a long-lived permission. Remove this app at myaccount.google.com/permissions, then connect again.", "error"],
      failed: ["Connecting Gmail failed. Check the server log.", "error"], not_configured: ["Gmail is not set up in .env yet.", "error"] }[g];
    if (msg) setTimeout(() => toast(msg[0], msg[1]), 600);
    history.replaceState(null, "", "/");
  }
}
start();

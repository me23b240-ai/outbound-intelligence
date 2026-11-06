import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";
import * as R from "./rules.js";
import { normalizedFields } from "./prospects.js";
import {
  loadState, loadCurrentSignals, gateFor, currentGrounding, groundDraft, refreshStatus, audit, bump,
} from "./pipeline.js";

export const review = Router();

const err = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });
const uuid = z.string().uuid();
const THEME_LABELS = Object.fromEntries([...config.themes, config.personTheme].map((t) => [t.key, t.label]));

async function one(q) {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}
async function activeRun(prospectId) {
  const { data } = await db.from("runs").select("id").eq("prospect_id", prospectId).in("status", ["queued", "running"])
    .gt("heartbeat_at", new Date(Date.now() - config.runStaleSeconds * 1000).toISOString()).limit(1);
  return data?.[0] ?? null;
}
async function loadProspect(id) {
  return one(db.from("prospects").select("*").eq("id", id).is("archived_at", null).maybeSingle());
}
async function latestInLane(prospectId, lane) {
  const rows = await one(db.from("drafts").select("*").eq("prospect_id", prospectId).eq("lane", lane).order("version", { ascending: false }).limit(1));
  return rows[0] ?? null;
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error(e); err(res, 500, "server_error", "Something went wrong: " + e.message); }
};

/* ---------- everything the review screen needs, in one read ---------- */

review.get("/prospects/:id/review", wrap(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return err(res, 400, "invalid_input", "Bad prospect id");
  const prospect = await loadProspect(id.data);
  if (!prospect) return err(res, 404, "not_found", "Prospect not found");

  const state = await loadState(id.data);
  const { verification, employment, hook, profile } = state;
  const now = new Date();

  const company = prospect.company_id ? await one(db.from("companies").select("*").eq("id", prospect.company_id).maybeSingle()) : null;
  let records = [];
  if (prospect.company_id) {
    records = await one(db.from("research_records").select("id, theme, finding_count, fetched_at, expires_at, prospect_id")
      .eq("company_id", prospect.company_id).is("superseded_at", null));
  }
  records = records
    .filter((r) => !r.prospect_id || employment.person_specific)
    .map((r) => ({ ...r, label: THEME_LABELS[r.theme] ?? r.theme, expired: new Date(r.expires_at) <= now }));

  const signals = (await loadCurrentSignals(prospect, employment.person_specific)).map((s) => {
    const freshness = R.freshnessLabel(s.signal_type, s.event_date, s.date_precision, now);
    return {
      id: s.id, claim: s.claim, signal_type: s.signal_type, scope: s.scope, theme: s.theme,
      theme_label: THEME_LABELS[s.theme] ?? s.theme, event_date: s.event_date, date_precision: s.date_precision,
      date_source: s.date_source, source_url: s.source_url, source_title: s.source_title, evidence_quote: s.evidence_quote,
      status: s.status, rejection_reason: s.rejection_reason, sensitivity: s.sensitivity_effective,
      sensitivity_category: s.sensitivity_category, freshness,
      selectable: s.status === "valid" && (freshness === "current" || freshness === "older_but_relevant") && s.sensitivity_effective !== "blocked",
    };
  });

  const lanes = {};
  for (const lane of ["personalised", "fallback"]) {
    const versions = await one(db.from("drafts").select("*").eq("prospect_id", prospect.id).eq("lane", lane).order("version", { ascending: false }).limit(6));
    if (!versions.length) { lanes[lane] = null; continue; }
    const latest = versions[0];
    const gate = await gateFor(latest, state);
    const gmail = await one(db.from("gmail_drafts").select("*").eq("draft_id", latest.id).maybeSingle());
    lanes[lane] = {
      latest, versions: versions.map((v) => ({ id: v.id, version: v.version, origin: v.origin, status: v.status, created_at: v.created_at })),
      gmail, grounding: gate.grounding, gate: { allowed: gate.allowed, reasons: gate.reasons, notices: gate.notices, stale: gate.stale },
    };
  }

  const lastRun = (await one(db.from("runs").select("*").eq("prospect_id", prospect.id).order("started_at", { ascending: false }).limit(1)))[0] ?? null;
  const running = !!(await activeRun(prospect.id));

  res.json({
    prospect, company, profile: { version: profile.version, personas: profile.personas, company_name: profile.product?.company_name ?? null, category: profile.product?.category ?? null, approved_claims: profile.approved_claims ?? [], signature: profile.product?.signature ?? null },
    verification: verification && {
      id: verification.id, status: verification.status, identity_state: verification.identity_state, evidence: verification.evidence,
      expires_at: verification.expires_at, confirmation: verification.confirmation, created_at: verification.created_at,
    },
    employment, research: records, signals,
    hook: hook && {
      id: hook.id, signal_strength: hook.signal_strength, persona_unassessed: hook.persona_unassessed, tone_constraints: hook.tone_constraints,
      person_specific: hook.person_specific, chosen_signal_id: hook.chosen_signal_id, scored_signals: hook.scored_signals, created_at: hook.created_at,
    },
    lanes, last_run: lastRun, running,
    can_confirm_employment: !!verification && verification.status === "uncertain" && verification.identity_state === "established"
      && !verification.confirmation && !employment.expired && employment.fingerprint_match,
  });
}));

/* ---------- prospect actions ---------- */

const patchSchema = z.object({
  full_name: z.string().trim().min(2).max(200).optional(),
  company: z.string().trim().min(2).max(200).optional(),
  designation: z.string().trim().max(200).optional(),
  email: z.union([z.string().trim().email(), z.literal("")]).optional(),
  linkedin_url: z.union([z.string().trim().url(), z.literal("")]).optional(),
}).strict();

review.patch("/prospects/:id", wrap(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const body = patchSchema.safeParse(req.body);
  if (!id.success || !body.success) return err(res, 400, "invalid_input", body.success ? "Bad prospect id" : body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const before = await loadProspect(id.data);
  if (!before) return err(res, 404, "not_found", "Prospect not found");
  if (await activeRun(before.id)) return err(res, 409, "run_in_progress", "Wait for the current run to finish first.");

  const p = body.data;
  const next = {
    full_name: p.full_name ?? before.full_name,
    company: p.company ?? before.company_claimed,
    designation: p.designation !== undefined ? (p.designation || null) : before.designation,
    email: p.email !== undefined ? (p.email || null) : before.email,
    linkedin_url: p.linkedin_url !== undefined ? (p.linkedin_url || null) : before.linkedin_url,
  };
  const patch = {
    full_name: next.full_name, company_claimed: next.company, designation: next.designation, email: next.email,
    linkedin_url: next.linkedin_url, ...normalizedFields(next),
  };
  if (patch.company_normalized !== before.company_normalized) patch.company_id = null;
  const { error } = await db.from("prospects").update(patch).eq("id", before.id);
  if (error) {
    if (error.code === "23505") return err(res, 409, "duplicate", "Another prospect already has that email, or that name and company.");
    throw new Error(error.message);
  }
  await audit(before.id, "prospect_corrected", {
    before: { full_name: before.full_name, company: before.company_claimed, designation: before.designation, email: before.email, linkedin_url: before.linkedin_url },
    after: next,
  });
  await bump(before.id);
  await refreshStatus(before.id);
  res.json({ ok: true });
}));

review.post("/prospects/:id/archive", wrap(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return err(res, 400, "invalid_input", "Bad prospect id");
  const p = await loadProspect(id.data);
  if (!p) return err(res, 404, "not_found", "Prospect not found");
  if (await activeRun(p.id)) return err(res, 409, "run_in_progress", "Wait for the current run to finish before removing.");
  await db.from("prospects").update({ archived_at: new Date().toISOString() }).eq("id", p.id);
  await audit(p.id, "prospect_archived", { full_name: p.full_name, company: p.company_claimed });
  await bump(p.id);
  res.json({ ok: true });
}));

const noteSchema = z.object({ note: z.string().trim().min(3, "Add a short note on how you confirmed it").max(500) }).strict();

review.post("/prospects/:id/confirm-employment", wrap(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const body = noteSchema.safeParse(req.body);
  if (!id.success || !body.success) return err(res, 400, "invalid_input", body.success ? "Bad prospect id" : body.error.issues[0].message);
  const state = await loadState(id.data);
  const v = state.verification;
  if (!v || v.status !== "uncertain" || v.identity_state !== "established" || v.confirmation || state.employment.expired || !state.employment.fingerprint_match) {
    return err(res, 409, "cannot_confirm", "Employment can only be confirmed when the check is unconfirmed but the person was identified, and is still current.");
  }
  await db.from("verifications").update({ confirmation: { note: body.data.note, confirmed_by: "sdr", confirmed_at: new Date().toISOString() } }).eq("id", v.id);
  await audit(id.data, "employment_confirmed", { note: body.data.note, verification_id: v.id });
  await bump(id.data);
  res.json({ ok: true });
}));

/* ---------- draft actions ---------- */

async function loadDraft(idParam) {
  const id = uuid.safeParse(idParam);
  if (!id.success) return null;
  return one(db.from("drafts").select("*").eq("id", id.data).maybeSingle());
}

review.post("/drafts/:id/edit", wrap(async (req, res) => {
  const body = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
  if (!body.success) return err(res, 400, "invalid_input", body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const parent = await loadDraft(req.params.id);
  if (!parent) return err(res, 404, "not_found", "Draft not found");
  const latest = await latestInLane(parent.prospect_id, parent.lane);
  if (latest.id !== parent.id) return err(res, 409, "not_latest", "Only the newest version can be edited.");
  if (await activeRun(parent.prospect_id)) return err(res, 409, "run_in_progress", "Wait for the current run to finish first.");

  const state = await loadState(parent.prospect_id);
  const fallback = parent.lane === "fallback";
  const violations = R.checkDraftConstraints({
    subject: body.data.subject, body: body.data.body, recipientName: state.prospect.full_name,
    identityState: state.employment.identity_state, personSpecific: fallback ? false : state.employment.person_specific,
    designation: fallback ? null : state.prospect.designation, bannedClaims: state.profile.banned_claims,
  });
  const { id: _id, created_at: _c, ...carry } = parent;
  const draft = await one(db.from("drafts").insert({
    ...carry, version: parent.version + 1, parent_draft_id: parent.id, origin: "edited", subject: body.data.subject, body: body.data.body,
    constraint_failed: violations.length > 0, constraint_violations: violations, tone_ack_at: null, status: "review",
    approved_at: null, approved_against: null, rejection_reason: null, human_touched: true, generation_fingerprint: null, gemini_call_id: null,
  }).select().single());

  let warning = null;
  try { await groundDraft(draft, state.profile); }
  catch (e) { console.error("grounding after edit failed:", e); warning = "Saved, but the fact-check could not run: " + e.message + " Use Check again."; }
  await audit(parent.prospect_id, "draft_edited", { from: parent.id, to: draft.id, version: draft.version });
  await bump(parent.prospect_id);
  await refreshStatus(parent.prospect_id);
  res.json({ draft, warning });
}));

review.post("/drafts/:id/recheck", wrap(async (req, res) => {
  const draft = await loadDraft(req.params.id);
  if (!draft) return err(res, 404, "not_found", "Draft not found");
  const latest = await latestInLane(draft.prospect_id, draft.lane);
  if (latest.id !== draft.id) return err(res, 409, "not_latest", "Only the newest version can be checked.");
  const state = await loadState(draft.prospect_id);
  try { await groundDraft(draft, state.profile); } catch (e) { return err(res, 502, e.code ?? "ground_failed", "The fact-check could not run: " + e.message); }
  res.json({ ok: true });
}));

review.post("/drafts/:id/ack-tone", wrap(async (req, res) => {
  const draft = await loadDraft(req.params.id);
  if (!draft) return err(res, 404, "not_found", "Draft not found");
  if (!draft.requires_tone_ack) return err(res, 409, "not_needed", "This draft does not need a tone review.");
  await db.from("drafts").update({ tone_ack_at: new Date().toISOString() }).eq("id", draft.id);
  await audit(draft.prospect_id, "tone_acknowledged", { draft_id: draft.id });
  await bump(draft.prospect_id);
  res.json({ ok: true });
}));

review.post("/drafts/:id/reject", wrap(async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(300).optional() }).strict().safeParse(req.body ?? {});
  if (!body.success) return err(res, 400, "invalid_input", "Bad request");
  const draft = await loadDraft(req.params.id);
  if (!draft) return err(res, 404, "not_found", "Draft not found");
  if (draft.status !== "review") return err(res, 409, "not_in_review", `This draft is already ${draft.status}.`);
  await db.from("drafts").update({ status: "rejected", rejection_reason: body.data.reason ?? null }).eq("id", draft.id);
  await audit(draft.prospect_id, "draft_rejected", { draft_id: draft.id, reason: body.data.reason ?? null });
  await bump(draft.prospect_id);
  await refreshStatus(draft.prospect_id);
  res.json({ ok: true });
}));

review.post("/drafts/:id/approve", wrap(async (req, res) => {
  const draft = await loadDraft(req.params.id);
  if (!draft) return err(res, 404, "not_found", "Draft not found");
  const latest = await latestInLane(draft.prospect_id, draft.lane);
  if (latest.id !== draft.id) return err(res, 409, "not_latest", "Only the newest version can be approved.");
  if (await activeRun(draft.prospect_id)) return err(res, 409, "run_in_progress", "Wait for the current run to finish first.");

  const state = await loadState(draft.prospect_id);
  const gate = await gateFor(draft, state);
  if (!gate.allowed) return err(res, 409, "gate_blocked", "This draft cannot be approved yet.", { reasons: gate.reasons });

  const { data, error } = await db.rpc("approve_draft", {
    p_draft_id: draft.id,
    p_expected_version: state.prospect.state_version,
    p_approved_against: {
      verification_id: state.verification?.id ?? null, hook_selection_id: draft.hook_selection_id, signal_id: draft.signal_id,
      grounding_check_id: gate.grounding?.id ?? null, profile_hashes: state.hashes, employment: state.employment, approved_at: new Date().toISOString(),
    },
  });
  if (error) throw new Error(error.message);
  if (!data.ok) {
    const msg = data.reason === "conflict" ? "Something changed while you were approving. Review the draft again." : "This draft can no longer be approved.";
    return err(res, 409, data.reason, msg);
  }
  await audit(draft.prospect_id, "draft_approved", { draft_id: draft.id, version: draft.version });
  await refreshStatus(draft.prospect_id);
  res.json({ ok: true });
}));

/* ---------- usage ---------- */

review.get("/usage", wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const q = await db.from("gemini_quota").select("used, cap").eq("day", today).maybeSingle();
  const s = await db.from("gemini_calls").select("id", { count: "exact", head: true }).eq("model", "tavily-search").gte("created_at", monthStart);
  res.json({ gemini_used: q.data?.used ?? 0, gemini_cap: q.data?.cap ?? null, search_used_month: s.count ?? 0, search_cap_month: 1000 });
}));

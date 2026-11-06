// Pure rules: no database, no network. Code decides verdicts; the model only reports observations.
import crypto from "node:crypto";
import { config } from "./config.js";

/* ---------- hashing and text ---------- */

export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

export function sha(v) {
  return crypto.createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex");
}

export function normText(s) {
  return String(s ?? "")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function wordCount(s) {
  const t = String(s ?? "").trim();
  return t ? t.split(/\s+/).length : 0;
}

export function profileHashes(profile) {
  return {
    draft_profile_hash: sha({
      product: profile.product, value_props: profile.value_props, tone_rules: profile.tone_rules,
      approved_claims: profile.approved_claims, banned_claims: profile.banned_claims,
    }),
    approved_claims_hash: sha(profile.approved_claims ?? []),
    banned_claims_hash: sha(profile.banned_claims ?? []),
    tone_rules_hash: sha(profile.tone_rules ?? {}),
    scoring_profile_hash: sha({
      product: profile.product, value_props: profile.value_props, icp: profile.icp, personas: profile.personas,
    }),
  };
}

/* ---------- sensitivity (three independent safeguards) ---------- */

const ORDER = { none: 0, tone_review_required: 1, blocked: 2 };
export const SENSITIVITY_ORDER = ORDER;

// Blocked categories are listed first so they win when text matches several.
const KEYWORDS = [
  ["health", /\b(cancer|diagnos(?:ed|is)|illness|surgery|hospitali[sz]ed|medical leave|chemotherapy|mental health|health condition)\b/i],
  ["bereavement", /\b(passed away|death of|died|funeral|obituary|bereave\w*|condolences?|in memoriam)\b/i],
  ["family", /\b(?:his|her|their) (?:wife|husband|spouse|son|daughter|child|children|mother|father|parents)\b|\b(?:newborn|baby|divorce|custody|wedding|pregnan\w*)\b/i],
  ["personal_legal", /\b(arrested|indicted|convicted|sentenced|restraining order|personal bankruptcy)\b/i],
  ["layoffs", /\b(layoffs?|laid off|job cuts|redundanc(?:y|ies)|headcount reduction|furlough\w*|downsiz(?:e|ed|ing)|workforce reduction)\b/i],
  ["restructuring", /\b(restructur(?:e|ed|es|ing)|reorgani[sz](?:e|ed|es|ation|ing)|turnaround|cost[- ]cutting)\b/i],
  ["executive_departure", /\b(steps? down|stepping down|resign(?:s|ed|ation)?|departure of|leaves the company|ousted|parts? ways with)\b/i],
  ["company_lawsuit", /\b(lawsuit|sued|class action|litigation|antitrust|sec investigation)\b/i],
  ["breach", /\b(data breach|cyberattack|ransomware|security incident|hacked)\b/i],
];

export function keywordCategory(text) {
  for (const [category, re] of KEYWORDS) if (re.test(String(text ?? ""))) return category;
  return "none";
}

export function effectiveSensitivity(modelCategory, text) {
  const level = (c) => config.sensitivityPolicy[c] ?? "none";
  const model = { category: modelCategory || "none", level: level(modelCategory || "none") };
  const kw = keywordCategory(text);
  const keyword = { category: kw, level: level(kw) };
  let policy = { category: "none", level: "none" };
  const nt = normText(text);
  for (const p of config.policyPhrases) {
    if (nt.includes(normText(p.phrase)) && ORDER[p.level] > ORDER[policy.level]) {
      policy = { category: "policy_phrase", level: p.level };
    }
  }
  let best = model;
  for (const l of [keyword, policy]) if (ORDER[l.level] > ORDER[best.level]) best = l;
  const flagged = [];
  if (model.level !== "none") flagged.push("model");
  if (keyword.level !== "none") flagged.push("keyword");
  if (policy.level !== "none") flagged.push("policy");
  return { effective: best.level, category: best.category, model, keyword, policy, flagged };
}

/* ---------- dates and freshness ---------- */

const DAY = 86400000;

export function toStoredDate(date, precision) {
  if (!date) return null;
  const p = { day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ }[precision];
  if (!p || !p.test(date)) return null;
  const full = precision === "year" ? `${date}-01-01` : precision === "month" ? `${date}-01` : date;
  const d = new Date(full + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== full) return null;
  if (d.getUTCFullYear() < 2000 || d.getTime() > Date.now() + DAY) return null;
  return full;
}

export function freshnessLabel(type, storedDate, precision, now = new Date()) {
  if (!storedDate || !precision || precision === "unknown") return "undated";
  const d = new Date(String(storedDate).slice(0, 10) + "T00:00:00Z"); // start of period, conservative
  if (Number.isNaN(d.getTime())) return "undated";
  const tier = config.freshness[type] ?? config.freshness.other;
  const age = (now.getTime() - d.getTime()) / DAY;
  if (age <= tier.currentDays) return "current";
  if (age <= tier.staleDays) return "older_but_relevant";
  return "stale";
}

/* ---------- ranking and selection ---------- */

const r2 = (n) => Math.round(n * 100) / 100;

export function computeTotal({ S, P, O, R }, tone, cfg = config.ranking) {
  const w = cfg.weights;
  const parts = [["O", O], ["P", P], ["S", S], ["R", R]].filter(([, v]) => v !== null && v !== undefined);
  const denom = parts.reduce((a, [k]) => a + w[k], 0);
  let total = parts.reduce((a, [k, v]) => a + w[k] * v, 0) / denom;
  if (tone) total -= cfg.tonePenalty;
  return r2(total);
}

export function rankSignals({ signals, scores, now = new Date(), cfg = config.ranking }) {
  const rows = signals.map((s) => {
    const sc = scores[s.id];
    const label = freshnessLabel(s.signal_type, s.event_date, s.date_precision, now);
    const base = {
      signal_id: s.id, claim: s.claim, signal_type: s.signal_type, scope: s.scope,
      event_date: s.event_date, date_precision: s.date_precision, freshness: label,
      sensitivity: s.sensitivity_effective, sensitivity_category: s.sensitivity_category,
    };
    if (!sc) return { ...base, scored: false };
    const R = cfg.recency[label] ?? 1;
    const tone = s.sensitivity_effective === "tone_review_required";
    const total = computeTotal({ S: sc.specificity, P: sc.persona_fit, O: sc.offer_fit, R }, tone, cfg);
    return {
      ...base, scored: true, specificity: sc.specificity, persona_fit: sc.persona_fit, offer_fit: sc.offer_fit,
      recency: R, tone_penalty_applied: tone, total,
      rationale: sc.rationale ?? null, persona_fit_reason: sc.persona_fit_reason ?? null,
      potential_implication: sc.potential_implication ?? null,
    };
  });

  const scored = rows.filter((r) => r.scored).sort((a, b) =>
    b.total - a.total ||
    b.offer_fit - a.offer_fit ||
    String(b.event_date ?? "").localeCompare(String(a.event_date ?? "")) ||
    String(a.signal_id).localeCompare(String(b.signal_id))
  );
  scored.forEach((r, i) => { r.rank = i + 1; });
  const unscored = rows.filter((r) => !r.scored).map((r) => ({ ...r, rank: null, outcome: "not_scored", reason: "not_scored" }));

  let chosen = null;
  for (const r of scored) {
    const dated = r.freshness !== "undated";
    const okFresh = r.freshness === "current" || r.freshness === "older_but_relevant";
    const blocked = r.sensitivity === "blocked";
    if (!dated) { r.outcome = "not_selectable"; r.reason = "undated"; continue; }
    if (!okFresh) { r.outcome = "not_selectable"; r.reason = "stale"; continue; }
    if (blocked) { r.outcome = "not_selectable"; r.reason = "blocked"; continue; }
    if (r.offer_fit < cfg.minOfferFit) { r.outcome = "not_selectable"; r.reason = "low_offer_fit"; continue; }
    if (!chosen) { chosen = r; r.outcome = "chosen"; r.reason = null; }
    else { r.outcome = "eligible"; r.reason = null; }
  }

  let strength = "insufficient";
  if (chosen) {
    strength = chosen.total >= cfg.strongAt ? "strong" : chosen.total >= cfg.moderateAt ? "moderate" : "insufficient";
    if (chosen.persona_fit === null && strength === "strong") strength = "moderate";
  }
  return { ranked: [...scored, ...unscored], chosen, strength, personaUnassessed: chosen ? chosen.persona_fit === null : true };
}

/* ---------- employment state ---------- */

export function deriveEmploymentState(verification, currentFingerprint, now = new Date()) {
  if (!verification) {
    return { status: "none", identity_state: "unknown", expired: false, fingerprint_match: false,
             confirmed: false, effective: "unconfirmed", person_specific: false };
  }
  const expired = new Date(verification.expires_at).getTime() <= now.getTime();
  const fpOk = verification.input_fingerprint === currentFingerprint;
  const confirmed = !!verification.confirmation;
  const ok = !expired && fpOk && (verification.status === "verified" || (verification.status === "uncertain" && confirmed));
  return {
    status: verification.status, identity_state: verification.identity_state, expired,
    fingerprint_match: fpOk, confirmed, effective: ok ? "confirmed" : "unconfirmed",
    person_specific: ok && verification.identity_state === "established",
  };
}

/* ---------- draft constraints ---------- */

const LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|io|net|org|co|ai|in|app|dev)\b/i;
const PLACEHOLDER = /\[[^\]]*\]|\{\{|\}\}|<[^>]+>/;
const TEAM_ASSUMPTION =
  /\byour (team|role|position|department|company|organi[sz]ation|firm|finance team|ap team)\b|\byou (lead|run|manage|oversee|head|own)\b|\bas (a|the) (cfo|vp|head|controller|manager|director)\b/i;

export function checkDraftConstraints({
  subject, body, recipientName, identityState, personSpecific, designation, bannedClaims = [], cfg = config.draft,
}) {
  const v = [];
  const words = wordCount(body);
  if (!String(subject ?? "").trim()) v.push("The subject is empty.");
  if (/[$\u20AC\u00A3\u20B9]|(^|[^A-Za-z0-9])\d[\d.,]*\s*(%|[kKmMbB])?(?![A-Za-z0-9])/.test(String(subject ?? ""))) v.push("The subject contains a figure or currency symbol.");
  if (String(subject ?? "").length > cfg.subjectMaxChars) v.push(`The subject is longer than ${cfg.subjectMaxChars} characters.`);
  if (!String(body ?? "").trim()) v.push("The body is empty.");
  if (words > cfg.emailWordCap) v.push(`The body has ${words} words; the limit is ${cfg.emailWordCap}.`);
  if (LINK.test(`${subject}\n${body}`)) v.push("The draft contains a link or web address.");
  if (PLACEHOLDER.test(`${subject}\n${body}`)) v.push("The draft contains a placeholder such as [name].");
  const questions = (String(body).match(/\?/g) ?? []).length;
  if (questions !== 1) v.push(`The draft must contain exactly one question; it has ${questions}.`);

  const all = normText(`${subject}\n${body}`);
  for (const b of bannedClaims) if (b && all.includes(normText(b))) v.push(`The draft uses a banned phrase: "${b}".`);

  if (identityState !== "established") {
    if (!/^\s*hello,/i.test(String(body))) v.push('Unconfirmed identity requires the greeting "Hello,".');
    for (const t of normText(recipientName).split(" ").filter((t) => t.length >= 3)) {
      if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(all)) {
        v.push("The draft uses the recipient's name while identity is unconfirmed.");
        break;
      }
    }
  }
  if (!personSpecific) {
    if (designation && all.includes(normText(designation))) v.push("The draft mentions the recipient's role while employment is unconfirmed.");
    if (TEAM_ASSUMPTION.test(String(body))) v.push("The draft assumes the recipient's role or team while employment is unconfirmed.");
  }
  return v;
}

/* ---------- grounding assessment ---------- */

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function checkSpanCoverage(draftText, items) {
  const text = squash(draftText);
  let pos = 0;
  for (let i = 0; i < items.length; i++) {
    const span = squash(items[i].text_span);
    if (!span) return { ok: false, message: `Item ${i + 1} has an empty text_span.` };
    const idx = text.indexOf(span, pos);
    if (idx < 0) return { ok: false, message: `Item ${i + 1} text_span is not found in order in the draft: "${span.slice(0, 60)}".` };
    if (text.slice(pos, idx).trim() !== "") {
      return { ok: false, message: `Text is missing before item ${i + 1}: "${text.slice(pos, idx).trim().slice(0, 60)}".` };
    }
    pos = idx + span.length;
  }
  if (text.slice(pos).trim() !== "") {
    return { ok: false, message: `The items stop early. Uncovered text: "${text.slice(pos).trim().slice(0, 60)}".` };
  }
  return { ok: true };
}

function digitsIn(s) { return (String(s).match(/\d+(?:[.,]\d+)?/g) ?? []); }

export function evaluateGrounding({ items, draftText, signals, personSpecific, approvedText, bannedClaims = [] }) {
  const coverage = checkSpanCoverage(draftText, items);
  const byId = new Map(signals.map((s) => [s.id, s]));
  const approved = normText(approvedText);
  const results = items.map((it, index) => {
    const span = squash(it.text_span);
    const ns = normText(span);
    const out = { index, text_span: span, kind: it.kind, ok: true, rule: "ok", message: "" };
    const fail = (rule, message) => { out.ok = false; out.rule = rule; out.message = message; return out; };

    if (it.kind === "greeting") {
      return wordCount(span) <= 6 && /^(hi|hello|dear|hey)\b/i.test(span) ? out : fail("greeting_misused", "A sentence labelled greeting is not a short greeting.");
    }
    if (it.kind === "closing") {
      return wordCount(span) <= 16 && /\b(best|regards|thanks|thank you|cheers|sincerely|warmly)\b/i.test(span) ? out : fail("closing_misused", "A sentence labelled closing is not a short sign-off.");
    }
    if (it.kind === "call_to_action_question") {
      return span.endsWith("?") ? out : fail("cta_not_question", "The call to action must be a question.");
    }

    // claims
    if (it.subject === "recipient" && !personSpecific) return fail("recipient_claim_blocked", "The draft makes a claim about the recipient while employment is unconfirmed.");
    const quote = normText(it.supporting_quote);
    const isSeller = it.subject === "seller" || it.claim_type === "seller_claim";

    if (isSeller) {
      if (it.claim_source !== "seller_profile") return fail("seller_claim_source", "A seller claim must be supported by the approved claims.");
      if (!quote || !approved.includes(quote)) return fail("seller_claim_unapproved", "This seller claim does not match the approved claims.");
      if (it.support_level !== "supported") return fail("seller_claim_unsupported", "This seller claim is not fully supported by the approved claims.");
      for (const b of bannedClaims) if (b && ns.includes(normText(b))) return fail("seller_claim_banned", `This claim matches a banned claim: "${b}".`);
      const approvedDigits = new Set(digitsIn(approved));
      for (const d of digitsIn(span)) if (!approvedDigits.has(d)) return fail("seller_claim_number", `The number ${d} is not in the approved claims.`);
      return out;
    }
    if (it.claim_type === "hypothesis") {
      return it.hedged && span.includes("?") ? out : fail("hypothesis_not_hedged", "A hypothesis must be hedged and phrased as a question.");
    }
    if (it.claim_type === "inference") {
      return it.hedged ? out : fail("inference_as_fact", "An inference is presented as fact.");
    }
    // fact about company or recipient
    if (it.subject === "general") return fail("general_fact", "A general factual statement needs to be rephrased as a question or removed.");
    const sig = byId.get(it.signal_id);
    if (it.claim_source !== "signal" || !sig) return fail("fact_no_signal", "This factual claim is not tied to a valid signal.");
    const evidence = normText(sig.evidence_quote);
    if (!quote || !evidence.includes(quote)) return fail("fact_quote_missing", "The supporting quote is not found in that signal's evidence.");
    if (it.support_level !== "supported") return fail("fact_partial", "The evidence only partly supports this claim.");
    return out;
  });
  const passed = coverage.ok && results.every((r) => r.ok);
  return { result: passed ? "passed" : "failed", coverage, rule_results: results };
}

/* ---------- the approval gate (one function; the UI only displays it) ---------- */

export function approvalGate({ verification, employment, draft, grounding, hook, hashes, signal }, expect = "review") {
  const reasons = [];
  const notices = [];
  const add = (code, message) => reasons.push({ code, message });

  if (!draft) { add("no_draft", "There is no draft to approve."); return { allowed: false, reasons, notices }; }
  if (draft.status !== expect) add("not_in_review", expect === "approved" ? "This draft has not been approved yet." : `This draft is already ${draft.status}.`);

  // Employment
  if (!verification) add("employment_pending", "Employment has not been checked yet.");
  else if (verification.status === "mismatch") add("employment_mismatch", "The employment check found a mismatch. Correct the record and run again.");
  else if (verification.status === "failed") add("employment_failed", "The employment check failed. Run it again.");
  else if (employment.expired) add("employment_expired", "The employment check has expired and counts as unconfirmed.");
  else if (!employment.fingerprint_match) add("employment_changed", "The prospect details changed since the employment check.");
  else if (verification.status === "uncertain" && !verification.confirmation) add("employment_unconfirmed", "Employment is unconfirmed. Confirm it with a note, or correct the record.");

  // Draft currency (only authorization-affecting dimensions block)
  if (verification && draft.verification_id !== verification.id) add("stale_verification", "The employment check changed after this draft was written.");
  if (draft.person_specific !== employment.person_specific) add("stale_person_specific", "Whether this draft may refer to the recipient has changed. Regenerate it.");
  if (draft.lane === "personalised") {
    if (!hook || draft.hook_selection_id !== hook.id) add("stale_hook", "The chosen signal changed after this draft was written. Regenerate it.");
    if (!signal || signal.status !== "valid") add("signal_invalid", "The signal behind this draft is no longer valid.");
  }
  const ph = draft.profile_hashes ?? {};
  if (ph.approved_claims_hash !== hashes.approved_claims_hash || ph.banned_claims_hash !== hashes.banned_claims_hash) {
    add("stale_claims", "The approved or banned claims changed after this draft was written. Regenerate it.");
  }
  if (ph.tone_rules_hash && ph.tone_rules_hash !== hashes.tone_rules_hash) notices.push("The tone rules changed since this draft was written. This does not block approval.");

  // Grounding (no human override)
  if (!grounding) add("no_grounding", "This draft version has not been fact-checked yet.");
  else {
    if (grounding.result !== "passed") add("grounding_failed", "The fact-check failed. Edit or remove the flagged sentences.");
    const eh = grounding.evidence_hashes ?? {};
    const sigHash = draft.lane === "personalised" ? (signal?.content_hash ?? null) : null;
    if ((draft.lane === "personalised" && eh.signal_hash !== sigHash) ||
        eh.approved_claims_hash !== hashes.approved_claims_hash || eh.banned_claims_hash !== hashes.banned_claims_hash) {
      add("grounding_stale", "The fact-check no longer matches the current evidence. Check it again.");
    }
  }

  if (draft.requires_tone_ack && !draft.tone_ack_at) add("tone_ack_missing", "This signal needs a tone review. Acknowledge it before approving.");
  if (draft.constraint_failed) add("constraint_failed", "The draft breaks a writing rule. Edit it to fix: " + (draft.constraint_violations ?? []).join(" "));
  if (draft.is_generic_fallback && draft.lane !== "fallback") add("fallback_not_chosen", "A generic draft must be chosen explicitly.");

  return { allowed: reasons.length === 0, reasons, notices };
}

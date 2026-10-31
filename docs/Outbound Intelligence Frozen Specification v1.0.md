**READ FIRST: this document is now v1.1.** The deployment target is Vercel + Supabase (serverless), and a design review found eight migration blockers. Both are resolved in **Part II: v1.1 Amendments** near the end. Where Sections 1 to 9 and Appendices A to B conflict with Part II, **Part II wins** (v1.0 text is kept for history until the next consolidation). **Developers building this: read Part III: Developer Handoff first,** then the sections it points to.

# Outbound Intelligence: Frozen Specification v1.0

PS-3 case study build (Personalised outreach, from prospect to draft). Finance-ops demo seller. Stack: Node.js (ES modules), Express, Supabase (Postgres), Gemini API, Zod.

**Status:** Steps 1 to 6 frozen. Next: review for contradictions, then migrations.

## How to use this document

- **This is the single source of truth.** Routes, RPCs, validators and tests must conform to it. If code and this document disagree, one of them is wrong, and the disagreement is resolved through the changelog (Section 8), never silently.
- **Frozen contracts vs implementation notes.** Sections 1 to 7 and Appendix A are normative. Anything learned during the build goes in Appendix D (non-normative implementation notes). If an implementation note forces a change to a contract, add a changelog entry and update the acceptance tests in the same commit.
- **Layout.** Sections 1 to 9 are the readable spec. Per-table column detail, RPC signatures, open spikes and limitations are in the appendices.
- **Vocabulary.** *Signal*: a validated, dated, sourced fact. *Hook*: the chosen signal. *Fingerprint*: hash of a stage's declared inputs plus stage version. *Current*: the one row with `superseded_at` null. *Person-specific*: a draft may assert things about the recipient. *Fixture-backed*: Gemini responses come from recorded bundles.

---

## 1. Product scope and requirements

### 1.1 The brief

Zamp's PS-3: a rep names a prospect, the process researches them, identifies the most relevant hook, and surfaces a draft worth reviewing. The human stays in the loop before anything sends. We decide how to find signal, how to judge relevance, and how to turn it into a message.

**Deliverables:** (1) a live, runnable process with an intuitive UI that includes a live run view (each stage as it executes) and a dashboard (history, status, outputs across runs); (2) a 5-minute demo video showing the happy path and at least one edge case. If the submission advances, the process is run live with the happy path and the prepared edge cases. No slides.

**Edge cases (self-defined, all four retained):** ambiguous identity, insufficient signals, sensitive signals, outdated employment.

**What is graded:** whether it actually runs, judgment behind design choices, and clarity of explanation to a non-technical buyer. A process that runs end to end beats one that is 80% built.

### 1.2 Product definition

An outbound intelligence and drafting workspace for one SDR persona. It is not a CRM. Workflow:

Import prospect, verify identity and employment, research the company, extract validated signals, score relevance against the seller profile, draft, independently check the draft against stored evidence, human review, create a Gmail draft. Nothing is ever sent by the application.

### 1.3 Demo seller profile (seeded, configurable)

| Field | Value |
| --- | --- |
| Product category | AI Accounts Payable automation |
| Product capabilities | Invoice data extraction, reduced manual processing, approval workflows, invoice to PO matching, payment visibility |
| Target customers | Mid-market and enterprise; high invoice volumes; scaling finance operations |
| Target personas | CFO, VP Finance, Head of Finance Operations, AP Manager, Financial Controller |
| Core value proposition | Automate repetitive invoice processing and approval workflows so finance teams spend less time on manual operations |
| Outreach positioning | Insight-led, conversational, specific. Never assume a problem exists because a company-level signal exists |
| Approved claims | Approved product descriptions, value propositions, approved numeric claims (may be empty), required block |
| Banned claims | Phrases and claim categories the seller must never make |

The profile is versioned and immutable per version. Exactly one version is active, selected by a pointer.

### 1.4 Signal-to-opportunity map

| Public signal | Potential implication (an opportunity to explore, never a confirmed pain point) |
| --- | --- |
| Hiring multiple AP roles | Growing finance operations workload |
| Expansion into new countries | More complex invoice and payment workflows |
| ERP migration | Potential need for finance workflow integration |
| Rapid growth or funding | Increasing invoice volume |
| Finance transformation announcement | Active investment in operational efficiency |

### 1.5 Non-goals

Reply tracking, follow-up sequences, CRM integration, direct sending, multi-tenant auth, queue services, workflow engines, cancel/pause of runs, xlsx import (CSV only), page-text fetching (grounded summaries only, see Appendix C), advanced analytics. Bulk processing is P1 and first on the cut list.

### 1.6 Priorities and cut list

| Priority | Scope |
| --- | --- |
| P0 | Ingestion, verification, company research, signal extraction, scoring, drafting, grounding check, human review, approval gate, event log, bare run view and prospect table (from Day 2) |
| P1 | Gmail draft creation, compact dashboard, bulk processing, richer run history |
| P2 | Reply tracking, sequences, CRM, analytics |

**Cut first, in order:** LinkedIn variant, dashboard charts, bulk processing, complex candidate UI, freshness tuning, Gmail OAuth (copy-draft fallback is built early and always works).

**Never cut:** source-backed research, evidence-to-draft traceability, human approval, uncertain and mismatch handling, an insufficient-evidence test, a working end-to-end happy path.

### 1.7 System invariants

Every later section exists to enforce these. Tests should reference them by ID.

| ID | Invariant |
| --- | --- |
| I1 | Nothing is sent by the application. Gmail integration creates drafts only. |
| I2 | The database is the only state. No in-memory run state survives a restart. |
| I3 | Derived outputs are versioned and immutable. Staleness is a fingerprint comparison. |
| I4 | The model returns observations; code returns verdicts. |
| I5 | Every model-returned quote is verified by code against stored text. |
| I6 | A blocked signal is never present in any input to a drafting call. |
| I7 | A draft is checked against stored evidence after every generation and every edit. A failed check cannot be overridden by a human. |
| I8 | A mismatch cannot be overridden. An uncertain verification can be confirmed by the SDR, with a note, bound to that verification version. |
| I9 | A human decision is bound to the exact versions it was made against. |
| I10 | A draft cannot assert anything about the recipient's role or employer unless employment is effectively confirmed. |
| I11 | Human-touched drafts are never silently overwritten. |
| I12 | Events are persisted before they are announced. The browser is never required for a run to finish. |
| I13 | One active run per prospect, enforced by the database. |
| I14 | The approval gate is one server-side function; the UI displays its reasons and never decides. |
| I15 | Fixture-backed data is always visibly labelled. |
| I16 | Insufficient evidence produces no personalised draft. A generic fallback is SDR-initiated and labelled generic. |

### 1.8 Assumptions to state in the interview

Public web data only, no LinkedIn scraping. The seller profile is supplied by the rep and is the lens for all relevance decisions. Company-level signals are opportunities, not proven problems. Evidence is the model's grounded summary tied to sources, not page text. Freshness windows and score weights are tunable assumptions held in config.

---

## 2. System architecture

### 2.1 Shape

One Node process (Express) serving the API, the static frontend, and the pipeline runner. No worker, queue, Redis, or workflow engine. "Start run" returns a `run_id` and plan immediately; the browser follows the run through persisted events.

```
HTTP/UI layer     routes, SSE, static frontend   (calls services only)
Service layer     prospects, imports, runs, review actions, stats
Pipeline layer    runPipeline(prospectId), stages, fingerprinting, invalidation
Foundation        db (Supabase), gemini wrapper, gmail client, validators, config
```

**Dependency rule:** arrows point down only. Stages never import routes. Validators are pure: no I/O, no database, no Gemini.

### 2.2 Folder structure

```
src/
  server.js              boot, mount routes, crash recovery
  config/                freshness tiers, TTLs, sensitivity policy + order, score weights,
                         thresholds, model names, concurrency, trigger-to-stage map, origin
  routes/                session, profile, prospects, imports, runs, events(SSE),
                         resolutions, drafts, gmail, stats
  services/              thin orchestration called by routes
  pipeline/
    runPipeline.js       orchestrator (plan, execute, commit)
    stages/              resolveCompany, verify, research, extractSignals,
                         scoreSignals, draft, groundingCheck
    fingerprint.js       canonical input objects, hashing, staleness decisions
    events.js            per-run serialized writer: persist, then notify
    runner.js            in-process execution, boot recovery
  integrations/
    gemini/              client, grounded + structured call types, retry,
                         schema validation, call log, quota reservation, fixture mode
    gmail/               OAuth, draft creation
    supabase.js          data access, RPC wrappers
  validators/            PURE: csvRows, dedupe, companyNameMatch, freshness,
                         sensitivityFilter, quoteWithinSupportedSpan, claimRules,
                         scoring math, approvalGate
  schemas/               Zod: api/ (requests), gemini/ (call outputs), records/
public/                  static frontend
fixtures/                versioned bundles (live-recorded/ and hand-authored/ kept separate)
tests/                   validators first, then pipeline with fixtures
```

### 2.3 Architectural rules

1. **Database is the only state.** A stage reads inputs from and writes output to the database.
2. **Uniform stage contract.** Declare inputs, compute fingerprint, compare with the current output's fingerprint; reuse only if the fingerprint matches, the output is valid, and it has not expired. Otherwise run and commit.
3. **Invalidation is data, not code paths.** Editing an input changes a fingerprint; the next run re-executes affected stages. There is no separate re-verify flow.
4. **Events: persist, then announce.** `emit()` inserts into `run_events`, then wakes in-process listeners. The notifier is a wake-up only; the database is authoritative.
5. **One active run per prospect**, enforced by a partial unique index. On boot, `running` runs become `interrupted` and a recovery run is created. Recovery is safe to execute twice.
6. **Validators are pure and own every rule that must behave identically each time.** Demos target validators directly.
7. **The approval gate is one function** (Section 4.8) enforced by the API and displayed by the UI.
8. **Atomic commits via Postgres RPC.** Multiple Supabase client calls are not a transaction. Output insert, supersede, and stage-row completion commit in one RPC; events are emitted after commit.

### 2.4 Stack and deployment

- Plain JavaScript, ES modules. Zod validates Gemini responses, API request bodies, stage inputs and outputs, and records at boundaries. Explicit errors, never silent nulls.
- Express; `@google/genai`; `@supabase/supabase-js` with the service key (server only).
- Frontend: static HTML and vanilla JS; the browser never holds a Supabase key (no RLS design needed).
- Host: Render or Railway. Free tiers sleep or restart: warm the service before the interview; resumable runs absorb restarts. Secrets (Gemini, Supabase service key, Google OAuth, session secret, demo password) are environment variables only.
- Gmail OAuth in testing mode: only listed test users; refresh tokens expire in about 7 days, so re-authenticate right before the interview. Gmail fails soft with a copy-draft fallback.

### 2.5 Gemini integration boundary

One wrapper; nothing else imports the SDK. Two call types: **grounded** (search tool; free text plus grounding metadata) and **structured** (JSON schema; no search). The wrapper provides: retry with backoff, schema validation with one repair attempt, per-attempt logging to `gemini_calls`, atomic quota reservation before every attempt, model names from config, and fixture mode (Section 5.9).

### 2.6 Security

- Shared demo password, `POST /api/session`, signed `HttpOnly` `SameSite=Lax` cookie, 8-hour expiry, optional display name for the audit trail. Failed logins rate limited per IP. All routes except `/healthz` require the cookie, SSE included.
- Mutating routes accept JSON only, except `POST /api/imports`. Every state-changing request validates `Origin` against the configured origin. No permissive CORS.
- Rate limits (in memory, per session): API about 120/min; run-starting about 10/min; at most 5 concurrent SSE streams. A restart resets them (accepted).
- Daily Gemini cap is database-backed and enforced atomically per attempt (Section 6.2).
- OAuth callback validates a one-time `state`.

### 2.7 Frontend boundary

Prospect table, run view (SSE), review screen with four tabs (Verification, Research findings, Signal analysis, Draft), and a compact dashboard from `/api/stats`. The UI renders gate reasons returned by the server and never decides approvability.

---

## 3. Database schema

Column-level detail is in Appendix A. This section fixes the model, relationships, and rules.

### 3.1 Versioning pattern

Derived tables (`verifications`, `research_records`, `signals`, `hook_selections`, `drafts`, `grounding_checks`) share the pattern:

- `input_fingerprint` and `stage_version`.
- `superseded_at` nullable; **current = `superseded_at IS NULL`**, enforced by a partial unique index per scope.
- Same fingerprint returns the existing valid output (insert with *on conflict return existing*). A changed fingerprint inserts a new row and supersedes the old one in the same RPC transaction.
- A failed or partial output never becomes current.
- **Fingerprint uniqueness is scoped,** never global: `(company_id, theme, input_fingerprint)` for company research; `(prospect_id, stage, input_fingerprint)` for prospect outputs.
- Immutable: draft content, evidence, research text, signals' claim content. Mutable under controlled operations: lifecycle statuses, `superseded_at`, the active-profile pointer.

### 3.2 Relationships

```
seller_profiles (immutable versions)  <-  seller_profile_settings (active pointer)
companies --< research_records --< signals --\
prospects --< verifications                    >-- hook_selections --< drafts --< grounding_checks
prospects --< runs --< run_stages
                  \--< run_events
prospects --< audit_log        imports --< prospects
gemini_calls (run, stage_key)   idempotency_keys   gemini_quota
```

### 3.3 Tables (summary)

| Table | Purpose |
| --- | --- |
| `seller_profiles` | Immutable versions: product, value prop, ICP, personas, tone rules, approved claims, banned claims |
| `seller_profile_settings` | Single row holding the active profile id |
| `companies` | Resolved company identity: display name, normalised name, domain, canonical website. Research belongs here |
| `prospects` | Entered identity, normalised dedupe fields, source, `import_id`, `fixture_id`, cached status fields, `archived_at` |
| `imports` | Filename, counts, per-row report |
| `verifications` | Candidates, evidence, derived status, SDR confirmation (bound to this row) |
| `research_records` | One row per company, theme (and prospect for person-level); raw text; grounding chunks and supports; TTL |
| `signals` | Extracted, validated or rejected, with reason and sensitivity layers |
| `hook_selections` | AI factor scores, code-computed ranking, chosen signal, strength, persona flags |
| `drafts` | Immutable versions with origin, channel, flags, lifecycle status |
| `grounding_checks` | Independently versioned checks of a draft version |
| `runs` | Trigger, status, stored plan, recovery links, heartbeat |
| `run_stages` | One row per run per `stage_key` |
| `run_events` | Append-only narrative with global `id` and per-run `seq` |
| `gemini_calls` | One row per attempt, linked to run and stage\_key |
| `audit_log` | Append-only human decisions |
| `idempotency_keys` | Persistent request deduplication |
| `gemini_quota` | Per-day counter for atomic reservation |

### 3.4 Key constraints and indexes

| Rule | Mechanism |
| --- | --- |
| One active run per prospect | Partial unique index on `runs(prospect_id)` where status in (`queued`, `running`) |
| One current row per scope | Partial unique indexes on `superseded_at IS NULL` for each derived table (scoped as in 3.1) |
| Idempotent derived writes | Unique `(scope, input_fingerprint)` with on-conflict-return-existing |
| No duplicate prospects | Unique indexes on normalised email and on `name\|company` dedupe key (where not archived) |
| One stage row per execution unit | Unique `(run_id, stage_key)`, with keys such as `verify`, `research:funding`, `extract:<research_record_id>` |
| Event ordering | Index `(run_id, id)`; unique `(run_id, seq)` |
| Idempotency | Unique `(session_id, route, key)` |
| Quota | `gemini_quota` primary key on `day`, updated only via RPC |

### 3.5 Derived status fields

Three cached fields on `prospects`, written by `recomputeProspectStatus` in the same transaction as any stage output so they cannot drift. The current records are the source of truth.

| Field | Values |
| --- | --- |
| `verification_status` | pending, running, verified, uncertain, mismatch, failed |
| `research_status` | pending, running, complete, failed, insufficient\_evidence |
| `draft_status` | none, review, approved, gmail\_draft, rejected |

The "needs attention" label is derived in code and never stored (e.g. Confirm employment, Insufficient evidence, Ready to re-run, Draft stale, Correct record).

---

## 4. Pipeline specification

### 4.1 Principles

1. A fingerprint is a hash of the **stage version** (prompt, schema, rule versions) plus a **canonical input object** built by one pure function per stage.
2. Stages depend on **derived facts**, not upstream row ids (for example `person_specific`, `identity_state`). A re-verification with the same conclusion changes nothing downstream (early cutoff).
3. **Config applied in code is not a fingerprint input**: weights, thresholds, freshness tiers, sensitivity lists. Only model judgments are cached.
4. **Human-touched work is never auto-superseded** (I11). A stale human-touched draft shows a banner; regeneration is an explicit SDR action producing a new version and preserving the old.
5. **Reuse needs three tests:** fingerprint matches, not expired, valid. An expired match is logged `refreshed_expired`, never `skipped_unchanged`.
6. The run begins with a **plan**: every stage\_key is `fresh`, `stale`, `expired`, `blocked`, or `missing`. The plan is computed in the transaction that creates the run, stored on the run, returned by the API, and emitted as the first `plan` event, from one snapshot.

### 4.2 Triggers

| Trigger | What it runs |
| --- | --- |
| `manual` | Full pipeline; reuse valid outputs |
| `reverify` | Verification and affected downstream stages |
| `regenerate` | Stale draft and grounding stages |
| `fallback` | Generic fallback generation and its grounding |
| `edit` | Grounding of the newly created draft version only |
| `recovery` | Recompute full plan; resume incomplete work |

The trigger-to-stages map lives in config.

### 4.3 Stages

| # | Stage | Scope | Operation | Output |
| --- | --- | --- | --- | --- |
| 0 | resolveCompany | prospect | deterministic | `company_id` and resolution on prospect |
| 1 | verify | prospect | grounded AI, parse AI, code verdict | `verifications` row |
| 2 | research | company x theme (person x theme only if employment effectively confirmed) | grounded AI | `research_records` |
| 3 | extractSignals | per research record | structured AI, then code validation | `signals` |
| 4 | scoreSignals | prospect x profile | structured AI factors, code ranking | `hook_selections` |
| 5 | draft | prospect x channels | structured AI | `drafts` (one generation) |
| 6 | groundingCheck | per draft version | structured AI, then code rules | `grounding_checks` |

Review, approval, tone acknowledgement, and Gmail creation are human actions that call `approvalGate`, not stages.

**Company resolution:** an exact domain match auto-links. A name-only match against a company with a different or unknown domain ends the run as `needs_input` (`confirm_company`). Otherwise a new company is created. Normalised-name matching suggests candidates and never silently merges.

### 4.4 Fingerprint dependency matrix

| Stage | In the fingerprint | Deliberately not in it | Other invalidators |
| --- | --- | --- | --- |
| resolveCompany | claimed company string, email domain, any SDR confirmation | everything else | none |
| verify | normalised name, claimed designation, resolved `company_id`, LinkedIn URL, email domain, stage version | seller profile, research | TTL about 30 days |
| research (company) | `company_id`, theme, research config version | seller profile, prospect, persona | per-theme TTL |
| research (person) | prospect identity, `company_id`, theme, config version, employment-confirmed flag | seller profile | per-theme TTL |
| extractSignals | research record content hash, extraction version | seller profile | none |
| scoreSignals | content hashes of valid signals, scoring-relevant profile fields (product, value prop, ICP, personas), `person_specific`, designation **only when** `person_specific`, scoring version | tone, banned claims, weights, thresholds, freshness | none |
| draft | chosen signal content hash, draft-relevant profile fields (product, value prop, tone rules, approved claims, banned claims), recipient first name, `person_specific`, `identity_state`, designation (only when `person_specific`), tone constraints, draft version | research, extraction, ICP, personas | none |
| groundingCheck | draft body hash, evidence hashes of referenced signals, `person_specific`, approved claims, banned claims, rule version | seller tone | none |

Signal validation re-runs every time (cheap, deterministic). Ranking is recomputed every run; a new `hook_selection` version is written only if it differs, and a draft goes stale only if the winning signal changes.

### 4.5 Change-to-effect matrix

| Change | verify | research | extract | score | draft | ground |
| --- | --- | --- | --- | --- | --- | --- |
| Seller tone rules | no | no | no | no | re-runs | on new draft |
| Banned claims | no | no | no | no | re-runs | re-runs, including existing draft |
| Approved claims | no | no | no | no | re-runs | re-runs, including existing draft |
| Product or value prop | no | no | no | re-runs | re-runs | on new draft |
| ICP or personas | no | no | no | re-runs | only if chosen signal changes | on new draft |
| Weights, thresholds, freshness tiers | no | no | no | ranking only, no Gemini | only if winner changes | on new draft |
| Correct employer | re-runs | new company means new research; same company reuses | new records only | re-runs | re-runs | on new draft |
| Correct designation only | re-runs | no | no | re-runs only if `person_specific` | only if `person_specific` | on new draft |
| Select candidate (identity fields) | re-runs | no | no | per verify outcome | per verify outcome | on new draft |
| SDR confirms employment | no | no | no | re-runs (persona fit now assessable) | re-runs (`person_specific` flips) | on new draft |
| Re-verify, same outcome | re-runs | no | no | no | no | no |
| Research TTL expires | no | that theme only | its new record | only if signals changed | only if winner changed | on new draft |
| SDR edits draft | no | no | no | no | new version, not regenerated | re-runs on new version |
| Email local part | no | no | no | no | no | no |

### 4.6 Branching

| Condition | Stages that run | Run ends as | Effect |
| --- | --- | --- | --- |
| Company not confidently resolved | 0 | `needs_input` (`confirm_company`) | Confirm company |
| Verify `verified` | all | `completed` | Draft in review |
| Verify `uncertain` (including multiple candidates) | 0, 1, company research, 3, 4, 5, 6; person-level research skipped | `completed` | Draft `person_specific = false`; approval gated |
| Verify `mismatch` | 0, 1 | `needs_input` (`correct_record`) | Correct record, then new run |
| Verify call fails after retries | 0, 1 | `failed` | `verification_status = failed`, retry |
| Strength `insufficient` | 0 to 4 | `completed` | `research_status = insufficient_evidence`; draft stage `blocked`; fallback only on SDR click |
| Moderate strength with unconfirmed employment | all | `completed` | Draft generated automatically; approval gated |
| Chosen signal `tone_review_required` | all | `completed` | Tone constraints; `requires_tone_ack` |
| Grounding fails | all | `completed` | Approval blocked; edit and re-check |

**Uncertain vs mismatch vs failed:** *uncertain*: searched, could not establish truth. *mismatch*: found contradicting evidence. *failed*: verification could not complete. They are never interchangeable.

**Identity vs employment.** `select-candidate` resolves identity by writing candidate fields to the prospect. It sets no verification status and no `person_specific`. Only a re-verification run can yield `verified`. If it stays `uncertain`, the SDR may separately use `confirm-employment`. These are separate audit entries (`prospect_corrected`, `employment_confirmed`).

### 4.7 Scoring and freshness rules (code)

- Freshness is computed in code from `event_date` and signal type, per tier config. Labels: **current**, **older but relevant**, **stale**. Defaults (tunable): job postings 60 to 90 days; executive statements about 6 months; expansion and ERP about 12 months; funding about 18 months.
- The model supplies integer factors `specificity`, `persona_fit` (1 to 5 or null), `offer_fit`. Code adds recency, applies weights, applies the tone-review penalty, ranks, and picks.
- **Missing factor rule:** when `persona_fit` is null, weights are renormalised over available factors (null is never treated as a mid score), signal strength is capped at `moderate`, and the hook selection records `persona_unassessed = true`. The UI shows "strength capped: recipient role unconfirmed".
- Strength thresholds (`strong`, `moderate`, `insufficient`) live in config.
- Every chosen signal is labelled a *potential opportunity*.

### 4.8 The approval gate

`approvalGate(state)` is pure. Inputs are current rows only: current verification (status, confirmation), the draft (grounding status, claim results, generic flag, tone-ack, constraint flag, `person_specific`), the latest grounding check, and the hook selection. It returns `{ allowed, reasons[] }`. It is called at approve time and again immediately before Gmail draft creation.

| Rule | Blocks when |
| --- | --- |
| Employment | Verification is `mismatch`, `failed`, or `pending`; or `uncertain` without a confirmation attached to the current verification row |
| Draft currency | Draft is stale in an authorization-affecting dimension: verification state or `person_specific` changed, hook selection no longer current, chosen signal invalid or superseded, grounding evidence hashes changed, approved or banned claims changed. Cosmetic staleness (tone rules only) shows a banner and does not block |
| Grounding | No grounding check for this draft version, latest check not `passed`, or check does not cover current evidence hashes. No human override |
| Tone | `requires_tone_ack` and no acknowledgement (applies only to `tone_review_required`; `blocked` signals never reach a draft) |
| Constraints | Draft carries `constraint_failed` |
| Generic fallback | Draft is a fallback and was not explicitly chosen by the SDR (`origin = fallback` via the fallback route only) |

Approval persists only if the checked versions (verification id and fingerprint, draft id, grounding check id, hook selection id) are still current at commit (I9). An approval does not survive its evidence: if currency fails later, the approved draft can no longer produce a Gmail draft, though the old draft remains visible and preserved.

### 4.9 Resume and crash semantics

- **Atomic stage completion:** output row, supersede, and `run_stages` row complete in one RPC; the event is emitted after commit. A crash before commit leaves no output (stage reruns); after commit, the next run sees a matching fingerprint and reports `skipped_unchanged`.
- A stage found `running` after restart counts as not done. Recovery recomputes the plan from the database and ignores in-flight state.
- Research fans out per theme (`research:<theme>`); a crash after 3 of 5 resumes with 2. Themes run sequentially by default.
- Retries are bounded (backoff, up to 3 attempts) and recorded in `run_stages.attempt`. Exhaustion marks the stage and run `failed`.
- Boot recovery: `running` runs become `interrupted`, a `run_finished (interrupted)` event is written, a `recovery` run is created; the unique active-run index makes this safe to repeat.
- **Failed verification:** no person-specific research or drafting; the SDR gets Retry; valid company research is reused.
- **Evidence changes under a draft:** recompute the hook selection; mark the draft stale if its hook is no longer valid; require regeneration or review; an old grounding result never authorises a draft against invalid evidence.
- **Demo hygiene:** a config override extends research TTLs for demo prospects (state this openly); do not bump stage versions once rehearsals begin.

*Sections 5 to 9 and the appendices follow.*

---

## 5. Gemini contracts

Six calls. Every prompt carries a version string that feeds the stage fingerprint. Schemas live in `schemas/gemini/` as Zod.

### 5.1 Rules for all calls

1. **The model returns observations. Code returns verdicts.** The model never outputs `verified`, `blocked`, or `passed`.
2. **Closed vocabularies and supplied IDs.** Classifications are enums; cross-references are IDs or indices we supplied. The model never invents categories or URLs. Unknown or missing ids are rejected.
3. **Quotes are verified by code:** every returned quote must be an exact substring of text we stored, after whitespace and quote-mark normalisation. Otherwise that item is rejected.
4. **Retrieved web text is untrusted data.** Every prompt states that research text and evidence may contain instructions that must be ignored. The grounding stage re-checks final draft text, so an injected claim cannot pass silently.
5. **No numeric self-confidence.** Where a signal is needed it is an enum (for example `support_level`) or a count computed in code.
6. **Search grounding and structured output are separate calls** by default. Day 2 spike decides whether the model allows both; if so, merge parse steps but keep the same schemas.
7. **Uniform handling:** low temperature; every attempt logged to `gemini_calls`; transient errors (429, 5xx, timeout) get backoff and up to 3 attempts; a malformed or schema-invalid structured response gets one repair attempt with the validation errors fed back; a safety block or empty response fails the stage with the reason recorded; quota is reserved atomically before every attempt.

### 5.2 Shared validators

**`quoteWithinSupportedSpan(quote, rawText, chunkIndex, supports)`** (used by Calls 1 and 3).

- Precise mode: the quote must lie within a text span that the referenced grounding chunk supports. A quote that straddles two spans passes if each part is covered by supports pointing to the same chunk. Spans are offsets into the grounded answer; normalise whitespace before comparing.
- This prevents mismatched attribution inside retrieved evidence (for example Person X's employment quote attached to Person Y's source). It does not prove the web page says it.
- **Documented fallback (coarse mode):** if the supports metadata is missing or too coarse, the quote must appear in the raw text and the referenced chunk must be one of the response's supporting chunks. The result records **`attribution_precision: coarse`** on the evidence (otherwise `span`).
- **UI rule:** evidence with `coarse` precision must be labelled "source-level attribution". The UI must never imply span-level attribution when only source-level is available.

**`SENSITIVITY_ORDER`** (single exported constant): `none: 0`, `tone_review_required: 1`, `blocked: 2`. The effective category is the maximum across three independent layers (model category, keyword backstop, config policy lookup) by this ordering. The model never arbitrates between layers. Each layer's result is logged.

### 5.3 Call 1: Employment verification (grounded, then parse)

**Grounded input:** name, claimed company, claimed designation, LinkedIn URL if given, resolved company domain. **Grounded output:** semi-structured text, one block per candidate person with current employer and a dated source.

**Parse call (structured, no search), per candidate:**

| Field | Notes |
| --- | --- |
| `full_name`, `employer`, `role` | as stated in the source |
| `employment_in_source` | enum: current, former, unclear |
| `evidence_url_index` | index into grounding chunks, never a free URL |
| `evidence_date` + precision | day, month, year, unknown |
| `evidence_quote` | exact text from the grounded answer; must pass `quoteWithinSupportedSpan` |
| `profile_url` | only if present in the sources |

**Code decides status:**

- `verified`: exactly one candidate matches the name; employer matches the claimed company by domain or name match; `current`; dated source within the verification freshness window.
- `mismatch`: one strongly matching person (name plus role, or a supplied profile URL) is `current` at a different employer with dated evidence.
- `uncertain`: everything else (multiple plausible candidates, undated evidence, former only).
- `failed`: the call or parse did not complete after retries.

Fuzzy name matching compares company names only; it is never proof of employment.

**`identity_state` (code-derived, never shown to the model):** `established` when exactly one candidate matches the name and the claimed company or a supplied profile URL; `ambiguous` when two or more plausible candidates; otherwise `unknown`.

**Stored:** candidate list and evidence on the `verifications` row; both call ids; `attribution_precision`.

### 5.4 Call 2: Company research (grounded, per theme)

**Input:** company display name, domain, theme, and theme query guidance from config. No seller profile and no prospect, which is what makes research shareable. Themes (config): funding and growth, expansion and new markets, AP and finance hiring, ERP and finance transformation, executive statements. Person-level themes add the prospect and run only when employment is effectively confirmed.

**Output:** free text in a fixed layout of dated findings, each naming its source. "No relevant findings" is a valid, explicit answer. The prompt forbids filling gaps from background knowledge.

**Code stores:** raw text, grounding chunks (redirect URL plus resolved URL, resolved once with a timeout, falling back to the redirect), grounding supports, search queries run, `fetched_at`, `expires_at`.

**Failure behaviour:** a record with zero findings is a successful stage, stored with the theme TTL so empty searches are not repeated every run. Only API errors fail the stage.

### 5.5 Call 3: Signal extraction (structured, no search, per research record)

Cheapest model tier. **Input:** raw text and grounding chunks with indices.

| Field | Notes |
| --- | --- |
| `claim` | one neutral factual statement |
| `signal_type` | enum: funding, expansion, ap\_hiring, erp\_transformation, exec\_statement, growth, other |
| `scope` | enum: company, person |
| `event_date`, `date_precision` | as stated or unknown |
| `source_chunk_index` | supporting chunk |
| `evidence_quote` | exact text from raw text |
| `sensitivity_category` | closed enum including `none` |

Sensitivity enum covers **blocked** categories (health, bereavement, family, personal legal) and **tone-review** categories (layoffs, restructuring, executive departure, company lawsuit, breach).

**Code validation per signal:** quote found in raw text and within the chunk's supported span (shared validator); chunk index exists; date parses and is plausible; duplicates merged; **keyword backstop** over claim and quote upgrades categories the model labelled `none`; effective sensitivity by `SENSITIVITY_ORDER`. The keyword backstop is not a complete detector: the model label, backstop and config policy are three separate safeguards. A keyword test file includes false positives (for example "family-owned business" must not block).

Invalid signals are stored as rejected with a reason: `unverifiable_source`, `unparseable_date`, `blocked_category`, `duplicate`. The call fails only on schema errors that survive the repair attempt. Each decision emits a `signal_decision` event naming the layer that flagged sensitivity.

### 5.6 Call 4: Relevance scoring (structured, no search)

**Input:** valid signals `{signal_id, claim, type, scope}`; scoring-relevant profile fields; designation **only when `person_specific`**.

**Output per signal id:** `specificity` (int 1 to 5), `persona_fit` (int 1 to 5 or null), `persona_fit_reason` (required when null), `offer_fit` (int 1 to 5), a one-line rationale per factor, `potential_implication` (one sentence, framed as a possibility).

**Deliberately absent:** recency, total, rank, chosen signal.

**Code validation:** returned ids exactly match the input set; integers in range; `persona_fit` null rejected when `person_specific` is true and an integer rejected when false. Missing signals trigger the repair attempt. Ranking, penalties, thresholds, strength and the missing-factor rule are in Section 4.7.

**Stored:** AI factor scores in `hook_selections.scored_signals`, plus code-computed ranking, outcome and rejection reason per signal.

### 5.7 Call 5: Draft generation (structured, no search)

**Input:** chosen signal (claim, type, date, evidence quote); draft-relevant profile fields (product, value prop, tone rules, approved claims, banned claims); recipient first name; `person_specific`; `identity_state`; designation only when `person_specific`; tone constraints; requested channels.

**Output per channel:** `subject` (email only), `body`, `signal_id_used`. No self-reported claim list.

**Hard constraints enforced in code after generation:** word-count cap; no links; exactly one question as the call to action; no banned phrases or claims; greeting rule (below); when `person_specific` is false, no mention of the recipient's role, title or employer and no phrasing assuming team membership.

**Greeting rule:** `identity_state = established` allows a first-name greeting. `ambiguous` or `unknown` requires a neutral greeting ("Hello,") and no recipient name anywhere in the text.

**Generic fallback** is a mode of this call, triggered only by an SDR click. It receives no signal. Its persona comes from an SDR-selected persona in the seller profile's list, never from the claimed designation (when `person_specific` is true, the verified designation may be the default). Stored with `is_generic_fallback = true`, `origin = fallback`.

**Failure:** a constraint violation gets one regeneration with the violations listed; if it still fails the draft is stored with `constraint_failed` and approval is blocked. **I6:** the query that builds this call's input reads valid signals only; tests assert it on the recorded request payload.

### 5.8 Call 6: Grounding assessment (structured, no search)

**Input:** final draft text (generated or edited); referenced signals `{id, claim, evidence quote, source}`; `person_specific`; seller approved claims and banned claims.

**Output:** sentence-level items that together cover the whole draft:

| Field | Notes |
| --- | --- |
| `text_span` | exact substring of the draft |
| `kind` | enum: greeting, closing, call\_to\_action\_question, claim |
| `claim_type` | fact, inference, hypothesis, seller\_claim (for claims) |
| `subject` | enum: company, recipient, seller, general |
| `claim_source` | enum: signal, seller\_profile, none |
| `signal_id` | or null |
| `supporting_quote` | exact text from that signal's evidence or from the approved block, or null |
| `support_level` | enum: supported, partial, unsupported |
| `hedged` | boolean |

**Why full coverage:** code checks that the spans reconstruct the draft, so the model cannot skip the offending sentence.

**Deterministic rules on returned items:**

| Subject | Must be supported by | Fails when |
| --- | --- | --- |
| Company or recipient fact | A valid signal and a verified quote | No valid signal, quote not found or not in that signal's evidence, or `partial`/`unsupported` |
| Seller claim | The approved claims block and a verified quote | No match, matches a banned claim, or contains an unapproved number (a profile with no approved numerics fails any number) |
| Hypothesis | n/a | Not hedged, or not phrased as a question |
| Inference | n/a | Presented as fact |
| Recipient claim when `person_specific` false | n/a | Always |
| Spans do not cover the draft, or unknown kinds | n/a | Assessment invalid: one repair attempt |

The fact/inference/hypothesis distinction: **fact** is directly supported by the source; **inference** is a plausible interpretation; **hypothesis** is a potential problem to explore. The email may use facts and cautious hypotheses and never presents an inference as fact.

**Stored:** a `grounding_checks` row linked to the draft version: full item list, rule results, evidence and profile hashes checked against, overall `passed` or `failed` computed by code. **No manual override** (I7). A human fixes a failure by editing or removing the claim, which creates a new draft version and a new check.

### 5.9 Fixture behaviour

- Fixture mode is implemented inside the Gemini wrapper. Parsing, validators, gate, events, database writes and UI run for real; only the model response is recorded.
- Each bundle stores `fixture_id`, `call_type`, `schema_version`, `prompt_version`, `input_key`, `model_response`, `created_at`. Lookup key: `(fixture_id, call_type, input_key)`, so the same prospect gets a different response after its record is corrected (B2).
- On load the wrapper compares versions with current contracts and throws `FixtureIncompatibleError` on mismatch. Fixtures are never adapted silently.
- The prospect stores `fixture_id`; the badge "Fixture-backed demo data" shows on the prospect row, prospect page, and run header (I15).
- **Two fixture classes, kept in separate directories:** `fixtures/live-recorded/` (A and C backups) and `fixtures/hand-authored/` (B, D, E, edit). The re-record script writes only to `live-recorded/`, takes an explicit target list and a version tag, and refuses to touch `hand-authored/`. Hand-authored fixtures change only by deliberate edit with a changelog entry.
- Freeze prompt versions before recording. Bumping a prompt version afterwards breaks fixtures by design.

### 5.10 Call budget

First run for a new company, no retries: verify 2, research 5, extraction 5, scoring 1, draft 1 (email and LinkedIn together), grounding 1 to 2, about **15 to 16**. Expect 17 to 20 with retries. A tone-rule change re-runs only draft and grounding (2 to 3 calls). Research themes run sequentially by default.

---

## 6. API and SSE contracts

### 6.1 Conventions

- Prefix `/api/*`. JSON only, except `POST /api/imports` (`multipart/form-data`, exactly one CSV file field, extra fields rejected; file-level checks for size, row cap, encoding, headers run before Zod sees parsed rows).
- Every body, query and path parameter is parsed by Zod in `schemas/api/`; unknown fields are rejected.
- Error envelope: `{ error: { code, message, details? } }`. Codes (closed): `validation_failed`, `unauthenticated`, `not_found`, `conflict`, `gate_blocked`, `rate_limited`, `quota_exhausted`, `upstream_failed`.
- Gate failures: 409 `gate_blocked` with `details.reasons[]` exactly as returned by `approvalGate`.
- Actor in the audit log is the session identity plus the display name given at login.

### 6.2 Idempotency and quota

**Idempotency (persistent).** Table keyed on `(session_id, route, key)` storing payload hash, response status and body, state, and `expires_at` (10 minutes). Required on run-starting routes and on `gmail-draft`. Same key and same payload returns the original response; same key with a different payload returns 409 `conflict`; new key processes normally. Concurrent duplicates are settled by a unique insert: the loser waits for or reads the winner's result. No two runs or two Gmail drafts may result.

**Quota (atomic).** Before every Gemini attempt the wrapper calls an RPC that increments the day's counter only if below the cap and returns allowed or denied. Retries each reserve a slot. The pre-run check is a fast rejection only. Mid-run denial fails the stage with `quota_exhausted` and an explicit reason.

### 6.3 Routes

**Session and config**

| Route | Purpose |
| --- | --- |
| `POST /api/session`, `DELETE /api/session` | Login, logout |
| `GET /api/profile` | Active seller profile |
| `POST /api/profile` | Create a new version (approved-claims block required), flip pointer, audit |
| `GET /api/profile/versions` | History |

**Prospects and imports**

| Route | Purpose |
| --- | --- |
| `GET /api/prospects` | List with filters (status fields, search, needs-attention), cursor pagination |
| `POST /api/prospects` | Manual add; same validation and dedupe as import |
| `GET /api/prospects/:id` | Record plus current verification, hook selection, latest draft, attention label, staleness flags |
| `PATCH /api/prospects/:id` | Correct fields; audit `prospect_corrected`; changes fingerprints, starts nothing |
| `POST /api/prospects/:id/archive` | Soft delete |
| `POST /api/imports`, `GET /api/imports/:id` | CSV upload and per-row report |

**Runs**

| Route | Purpose |
| --- | --- |
| `POST /api/prospects/:id/runs` | Body `{ trigger }`. Computes plan in the run-creation transaction; returns `202 { run_id, plan }`, or 409 `conflict` with the active `run_id` |
| `GET /api/runs/:id` | Summary, all `run_stages` rows, `continued_by_run_id` |
| `GET /api/runs/:id/events` | SSE stream; with `Accept: application/json` and `?after=<id>` returns a JSON page |
| `POST /api/runs/:id/retry` | Only for `failed` or `interrupted` runs; creates a new run linked by `resumed_from_run_id` |
| `GET /api/prospects/:id/runs` | Run history |

There is no pause or cancel route in v1.

**Resolutions (never start runs)**

| Route | Rule |
| --- | --- |
| `POST /api/prospects/:id/resolve-company` | `{ action: confirm_existing, company_id }` or `{ action: create_new }`; the selected company must exist and be a valid candidate; audit |
| `POST /api/prospects/:id/select-candidate` | `{ candidate_index, verification_id, fingerprint }`; index must refer to the current verification; writes identity fields only |
| `POST /api/prospects/:id/confirm-employment` | `{ note, verification_id, fingerprint }`; note required; allowed only if current verification is `uncertain`; attaches to that exact row; 409 on `mismatch`; audit |

**Drafts and review**

| Route | Rule |
| --- | --- |
| `GET /api/drafts/:id` | Content, claims from latest grounding check, gate result |
| `POST /api/prospects/:id/drafts/regenerate` | Starts run with `trigger: regenerate` |
| `POST /api/prospects/:id/drafts/fallback` | `{ persona }` from the profile's persona list; trigger `fallback` |
| `POST /api/drafts/:id/edit` | `{ subject?, body }`; new immutable draft version, run with trigger `edit`; never overwrites. Returns new draft and `run_id` |
| `POST /api/drafts/:id/tone-ack` | Valid only when `requires_tone_ack` |
| `POST /api/drafts/:id/approve` | Body carries the version ids checked; runs `approvalGate`; persists only if those versions are still current at commit (transaction or optimistic version check) |
| `POST /api/drafts/:id/reject` | `{ reason }` |
| `POST /api/drafts/:id/gmail-draft` | Idempotency key required; rechecks the gate immediately before the Gmail call; never sends. On Gmail failure returns `upstream_failed` with `details.fallback` (copy payload); never a 200 |

Edit, regenerate and fallback pass through the one-active-run constraint; during an active run they return `conflict`.

**Gmail OAuth and ops**

| Route | Purpose |
| --- | --- |
| `GET /api/gmail/status`, `GET /api/gmail/connect`, `/callback`, `DELETE /api/gmail` | Status, OAuth flow with one-time `state`, minimum scope, disconnect |
| `GET /api/stats` | Status-field counts, needs-attention queue, average research time, approval rate, Gemini calls vs cap |
| `GET /healthz` | Unauthenticated, no data, for warm-up |

### 6.4 SSE format

- Standard SSE: `id: <run_events.id>`, `event: <type>`, `data: <envelope JSON>`. Heartbeat comment `: ping` every 15 seconds. `Cache-Control: no-cache`, proxy buffering disabled, `retry: 3000`.
- **Envelope:** `{ id, run_id, prospect_id, seq, stage_key | null, type, level, message, payload, at }`. `level` is info, warn, error. `message` is shown in the live view; `payload` drives widgets.

| Event type | When |
| --- | --- |
| `run_started` | First event: trigger, profile version, resumed-from |
| `plan` | The stored plan: each stage\_key `fresh`, `stale`, `expired`, `blocked`, or `missing`, with reason |
| `stage_started` | Stage begins; attempt number |
| `stage_progress` | Within a stage (for example theme 2 of 5) |
| `stage_finished` | After the atomic commit: outcome (`complete`, `skipped_unchanged`, `refreshed_expired`, `blocked`), output ids, counts |
| `stage_failed` | Retries exhausted; error code; retryable flag |
| `signal_decision` | Per signal: accepted or rejected, reason, layer that flagged sensitivity |
| `gate_decision` | A stage blocked by policy; rule in plain words |
| `needs_input` | Run ends awaiting a human: reason enum and action to offer |
| `run_finished` | Always the last event: final status, duration, call count |

### 6.5 Ordering, cursor and handler loop

- Each run has a per-run serialized event writer that awaits each insert before the next. `seq` (per run) orders and detects gaps; global `id` drives SSE replay. A global bigserial alone does not guarantee commit order across concurrent transactions.
- **Cursor precedence:** `Last-Event-ID`, then `?after`, then 0.
- **Handler loop:** (1) subscribe to the in-process notifier; (2) query events after the cursor; (3) send them in order; (4) wait for a wake-up or heartbeat; (5) query again; repeat. The notifier carries no data; the handler always re-queries.
- **Terminal race:** after draining, re-read the current run status and check for newer events before closing. Close only if the run is terminal and no newer events exist. `run_finished` is always last, whatever the outcome (`completed`, `needs_input`, `failed`, `interrupted`); the `interrupted` one is written by boot recovery.
- Events are written after the transaction they describe commits.

### 6.6 Reconnect and recovery

1. EventSource reconnects automatically with `Last-Event-ID`; the server replays then tails.
2. Fresh page load: fetch `GET /api/runs/:id` for the stage snapshot, then open the stream from 0 to rebuild the log. The stage table is the snapshot and events are the narrative; if they disagree the stage table wins.
3. A terminal run replays all events including `run_finished`, then the response ends.
4. Server restart mid-run: the stream drops; on boot the run is marked `interrupted`, `run_finished (interrupted)` is written, and a recovery run starts. The UI follows `continued_by_run_id`.
5. `heartbeat_at` powers an informational "no activity for N seconds" indicator; no automatic action.

### 6.7 Stage status vs event outcome

| Situation | `run_stages.status` | Event outcome |
| --- | --- | --- |
| Fresh output reused | `skipped_unchanged` | `skipped_unchanged` |
| Expired output refreshed | `complete` | `refreshed_expired` |
| New output generated | `complete` | `complete` |
| Policy prevents execution | `blocked` | `blocked` |
| Retries exhausted | `failed` | `stage_failed` |

The plan describes what should happen; stage events describe what happened. The two stay distinct and visually distinct (skipped-unchanged versus refreshed-expired is the idempotency demo).

### 6.8 How the UI handles each outcome

| Final run status | UI behaviour |
| --- | --- |
| `completed` | Open Review; show the attention label |
| `needs_input` | Resolution panel keyed by reason: `confirm_company`, `correct_record`; no approve controls |
| `failed` | Show failed stage, code, message, **Retry**; show reused work as preserved |
| `interrupted` | "Server restarted"; follow `continued_by_run_id`; manual retry only if no recovery run exists |
| in progress | Disable run, edit, regenerate, fallback for that prospect; link to the live view |

---

## 7. Demo and test plan

### 7.1 Principles

- **Two kinds of demo input.** *Live-research* cases (A, C) use real Gemini calls and are validated in the Day 2 spike, with recorded backups. *Fixture-driven* cases (B, D, E, edit) exist to prove deterministic rules, so they use recorded responses and never depend on Gemini making a particular mistake.
- **Real vs fictional.** A: a real public executive and company, using only public professional information. C: a real small company if one reliably returns zero findings, otherwise a fictional recorded fallback. B, D, E: entirely fictional people and companies, so no real person is presented as a mismatch or a sensitive event. The edit test reuses A's draft with a deliberately synthetic unsupported claim.
- **Fixtures follow Section 5.9** (versioned, incompatibility errors, badge, separate live-recorded and hand-authored directories).

### 7.2 Prospects

**A: Verified, strong signal, personalised draft (live).** Selection: a public finance leader (CFO, VP Finance or similar) at a mid-market or larger company with several recent dated signals (funding, expansion, finance hiring, ERP). Validate on Day 2: verification returns exactly one current, dated candidate; at least three valid signals survive extraction; the top signal is plausibly relevant to AP. Expected: `verified`, `person_specific = true`, strength strong or moderate, draft in review, grounding passed, approvable. Record the full responses of a good run as a replay backup and regression test.

**B: Uncertain employment (fixture, two checkpoints).**

- *B1, before resolution:* two plausible candidates for the same name at similar companies, one with an older source. Expected: `uncertain`, `identity_state = ambiguous`, company research proceeds from a recorded bundle, `persona_fit = null` with a reason, strength capped at `moderate` with `persona_unassessed = true`, neutral greeting, no role or employer mention, `person_specific = false`, draft generated automatically, approval blocked.
- *B2, after resolution:* SDR calls `select-candidate` (identity fields only; no status change), then a re-run re-verifies against a second recorded verification bundle keyed to the corrected identity fields, returning one current dated candidate. Expected: `verified`, `person_specific` flips true, the scoring fingerprint changed so scoring re-ran with `persona_fit` assessed, the draft regenerated, the B1 draft preserved as an older stale version, company research reused (`skipped_unchanged`). If instead verification stays `uncertain`, the SDR must separately `confirm-employment` with a note.

**C: Insufficient evidence (live preferred, fixture fallback).** Small private company with little public footprint. Expected: research records exist with zero findings and a TTL; strength `insufficient`; `research_status = insufficient_evidence`; draft stage `blocked`; UI offers "Generate generic fallback" with a persona dropdown. A second run shows zero-finding records reused, not re-searched. *C fallback:* SDR-selected persona, no signal, draft labelled generic.

**D: Sensitive signals (fixture, from one stored research record).**

- *D1, backstop catch:* the model labelled a signal `none`, but its claim text contains a blocked-topic phrase. The backstop upgrades it to `blocked`; the `signal_decision` event names the layer; the signal is stored as rejected (`blocked_category`), is visible in the Signal analysis tab, and never reaches Call 5.
- *D2, tone review:* a layoff or restructuring signal is valid but carries the penalty. The fixture includes a recorded scoring response in which the restructuring signal receives the highest valid factor scores, with a winning margin large enough to survive the penalty, so the test proves selection under penalty, not luck. Expected: effective sensitivity `tone_review_required`, selected hook carries tone constraints, draft written with neutral and respectful framing, `requires_tone_ack = true`, approval fails before `tone-ack` and succeeds after (all other gates passing).
- *D false positive:* a signal mentioning "family-owned" must pass, not be blocked.

**E: Mismatch (fixture).** Verification shows the person current at a different employer with a dated source. Expected: `mismatch`; run ends after stage 1 as `needs_input` (`correct_record`); no person-level research, scoring or draft; `confirm-employment` returns 409. Only path forward: `PATCH` the employer, then a new run re-verifies (with a fixture for the new employer) and reaches `verified`. New company research is created fresh; research for the old company is untouched.

**Edit test: unsupported claim (fixture).** Edit A's draft to add "I noticed your AP team is struggling with manual invoice processing." A recorded grounding assessment classifies that sentence as a fact without a valid signal, so the rules fire deterministically. Asserts: the original draft row is byte-identical afterwards; a new draft version exists with trigger `edit`; the old approval cannot authorise the new version; the latest grounding check is `failed`; `approve` and `gmail-draft` each independently return `gate_blocked`. *Edit correction:* remove the sentence, edit again; a new grounding check passes and approval is possible.

### 7.3 Acceptance matrix (authoritative)

| Case | Core assertion | Expected final state | Test type |
| --- | --- | --- | --- |
| A | Real research, valid signals, grounded draft | Completed, approvable | Live spike, then recorded replay as regression |
| B1 | Ambiguous identity, company-level processing | Completed, approval blocked | Fixture pipeline |
| B2 | Candidate resolution, re-verification, scoring invalidation | Completed, approvable if verified | Fixture pipeline |
| C | Zero findings cached and reused | Completed, insufficient evidence | Live preferred; fixture fallback |
| C fallback | SDR-selected persona, no signal | Generic draft, separately labelled | Fixture pipeline |
| D1 | Keyword backstop catches blocked signal | Signal rejected, excluded from drafting | Fixture pipeline |
| D2 | Tone-review signal selected | Approval blocked until acknowledgement | Fixture pipeline |
| D false positive | "Family-owned" business | Signal not blocked | Fixture pipeline and keyword unit test |
| E | Contradictory employment evidence | Needs input, no person-specific processing | Fixture pipeline |
| Edit | Unsupported claim in edited draft | Grounding failed; approve and Gmail blocked | Fixture pipeline |
| Edit correction | Unsupported sentence removed | Grounding passes, approval possible | Fixture pipeline |
| Pure validators | `quoteWithinSupportedSpan`, `approvalGate`, `SENSITIVITY_ORDER`, keyword backstop, claim rules, scoring math, freshness | Per-rule cases | Unit tests, no pipeline; run first |

**Five assertions for every row:** (1) the `plan` event; (2) the `run_stages` rows and outcomes; (3) records created (verifications, research\_records, signals, hook\_selections, drafts, grounding\_checks); (4) final run status and attention label; (5) the `approvalGate` result with reasons.

**Across all fixture tests:** no rejected or blocked signal may appear in Call 5's input, asserted on the recorded request payload (I6).

### 7.4 Demo video order (5 minutes)

| Time | Content |
| --- | --- |
| 0:00 to 0:30 | SDR problem, seller profile |
| 0:30 to 1:00 | Add prospect A, start research |
| 1:00 to 2:00 | Live run view, sources, signal selection |
| 2:00 to 3:00 | Draft and its evidence |
| 3:00 to 3:45 | B: uncertainty, non-personalised draft, blocked approval |
| 3:45 to 4:30 | Edit test: unsupported claim detected, approval revoked |
| 4:30 to 5:00 | Gmail draft (or copy fallback) and run history; C, D, E shown briefly in the dashboard or test report |

C, D and E stay in the live-interview set. The strongest moment is the system rejecting a bad assumption before it reaches the recipient.

---

## 8. Decision changelog

Every amendment from Steps 1 to 6 with its reason. New entries are appended; existing entries are never edited. Format: ID, step, change, reason.

### Step 1: Process map and scope

| ID | Change | Reason |
| --- | --- | --- |
| C01 | Chose PS-3 (personalised outreach) | Open-ended; rewards judgment over volume |
| C02 | Kept all four edge cases; decided to build them as product behaviours | Edge cases are graded; mapping each to a stage keeps them deliberate |
| C03 | Stack: Node, Express, Gemini with search grounding, Supabase | Candidate's choice; Supabase persists history across redeploys |
| C04 | Humans approve before anything leaves; no auto-send | Case requires human in the loop; limits damage |
| C05 | Company-level signals are potential opportunities, never confirmed pain points | Avoids assuming a problem exists |
| C06 | Seller profile is configurable with one seeded AP-automation demo company | Signals need an offer to be judged against |
| C07 | CSV only; Excel as a next step | Fewer dependencies |
| C08 | Gmail creates drafts, never sends; copy-draft fallback built early | OAuth in testing mode is fragile; keep the demo complete without it |
| C09 | Bulk processing demoted to P1 and first cut; concurrency 2 to 3 retained as design | One-prospect workflow proves the logic |
| C10 | Statuses are independent fields, not one linear chain | Dashboard counts stay simple; stages stay meaningful |

### Step 2: Architecture

| ID | Change | Reason |
| --- | --- | --- |
| C11 | One Node process, no worker or queue | Take-home scope; resumability absorbs restarts |
| C12 | Plain JavaScript with ES modules and Zod; validate API input as well as Gemini output | No build friction; boundaries are where mistakes enter |
| C13 | Database-first events with SSE as delivery only | Browser disconnects must not affect runs |
| C14 | One active run per prospect enforced in the database | Prevents double-clicks and racing regenerate |
| C15 | Validators pure and separate from the model | Demos target deterministic rules |
| C16 | Single server-side `approvalGate` | UI must never decide safety |
| C17 | Shared demo password session, rate limits, daily Gemini cap | Public URL could drain quota |
| C18 | Idempotent, resumable `runPipeline`; UI receives stage events from Day 2 | Regenerate, resume and re-verify without extra flows; UI is graded |

### Step 3: Schema

| ID | Change | Reason |
| --- | --- | --- |
| C19 | Versioned outputs with fingerprint and `superseded_at` instead of overwriting | Staleness becomes one comparison; history preserved |
| C20 | Added `companies`; research belongs to a company | Twenty prospects at one company cost one research pass |
| C21 | Company resolution by domain and confirmation, not name alone | Name matching could share research between unrelated businesses |
| C22 | Seller profile content immutable; active selection is a pointer in `seller_profile_settings` | Profile versions stay historical |
| C23 | Re-ground every edited draft; edits create new versions | Edits could introduce unsupported claims |
| C24 | Fingerprint uniqueness scoped to entity and stage | Global uniqueness could collide across entities |
| C25 | Transactions via Postgres RPC, not multiple client calls | Atomicity must be real |
| C26 | Research expiry (TTL) checked explicitly; `refreshed_expired` never reported as `skipped_unchanged` | Web facts age even when inputs do not |
| C27 | Added `verification_status`; verification failure does not touch `research_status` | Each stage's status must describe that stage |
| C28 | A run needing input ends as `needs_input`; no pause-and-resume machinery | A new run plus fingerprints gives the same result |
| C29 | `stage_key` (for example `research:funding`) in `run_stages` instead of one row per stage per run | Supports per-theme and per-record fan-out |

### Step 4: Pipeline

| ID | Change | Reason |
| --- | --- | --- |
| C30 | Fingerprint dependency matrix; stages depend on derived facts, not upstream row ids | Early cutoff; tone change must not repeat research |
| C31 | Config applied in code (weights, thresholds, tiers, sensitivity lists) is not a fingerprint input | Config changes cost zero Gemini calls |
| C32 | Human-touched drafts get a stale banner, never an auto-overwrite | Preserve human work |
| C33 | Grounding is its own stage and table; one extraction path for generated and edited drafts; the draft call returns no claims | Model's self-reported claims are never trusted |
| C34 | Verification API failure ends the run as `failed`, not `uncertain` | A failed call is not evidence |
| C35 | Uncertain verification: company research and a non-person-specific draft proceed; approval gated; SDR may confirm with note; mismatch has no override | Useful work continues without asserting unverified facts |
| C36 | Gate checks hook selection currency, signal validity, evidence hashes; stale approvals cannot create Gmail drafts | Preserving a draft is not preserving permission to use it |
| C37 | Freshness tiers by signal type, not a single 12-month cutoff | Different signals age differently |
| C38 | Sensitivity split into `blocked` (filtered in code before drafting) and `tone_review_required` (acknowledgement) | A checkbox cannot protect against blocked topics |

### Step 5: Gemini contracts

| ID | Change | Reason |
| --- | --- | --- |
| C39 | Six calls; observations from the model, verdicts from code | Deterministic safety |
| C40 | Two-step grounded call then structured parse | More reliable than JSON in grounded text; merge only if spike proves safe |
| C41 | Extraction per research record | Resumability and failure isolation |
| C42 | Evidence is the grounded summary, not page text; accepted and stated openly | Scope; page fetching is a next step |
| C43 | Shared `quoteWithinSupportedSpan` (Calls 1 and 3) | Prevents mismatched attribution inside retrieved evidence |
| C44 | Scoring: `persona_fit` null when unverified; weights renormalised; strength capped at moderate; `persona_unassessed` recorded | An unverified designation must not influence scoring as fact |
| C45 | Draft greeting depends on `identity_state`; fallback persona only from SDR selection | Ambiguous identity could mean the wrong first name |
| C46 | `approved_claims` block required in the seller profile; grounding items carry `claim_source`; seller claims checked against the profile | Legitimate seller claims need a source other than prospect signals |
| C47 | Three sensitivity layers logged independently; most restrictive wins; `SENSITIVITY_ORDER` constant | Defence in depth; model never arbitrates |
| C48 | Moderate strength with unconfirmed employment still produces a draft; approval remains gated | Do not discard company-level work |

### Step 6: API, SSE and demo

| ID | Change | Reason |
| --- | --- | --- |
| C49 | CSV upload is the one multipart exception | Contradiction in the JSON-only rule |
| C50 | Trigger vocabulary: manual, reverify, regenerate, fallback, edit, recovery, each with defined stages | Explains why every run happened |
| C51 | Plan computed in the run-creation transaction, stored, returned and emitted | Response and event cannot disagree |
| C52 | Persistent idempotency table; required on run-starting and Gmail routes | External side effects need deduplication |
| C53 | Origin check on all state-changing requests | Stronger CSRF protection without tokens |
| C54 | Atomic quota reservation before every Gemini attempt | Check-then-act could exceed the cap |
| C55 | Per-run `seq` alongside global event id; subscribe-then-query handler; terminal-race check | Global ids do not guarantee commit order; avoid missed final event |
| C56 | Version-bound human actions (verification id and fingerprint; draft, grounding and hook ids) | A decision must not apply to later state |
| C57 | Resolutions never start runs | Auditable decision separate from computation |
| C58 | No pause or cancel in v1; in-memory rate limiting accepted | Short runs; bounded retries and DB quota contain risk |
| C59 | Fixture mode in the Gemini wrapper with versioned bundles, `FixtureIncompatibleError`, visible badge | Real pipeline, deterministic model |
| C60 | `select-candidate` resolves identity only and never sets verified | A human's identity choice is not proof of employment |
| C61 | B split into two checkpoints with two verification fixtures | Tests the actual dependency graph |
| C62 | D2 scoring fixture authored so the restructuring signal wins under the penalty | Selection must not depend on luck |
| C63 | Edit test asserts versioning and approval invalidation explicitly | Strongest demonstration of the approval architecture |
| C64 | Span fallback `attribution_precision: coarse` with UI label "source-level attribution" | Do not imply precision the evidence lacks |
| C65 | Live-recorded and hand-authored fixtures in separate directories; re-record script cannot overwrite hand-authored | Prevent silent loss of authored fixtures |

### Consolidation (this document)

| ID | Change | Reason |
| --- | --- | --- |
| C66 | Stated the draft-currency gate rule precisely: authorization-affecting staleness blocks approval and Gmail creation; cosmetic staleness (tone rules only) shows a banner and does not block | Earlier text said stale approvals lose Gmail permission without defining which staleness counts; **flagged for review** |
| C67 | Added `fixture_id` to `prospects`, `grounding_checks` and `gemini_quota`, `idempotency_keys` to the table list | Previously implied by decisions; every table must now exist in the schema |
| C68 | Added numbered invariants I1 to I16 | Tests and review reference them |

---

## 9. Implementation sequence

No code until this document has been reviewed against the frozen decisions.

### 9.1 Before code

1. Review this document for contradictions and missing constraints (checklist in Appendix B).
2. Freeze the final schema and migration order.

### 9.2 Build order

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 1. Migrations | All tables, partial unique indexes, scoped fingerprint constraints, seeded profile | Constraint tests: second active run rejected; two current rows rejected; duplicate fingerprint returns existing; duplicate prospect rejected |
| 2. Atomic RPCs | `commit_stage_output` (insert or return existing, supersede, complete stage row), `reserve_gemini_call`, `create_run_with_plan`, `approve_draft_versioned`, idempotency claim | Concurrency tests: simultaneous quota reservations never exceed cap; simultaneous run creation yields one run; failed commit leaves no current output |
| 3. Validators | Pure functions in `validators/` with unit tests first | Every rule in 5.2 to 5.8 and 4.7 and 4.8 has passing cases, including keyword false positives |
| 4. Gemini wrapper | Grounded and structured calls, retry, repair, call log, quota, fixture mode with version checks | Spike results recorded (Appendix B); fixture mismatch throws |
| 5. Events and runner | Per-run serialized writer, notifier, SSE handler, boot recovery | Disconnect and reconnect replay without gaps; terminal race test; crash test resumes |
| 6. Prospect A end to end | Bare prospect table, run view, review screen, A through stage 6 | A runs live, reaches an approvable draft, events visible in the UI |
| 7. Deterministic branches | B1, B2, D1, D2, D false positive, E, C, edit, one at a time | Acceptance matrix rows pass with all five assertions |
| 8. Gmail and dashboard | Gmail OAuth start earlier (consent screen, test users) with coding last; copy-draft fallback earlier; compact dashboard; optional bulk loop | Gmail draft created from an approved draft; failure returns `upstream_failed` with fallback |
| 9. Rehearsal | Full five-minute run; TTL override set; re-authenticate Gmail; warm the host | Repeatable demo with no manual database intervention |

### 9.3 Mapping to the seven-day timeline

Days 2 to 6 of the take-home: Day 2 foundation, migrations, RPCs, wrapper spikes and bare UI with events; Day 3 verification, extraction, scoring and sensitivity; Day 4 drafting, grounding and review UI; Day 5 branches, prospect table, run view and dashboard; Day 6 Gmail, tests, rehearsal. Test each stage the day it is built. Submit something that runs, even if imperfect; use the cut list in 1.6 when time is short.

### 9.4 Working rules

- Implementation notes go in Appendix D. A forced contract change requires a changelog entry and updated acceptance tests in the same commit.
- Prompt versions are frozen before recording fixtures.
- Never overwrite hand-authored fixtures with the re-record script.

---

## Appendix A: Schema detail (normative)

Types are indicative (Postgres). `id` is uuid unless stated. All tables carry `created_at timestamptz default now()` unless noted. Derived tables carry `input_fingerprint text not null`, `stage_version text not null`, `superseded_at timestamptz null`.

### A.1 Tables

**seller\_profiles** (immutable): `version int unique`, `product jsonb`, `value_props jsonb`, `icp jsonb`, `personas jsonb` (list used by the fallback dropdown), `tone_rules jsonb`, `approved_claims jsonb` (required: product descriptions, value propositions, numeric claims, may be empty list), `banned_claims jsonb`, `created_by`. Scoring-relevant hash covers product, value\_props, icp, personas. Draft-relevant hash covers product, value\_props, tone\_rules, approved\_claims, banned\_claims.

**seller\_profile\_settings**: single row; `active_profile_id` references `seller_profiles`.

**companies**: `display_name`, `name_normalized`, `domain` nullable, `canonical_website` nullable. Unique on `domain` where not null. Normalised name is indexed, not unique: it suggests matches and never auto-merges ambiguous companies.

**imports**: `filename`, `accepted int`, `duplicates int`, `invalid int`, `row_report jsonb`, `uploaded_by`.

**prospects**: `full_name`, `company_claimed`, `designation`, `email`, `linkedin_url`, normalised copies (`name_normalized`, `company_normalized`, `email_normalized`), `dedupe_key` (`name|company`), `source` (manual, csv), `import_id` nullable, `company_id` nullable (set by resolveCompany), `company_resolution jsonb`, `fixture_id` nullable, `verification_status`, `research_status`, `draft_status`, `archived_at`. Unique index on `email_normalized` and on `dedupe_key`, each where `archived_at is null`. Statuses are caches written only by `recomputeProspectStatus` inside the commit RPC.

**verifications** (derived; scope prospect): `prospect_id`, `status` (verified, uncertain, mismatch, failed), `identity_state` (established, ambiguous, unknown), `claimed_company`, `discovered_company`, `claimed_role`, `discovered_role`, `candidates jsonb`, `evidence jsonb` (source URL, date, quote, `attribution_precision`), `grounded_call_id`, `parse_call_id`, `confirmation jsonb` nullable (`note`, `confirmed_by`, `confirmed_at`), `expires_at`. Partial unique current index on `(prospect_id)` where `superseded_at is null`. Unique `(prospect_id, input_fingerprint)`. The confirmation lives on this row so it cannot outlive its facts. An effective employment state is `verified`, or `uncertain` with a confirmation.

**research\_records** (derived; scope company or person): `company_id`, `prospect_id` nullable (set only for person-level), `theme`, `raw_text`, `sources jsonb` (chunks: redirect URL, resolved URL, title), `supports jsonb`, `search_queries jsonb`, `finding_count int` (0 allowed), `attribution_precision`, `gemini_call_id`, `fetched_at`, `expires_at`, `content_hash`. Unique `(company_id, theme, input_fingerprint)` for company-level and `(prospect_id, theme, input_fingerprint)` for person-level. Partial unique current index on `(company_id, theme)` where prospect null and not superseded, and on `(prospect_id, theme)` where prospect not null.

**signals** (derived; scope research record): `research_record_id`, `company_id`, `prospect_id` nullable, `claim`, `signal_type`, `scope`, `event_date`, `date_precision`, `source_url`, `source_chunk_index`, `evidence_quote`, `attribution_precision`, `sensitivity_model`, `sensitivity_keyword`, `sensitivity_policy`, `sensitivity_effective` (none, tone\_review\_required, blocked), `sensitivity_category`, `status` (valid, rejected), `rejection_reason` (unverifiable\_source, unparseable\_date, blocked\_category, duplicate), `content_hash`. Rejected and blocked signals are stored. Unique `(research_record_id, content_hash)`. Status changes are lifecycle changes and each emits an event.

**hook\_selections** (derived; scope prospect): `prospect_id`, `seller_profile_id`, `scored_signals jsonb` (per signal: factor scores, rationales, `persona_fit_reason`, `potential_implication`, freshness label, weighted total, rank, outcome, rejection reason), `chosen_signal_id` nullable, `signal_strength` (strong, moderate, insufficient), `persona_unassessed bool`, `tone_constraints jsonb`, `person_specific bool`. The weighted total, freshness and ranking are recomputed in code each run; a new row is written only when the result differs.

**drafts** (immutable content): `prospect_id`, `hook_selection_id` nullable (null for fallback), `generation_id` (groups channels from one generation), `channel` (email, linkedin), `version int`, `parent_draft_id`, `origin` (generated, regenerated, edited, fallback), `subject`, `body`, `is_generic_fallback bool`, `fallback_persona` nullable, `person_specific bool`, `identity_state`, `constraint_failed bool`, `requires_tone_ack bool`, `tone_ack_at`, `status` (review, approved, rejected, gmail\_draft), `approved_at`, `approved_against jsonb` (verification id and fingerprint, grounding check id, hook selection id), `rejection_reason`, `gmail_draft_id`, `human_touched bool` (true for edited or approved), `gemini_call_id`. Unique `(prospect_id, channel, version)`. Content columns never change after insert.

**grounding\_checks** (derived; scope draft version): `draft_id`, `items jsonb` (the sentence-level assessment), `rule_results jsonb`, `evidence_hashes jsonb`, `profile_hash`, `person_specific bool`, `result` (passed, failed, invalid), `gemini_call_id`. A draft may have many checks over its lifetime. Partial unique current index on `(draft_id)` where not superseded. Unique `(draft_id, input_fingerprint)`.

**runs**: `prospect_id`, `seller_profile_id`, `trigger` (manual, reverify, regenerate, fallback, edit, recovery), `status` (queued, running, completed, needs\_input, failed, interrupted), `needs_input_reason` (confirm\_company, correct\_record), `plan jsonb`, `resumed_from_run_id`, `idempotency_key_id` nullable, `started_at`, `finished_at`, `heartbeat_at`, `call_count int`. Partial unique index on `(prospect_id)` where status in (queued, running).

**run\_stages**: `run_id`, `stage_key text`, `stage` (resolveCompany, verify, research, extract, score, draft, ground), `status` (pending, running, complete, skipped\_unchanged, blocked, failed), `input_fingerprint`, `output_table`, `output_id`, `attempt int`, `error jsonb`, `started_at`, `finished_at`. Unique `(run_id, stage_key)`.

**run\_events** (append-only): `id bigserial`, `run_id`, `seq int`, `prospect_id`, `stage_key` nullable, `type`, `level`, `message`, `payload jsonb`. Unique `(run_id, seq)`; index `(run_id, id)`. No updates or deletes.

**gemini\_calls**: `run_id` nullable, `stage_key`, `call_type` (grounded, structured), `model`, `prompt`, `prompt_version`, `response`, `grounding_metadata jsonb`, `input_tokens`, `output_tokens`, `latency_ms`, `attempt`, `fixture_id` nullable, `error jsonb`. One row per attempt. Request payload is retained so tests can assert Call 5's inputs.

**audit\_log** (append-only): `prospect_id`, `actor`, `action` (employment\_confirmed, prospect\_corrected, company\_resolved, candidate\_selected, draft\_edited, tone\_acknowledged, draft\_approved, draft\_rejected, gmail\_draft\_created, profile\_changed, fallback\_requested), `details jsonb`.

**idempotency\_keys**: `session_id`, `route`, `key`, `payload_hash`, `state` (in\_progress, complete), `response_status`, `response_body jsonb`, `expires_at`. Unique `(session_id, route, key)`.

**gemini\_quota**: `day date primary key`, `used int`, `cap int`. Modified only by `reserve_gemini_call`.

### A.2 RPCs (atomic operations)

| RPC | Responsibility |
| --- | --- |
| `commit_stage_output(table, scope, fingerprint, payload, run_id, stage_key)` | In one transaction: insert output or return existing on fingerprint conflict; supersede previous current row if the fingerprint differs; mark the stage row complete (or `skipped_unchanged`); call `recompute_prospect_status`. Failed or partial outputs never become current. Returns committed id and outcome. Events are emitted by the caller after it returns |
| `reserve_gemini_call(day, cap)` | Increment `used` only if below cap; return allowed or denied |
| `create_run_with_plan(prospect_id, trigger, plan, idempotency_key_id)` | Create the run and store the plan from one snapshot; the active-run unique index raises `conflict` |
| `approve_draft_versioned(draft_id, expected_versions)` | Re-read current versions inside the transaction; persist approval only if verification, grounding check and hook selection ids match; record `approved_against`; write audit entry |
| `claim_idempotency(session_id, route, key, payload_hash)` | Unique insert; returns new, replay (with stored response), or mismatch |
| `recover_interrupted_runs()` | Mark `running` runs `interrupted`, write `run_finished (interrupted)`, create recovery runs; safe to execute twice |
| `recompute_prospect_status(prospect_id)` | Rewrite the three cached statuses from current records |

### A.3 Migration order

1. Extensions and enums; `seller_profiles`, `seller_profile_settings`, seeded profile.
2. `companies`, `imports`, `prospects`.
3. `verifications`, `research_records`, `signals`, `hook_selections`, `drafts`, `grounding_checks`.
4. `runs`, `run_stages`, `run_events`, `gemini_calls`, `audit_log`.
5. `idempotency_keys`, `gemini_quota`.
6. Partial unique indexes and constraints (3.4).
7. RPCs (A.2).
8. Constraint and concurrency tests before any application code depends on them.

---

## Appendix B: Review checklist and Day 2 spikes

### B.1 Review the document for

| Check | Question |
| --- | --- |
| Status consistency | Do verification, research and draft status values match across Sections 3, 4, 6 and Appendix A? |
| Trigger map | Does every route that starts a run use a trigger in 4.2, and does config define its allowed stages? |
| Fingerprints | Does every input listed in 4.4 exist as a column or derived fact? Does any stage depend on an upstream row id? |
| Gate | Does every rule in 4.8 have the data it needs as a column? Is the draft-currency rule (C66) acceptable? |
| Human actions | Does every human-decision route carry version ids (6.3) and write an audit action (A.1)? |
| Fixtures | Does each case in 7.2 have a bundle for every Gemini call it triggers? |
| Invariants | Does each invariant I1 to I16 have at least one test in the acceptance matrix or validator tests? |
| Cut list | Does anything marked never-cut depend on something on the cut list? |

### B.2 Day 2 spikes (results go in Appendix D)

1. Can grounding and structured output combine on the chosen model? Decides merge versus two-step.
2. Real shape of grounding chunks and supports: redirect URLs, byte-offset spans. Test `quoteWithinSupportedSpan` on real responses. If spans are too coarse, adopt the documented coarse mode and `attribution_precision: coarse`.
3. Free-tier rate limits and latency; set the real daily cap and confirm sequential themes finish in reasonable time.
4. Candidates for A and C: run verification and research against five or six each; time-box to about two hours; take the first A with one dated candidate and three valid signals, and the first C with zero findings.
5. Record live backups for A and C; hand-author B, D, E and edit fixtures; run fixture tests.

### B.3 Values to set in config (tunable assumptions)

Model names per call; theme list and query guidance; research TTLs per theme; verification TTL (about 30 days); freshness tiers by signal type; score weights; tone-review penalty; strength thresholds; word-count caps per channel; max retries and backoff; daily Gemini cap; SSE and API rate limits; demo TTL override; allowed origin.

---

## Appendix C: Known limitations and interview talking points

- **Evidence is the grounded summary, not page text.** Quote checks prove a claim traces to what the model retrieved, not to the page's exact words. Next step: fetch and quote the actual page.
- **Attribution precision may be source-level.** Where span metadata is too coarse, evidence is labelled "source-level attribution".
- **Public data only; no LinkedIn scraping.** Employment verification is evidence-based and may be uncertain for people with little public footprint.
- **Fixture-backed edge cases.** B, D, E and the edit test prove deterministic rules; the badge states this. A and C are live.
- **Single-process runner.** A deploy interrupts in-flight runs; they resume from stored state.
- **In-memory rate limits reset on restart;** the daily cap is database-backed.
- **No cancel or pause.** Runs are short; bounded retries and the quota contain runaway loops.
- **Gmail in testing mode.** One connected account; tokens expire in about 7 days; copy-draft fallback always works.
- **Tunable assumptions:** freshness windows, weights, thresholds, TTLs.
- **What I would build next:** page fetching with exact quotes, xlsx import, bulk queue with concurrency 2 to 3, reply tracking, Supabase Auth for rep login.
- **Strongest design points to explain:** the model returns observations and code returns verdicts; the system re-checks its own drafts against stored evidence; uncertain versus mismatch versus failed; a tone change re-runs two calls, not fifteen.

---

## Appendix D: Implementation notes (non-normative)

Record here anything learned during the build. A note that forces a contract change must also add a changelog entry (Section 8) and update the acceptance tests in the same commit. Entry format: date, area, note, linked changelog ID if any.

| Date | Area | Note | Changelog ID |
| --- | --- | --- | --- |
| (consolidation) | Section 8 | Correction to C67: it should read "Added `fixture_id` to `prospects`; added `idempotency_keys` and `gemini_quota` to the table list." Appendix A is authoritative. | C69 |
| (open) | Day 2 spikes | Results of B.2 items 1 to 3 to be recorded here | n/a |

---

# Part II: v1.1 Amendments (normative)

**Precedence.** Part II overrides Sections 1 to 9 and Appendices A and B wherever they conflict. Existing changelog entries are never edited; new entries are C70 onward (AM-13). No invariant I1 to I16 is weakened. I2 is strengthened: on Vercel there is no process memory to rely on at all.

## AM-1 Deployment model: Vercel + Supabase (serverless)

**Why this changes anything.** Vercel runs short-lived functions. A long-lived process does not exist, so the v1.0 in-process runner, in-memory notifier, in-memory rate limiter and boot-time recovery cannot work. The v1.0 principles (database is the only state, idempotent resumable stages, database-first events) already fit serverless. Only the **execution driver** changes.

| v1.0 | v1.1 replacement |
| --- | --- |
| Single-process runner started on `POST /runs` | **Lease-based `advance` invocations.** Each invocation does a time-boxed slice of work, then hands off |
| Boot recovery (`running` becomes `interrupted`) | **Watchdog** endpoint called every minute; resumes runs whose lease expired |
| In-process notifier plus SSE wake-ups | SSE handler **polls the database** (about once per second) for the bounded life of the function; the client reconnects with `Last-Event-ID` |
| Per-run in-memory serialized event writer | `append_event` RPC assigns `seq` under a row lock; safe across invocations |
| In-memory rate limits | `rate_limit_hit` RPC with database counters (login and run-starting routes only) |
| Express `app.listen` | Express app **exported** as the Vercel handler; `listen` only in local dev |
| Fixtures read from disk | Unchanged: fixture files ship inside the deployment (read-only). The re-record script runs **locally only** |
| Gmail tokens (unspecified) | Stored **encrypted** in `gmail_connections` |

**Tool split.** GitHub holds source, pull requests and CI. Cursor is the authoring environment. Supabase is Postgres plus migrations (Supabase CLI, SQL files in the repo). Vercel hosts the Express function and static `public/`.

### Execution model

1. `POST /api/prospects/:id/runs` calls `create_run` (AM-2), which stores a `queued` run, then dispatches `advance(run_id)` using `waitUntil` (from `@vercel/functions`) and returns 202.
2. `advance(run_id)` acquires the run's **lease**: `acquire_run_lease(run_id, owner, ttl)` succeeds only if there is no lease or it has expired. Lease TTL about 90 seconds, renewed before every stage and every Gemini attempt.
3. It loops: pick the next stage that needs work (the planner's authoritative per-stage check, AM-3), execute it, commit through `commit_stage_output`, emit events, check the time budget.
4. **Time budget:** `ADVANCE_BUDGET_MS` is about 70 percent of the function's configured max duration (check the current limits for your Vercel plan and set it in env). If the remaining budget is smaller than `MIN_STAGE_MS`, release the lease, dispatch a new `advance`, and exit. Research is per-theme and extraction is per-record, so stages are small enough to slice.
5. If a function dies mid-call (timeout, deploy), nothing is lost: the lease expires, the in-flight attempt row stays in `gemini_calls`, and the next `advance` retries that stage with `attempt + 1`.
6. **Watchdog** `POST /api/internal/watchdog` (requires `x-internal-secret`) runs every minute, called by **Supabase `pg_cron` + `pg_net`** (works on any Vercel plan) or Vercel Cron if the plan allows per-minute schedules. It: (a) dispatches `advance` for runs `queued` longer than 10 seconds; (b) for `running` runs with an expired lease, increments `resume_count`, emits `run_resumed`, dispatches `advance`; (c) if `resume_count` exceeds `MAX_RESUMES` (default 5), marks the run `interrupted` and emits `run_finished (interrupted)`; (d) releases stale `in_progress` idempotency keys (AM-7); (e) moves stale Gmail operations to `unknown` (AM-7).
7. **Status meaning change:** `interrupted` now means "resume limit exceeded", not "server restarted". A function timeout is routine and the same run simply continues. The `recovery` trigger is used only when an SDR retries an `interrupted` or `failed` run (creates a new run with `resumed_from_run_id`).
8. New event type `run_resumed` joins the closed list in 6.4. `run_finished` is still always last.

### SSE on serverless

The handler keeps the v1.0 loop but replaces the notifier wake-up with a database poll every 1 second, and ends the response cleanly shortly before the function's max duration. EventSource reconnects automatically with `Last-Event-ID`, so users see one continuous stream. The JSON polling form (`Accept: application/json`, `?after=`) remains and is the frontend's fallback if streaming misbehaves. The terminal-race rule is unchanged. The 5-concurrent-streams cap is dropped (cannot be enforced across instances).

### Rate limiting

Only login attempts (per IP) and run-starting routes (per session) are limited, using `rate_limit_hit(key, window_seconds, max)` over a `rate_limits` table. The daily Gemini cap is the real protection. Vercel's own firewall may be used on top.

### Other platform notes

- Use `@supabase/supabase-js` over HTTP only (no direct Postgres pool from functions).
- Keep the service key, Gemini key, OAuth secrets, `INTERNAL_SECRET`, `TOKEN_ENCRYPTION_KEY` in Vercel env (never in the repo).
- Each function invocation must tolerate a cold start and must not rely on module-level state across requests.

## AM-2 Run creation and plan (resolves blocker 1)

The plan is **not** computed inside the database transaction. Corrected contract:

1. The service reads a snapshot: `prospects.state_version`, active `profile_id`, and for each stage the current output id, fingerprint and expiry.
2. It computes the plan in JavaScript (AM-3).
3. It calls `create_run(prospect_id, trigger, plan, expected_state_version, expected_profile_id, idempotency_key_id)`.
4. The RPC, in one transaction, checks that `state_version` and the active profile still equal the expected values and that no run is active. If they differ it returns `stale_plan` and the service re-plans (at most 3 attempts, then 409 `conflict`). Otherwise it inserts the run (`queued`), stores the plan, writes the `run_started` and `plan` events, completes the idempotency record with the 202 response, and returns.
5. **New column `prospects.state_version bigint`**, incremented in the same transaction by `commit_stage_output`, `PATCH`, every resolution, confirmation, tone acknowledgement, approval, rejection and archive.
6. **The plan is advisory and for display.** Expiry is time-dependent, so each stage re-evaluates its own fingerprint, validity and expiry at execution time. Stage execution, not the stored plan, is authoritative. The `plan` event says what was expected at creation; stage events say what happened.

This replaces v1.0 4.1 item 6 and changelog C51.

## AM-3 Triggers are planner entry points (resolves blocker 2)

A trigger is a **target plus forced stages**. The planner walks the dependency graph upstream from the target and runs every stage that is not fresh, valid and unexpired, so no stage list is hard-coded.

```
resolveCompany > verify > research(company themes) > extract > score > draft > ground
                              (person research: only if employment effectively confirmed)
```

| Trigger | Target | Forced | Notes |
| --- | --- | --- | --- |
| `manual` | Grounded personalised draft | none | Stops early per branching (4.6) |
| `reverify` | Same as manual | `verify` | Downstream re-runs only where fingerprints changed (early cutoff) |
| `regenerate` | Grounded personalised draft | `draft` (new version, with a regeneration nonce) | Runs stale upstream first: if the seller product changed, `score` runs before `draft`; expired research refreshes |
| `fallback` | Grounded fallback draft (lane `fallback`) | `draft` (fallback mode) | Needs no signal. Uses the current verification for greeting and `person_specific`; does not run verify |
| `edit` | Grounding check of the new draft version | none | Upstream is not evaluated; the gate evaluates currency at approval |
| `recovery` | Same target as the run it resumes | none | SDR retry of an `interrupted` or `failed` run |

If the seller profile changes, a plain `regenerate` or `manual` run recomputes `score` and `draft` and reuses fresh research. The planner never supersedes a human-touched draft (I11): it reports the draft stale and waits for an explicit `regenerate`.

## AM-4 Scoring, selection and the formula (resolves blocker 3 and the dashboard-fixture ambiguity)

**Two fingerprints on `hook_selections`:**

- `scoring_fingerprint`: inputs to the AI scoring call (valid signal content hashes, scoring-relevant profile hash, `person_specific` and designation when person-specific, scoring stage version). **Excludes** weights, penalty, thresholds, freshness.
- `selection_fingerprint`: hash of `scoring_fingerprint` + ranking-config hash (weights, penalty, thresholds, min offer fit) + the **freshness label of each signal** (derived facts, not the calendar date) + `person_specific`.

`hook_selections` is unique on `(prospect_id, selection_fingerprint)`; the current row is the one with `superseded_at` null. When the selection fingerprint changes but the scoring fingerprint matches the latest earlier row, the new row **copies the stored AI factor scores** (no Gemini call) and records `scoring_call_id` of the original call. A penalty change therefore produces a new immutable selection version at zero model cost.

**Eligibility.** A signal may be chosen only if it is `valid`, **dated** (date precision day, month or year), not `stale`, and its effective sensitivity is not `blocked`. Undated signals are retained and shown as "undated: not selectable". Month or year precision uses the **start** of the period for age (conservative).

**Formula (config defaults, all tunable):**

- Factors: `S` specificity, `P` persona fit (may be null), `O` offer fit, `R` recency. `R` is computed in code: `current` = 5, `older_but_relevant` = 3.
- Weights: `O` 0.35, `P` 0.25, `S` 0.20, `R` 0.20.
- `total = sum(w_i * f_i) / sum(w_i over available factors)`, so null `P` renormalises the remaining weights.
- Tone-review penalty: subtract 0.5 after normalisation.
- Round to 2 decimals before ranking. Rank by total descending; ties broken by higher `O`, then more recent event date, then lexical signal id.
- Chosen signal = rank 1 among eligible signals with `O >= 3` (`min_offer_fit`). None qualifies means no hook and strength `insufficient`.
- Strength from the chosen total: `strong` at 4.0 or above, `moderate` at 3.0 or above, otherwise `insufficient`. If `P` was null, strength is capped at `moderate` and `persona_unassessed = true`.

**Worked examples (use in unit tests).**

| Case | S | P | O | R | Computation | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Plain signal | 4 | 4 | 5 | 5 | (0.8 + 1.0 + 1.75 + 1.0) / 1.0 | 4.55 |
| Restructuring (D2), tone review | 4 | 4 | 5 | 5 | 4.55 minus 0.5 | 4.05 |
| Competitor for D2 | 3 | 3 | 4 | 3 | (0.6 + 0.75 + 1.4 + 0.6) / 1.0 | 3.35 |
| Null persona | 4 | null | 5 | 5 | (0.8 + 1.75 + 1.0) / 0.75 = 4.73, capped | strength `moderate` |

**D2 fixture authoring rule:** the restructuring signal must win after the penalty with a margin of at least 0.5 (the example gives 0.70) so the test proves selection under penalty. Same fixture must also assert the ranking order.

## AM-5 Signal extractions as a parent record (resolves blocker 4)

New table **`signal_extractions`**: `id`, `research_record_id`, `input_fingerprint`, `stage_version`, `result_count`, `status` (complete), `gemini_call_id`, `superseded_at`, `created_at`. `signals` rows reference `extraction_id` (replacing a direct fingerprint on signals).

A zero-signal extraction is now a stored, reusable output with `result_count = 0`, so the planner sees the stage as fresh and does not call Gemini again. `signals` have no `superseded_at` of their own: a signal is current if and only if its extraction is current. Signal lifecycle (`valid`, `rejected`) remains a status field and each change emits an event.

## AM-6 Versioning scopes (resolves blocker 5)

This table is authoritative for every partial unique index. "Fingerprint unique" prevents duplicates; "current unique" allows exactly one current row (`superseded_at IS NULL`).

| Table | Entity scope | Fingerprint unique | Current unique | When a parent is superseded |
| --- | --- | --- | --- | --- |
| `verifications` | prospect | `(prospect_id, input_fingerprint)` | `(prospect_id)` | Root. Downstream stages react through derived facts (AM-9), not row ids |
| `research_records` (company) | company + theme, `prospect_id` null | `(company_id, theme, input_fingerprint)` | `(company_id, theme)` where `prospect_id` is null | Company rows are never superseded by other entities |
| `research_records` (person) | prospect + theme | `(prospect_id, theme, input_fingerprint)` | `(prospect_id, theme)` where `prospect_id` is not null | If employment stops being effectively confirmed, person records stay stored but the planner does not read them |
| `signal_extractions` | research record | `(research_record_id, input_fingerprint)` | `(research_record_id)` | A new research record version gets its own extraction; the old extraction is no longer current and is not read |
| `signals` | extraction | `(extraction_id, content_hash)` | none; current if its extraction is current | Never superseded individually |
| `hook_selections` | prospect | `(prospect_id, selection_fingerprint)` | `(prospect_id)` | A new profile or ranking config yields a new selection; old kept |
| `drafts` | prospect + channel + **lane** (`personalised` or `fallback`) | `(prospect_id, channel, lane, version)` unique; machine-generated drafts also unique on `(prospect_id, channel, lane, generation_fingerprint)` | `(prospect_id, channel, lane)` | Drafts are **not** superseded when upstream changes. They become stale at read time. Machine-made, untouched drafts are superseded when the planner generates a new version; human-touched drafts only by an explicit SDR action |
| `grounding_checks` | draft version | `(draft_id, input_fingerprint)` | `(draft_id)` | Draft versions are immutable, so a check never outlives its draft; new checks supersede older ones for the same draft |

Notes: (1) A forced `regenerate` adds a **regeneration nonce** (the run id) to the generation fingerprint so it creates a new version while planner-driven generation stays idempotent. (2) The review screen shows the latest draft in whichever lane the SDR is working. (3) Zero-finding research records are valid and cached (5.4).

## AM-7 Idempotency and Gmail operations (resolves blocker 6)

**Idempotency completion.** New RPCs `complete_idempotency(id, status, body)` and `reclaim_idempotency(id)`.

- Run creation completes the key **inside** `create_run` (same transaction), so there is no window where a run exists without a stored response.
- Other mutating routes call `complete_idempotency` in the same transaction as their write wherever the write is a single RPC.
- A key stuck `in_progress` for more than 2 minutes with no completed effect is released by the watchdog; the same request with the same payload may then re-claim it.

**Gmail draft creation is not exactly-once.** It gets its own persistent state machine.

New table **`gmail_operations`**: `id`, `draft_id`, `draft_body_hash`, `recipient`, `idempotency_key_id`, `state` (`pending`, `creating`, `created`, `unknown`, `failed`), `gmail_draft_id`, `marker` (unique operation marker embedded in the draft), `attempts`, `error`, `created_at`, `updated_at`. Partial unique index: one non-terminal operation per `(draft_id, draft_body_hash)`.

1. `gmail_op_begin` inserts `pending` (or returns the existing operation) after the gate passes.
2. Set `creating`, then call the Gmail API with the `marker` embedded in the message (custom header and a hidden token in the footer).
3. On success set `created` with `gmail_draft_id`, set the draft `status = gmail_draft`, write the audit entry, all in one RPC.
4. A definite API error sets `failed`; the response is `upstream_failed` with `details.fallback`.
5. If an operation is `creating` for more than 60 seconds (crash or timeout), the watchdog moves it to `unknown`.
6. **Reconciliation before any retry from `unknown`:** search the connected account's drafts for the `marker`. Found: mark `created`. Not found: mark `failed` so a retry is safe. If search is unavailable or ambiguous, show the SDR a choice ("check Gmail" or "create another"); choosing "create another" may duplicate and the UI says so.
7. **Spike item:** confirm Gmail preserves the marker header on drafts and that draft search can find it. If not, rely on subject plus hidden body token.

Do not describe this as exactly-once. It is **at-most-once by default, with an explicit `unknown` state and reconciliation**.

New table **`gmail_connections`**: `account_email`, `refresh_token_encrypted` (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`), `scopes`, `status` (active, expired, revoked), `connected_by`, timestamps. One active row for the demo.

## AM-8 Schema corrections and additions

| Item | Change |
| --- | --- |
| `gemini_calls` | Add `request_payload jsonb` (exact structured input passed to the wrapper). Rename `prompt` to `rendered_prompt`. The I6 test inspects `request_payload` |
| `drafts` | Add `profile_version_id`, `draft_profile_hash`, `approved_claims_hash`, `banned_claims_hash`, `tone_rules_hash`, `generation_fingerprint`, `lane`. The gate compares these to the active profile (authorization-affecting: product, value prop, approved and banned claims; cosmetic: tone rules) |
| `hook_selections` | Add `scoring_fingerprint`, `selection_fingerprint`, `scoring_call_id`; remove the single generic fingerprint |
| `runs` | Add `lease_owner`, `lease_expires_at`, `resume_count`; `interrupted` per AM-1 |
| `prospects` | Add `state_version bigint` |
| New tables | `signal_extractions`, `gmail_operations`, `gmail_connections`, `rate_limits` (`key`, `window_start`, `count`) |
| New RPCs | `create_run` (replaces `create_run_with_plan`), `acquire_run_lease`, `renew_run_lease`, `release_run_lease`, `append_event`, `complete_idempotency`, `reclaim_idempotency`, `rate_limit_hit`, `gmail_op_begin`, `gmail_op_finish`, `watchdog_scan` |
| Event types | Add `run_resumed` |
| Audit actions | `select-candidate` writes **`candidate_selected`** only (not `prospect_corrected`). `PATCH` writes `prospect_corrected`. Section 4.6 is amended accordingly. Add `gmail_unknown_reconciled` |

## AM-9 Identity, employment and `person_specific` (clarifications)

One pure function, `deriveEmploymentState(verification, prospect, now)`, returns `{ identity_state, effective_employment, person_specific }`. It is the only place these are computed.

- `effective_employment` is `confirmed` when the current verification is unexpired and its fingerprint matches the planned verify fingerprint for the prospect's current identity fields, and either status is `verified`, or status is `uncertain` with a confirmation attached. Otherwise it is `unconfirmed`. An **expired or stale verification counts as unconfirmed** even though its stored status says `verified`.
- `person_specific = (identity_state == established) AND (effective_employment == confirmed)`.
- **`confirm-employment` is allowed only when** the current verification is `uncertain`, `identity_state` is `established`, it is unexpired, and its fingerprint still matches the prospect's current identity fields. An `ambiguous` or `unknown` identity must first be resolved with `select-candidate` and a re-verification.
- **Company matching.** In company resolution and in verification's employer comparison, an exact match after normalisation (case, punctuation, legal suffixes such as Inc, Ltd, Pvt) or an equal domain counts as a match. Fuzzy similarity only **suggests** candidates and can never by itself produce `verified` or auto-link a company. This is consistent with the rule that fuzzy matching is not proof.
- **Gate and expiry.** The approval gate recomputes `deriveEmploymentState` at approve time and at Gmail time, so an expired verification blocks both.

## AM-10 Cached status derivation

`recompute_prospect_status` is called in the same transaction by `commit_stage_output`, `create_run`, every terminal run transition (`completed`, `needs_input`, `failed`, `interrupted`), and every human action RPC.

| Field | Rule (first match wins) |
| --- | --- |
| `verification_status` | `running` if an active run's verify stage is running; `pending` if no current verification or it is expired; otherwise the current verification's status (`verified`, `uncertain`, `mismatch`, `failed`) |
| `research_status` | `running` if an active run is executing research, extract or score; `failed` if the latest run failed in those stages and no valid output covers them; `insufficient_evidence` if the current hook selection has strength `insufficient`; `complete` if all required company themes have current unexpired records and a current hook selection exists; else `pending` |
| `draft_status` | Reflects the **lead draft**: the current email draft in the fallback lane if one exists newer than the personalised one, else the personalised lane. Values `none`, `review`, `approved`, `gmail_draft`, `rejected`. LinkedIn status is shown per draft in the UI and is not cached |

Staleness is **not** a stored status; it is a read-time flag from fingerprint comparison.

## AM-11 Product scope adjustments

- **Basic dashboard is P0** (total prospects, status-field counts, recent runs, latest draft status, needs-attention list) and ships in Phase 5. Charts and analytics stay P1.
- The scoring formula and eligibility rules in AM-4 are normative.
- Undated signals are valid but not selectable (AM-4).

## AM-12 Added acceptance tests

| ID | Test |
| --- | --- |
| N1 | Zero-signal extraction is stored and reused; no second Gemini call |
| N2 | Changing the tone-review penalty creates a new `hook_selection` version with copied AI scores and zero Gemini calls |
| N3 | `regenerate` after a product change runs `score` before `draft` and reuses fresh research |
| N4 | `create_run` returns `stale_plan` when `state_version` changed; the service re-plans |
| N5 | A `queued` run with no executor is picked up by the watchdog |
| N6 | Lease expiry mid-research resumes the same run at the next theme (`run_resumed`) |
| N7 | Resume limit exceeded marks the run `interrupted` with `run_finished` |
| N8 | A crash after idempotency claim but before completion is reclaimed; two concurrent identical requests create one run |
| N9 | Gmail `creating` older than 60s becomes `unknown`; reconciliation finds or clears the marker; no duplicate draft in the found case |
| N10 | Concurrent quota reservations never exceed the cap |
| N11 | An undated signal is never chosen as the hook |
| N12 | An expired verification blocks approval and Gmail creation and makes `person_specific` false |
| N13 | `confirm-employment` refused for `ambiguous` identity and for a stale verification fingerprint |
| N14 | Changing approved claims makes an approved draft fail the gate |
| N15 | `request_payload` of Call 5 contains no rejected or blocked signal |
| N16 | Worked examples in AM-4 reproduce exactly in unit tests |

## AM-13 Changelog (continues Section 8)

| ID | Change | Reason |
| --- | --- | --- |
| C70 | Deploy on Vercel + Supabase; lease-based `advance` invocations replace the in-process runner | Serverless has no long-lived process |
| C71 | Watchdog (pg\_cron + pg\_net, or Vercel Cron) replaces boot recovery; handles queued and expired-lease runs | Queued runs could otherwise stay queued forever (review blocker 7) |
| C72 | `interrupted` means resume limit exceeded; routine continuation reuses the same run (`run_resumed`) | Timeouts are routine on serverless |
| C73 | SSE polls the database; notifier removed; JSON polling remains fallback | No cross-invocation notifier |
| C74 | `append_event` RPC assigns `seq` under lock; per-run in-memory writer removed | Safe across invocations |
| C75 | Rate limits move to database counters; SSE concurrency cap dropped | In-memory limits do not work across instances |
| C76 | `create_run` verifies expected `state_version` and profile; plan is advisory; stages re-check at execution | Resolves contradiction in plan-in-transaction claim (blocker 1) |
| C77 | Triggers are planner entry points (target plus forced stages) | `regenerate` could not otherwise run stale scoring (blocker 2) |
| C78 | `hook_selections` carries `scoring_fingerprint` and `selection_fingerprint`; AI scores copied on reuse | Ranking config changes must not collide with cached observations (blocker 3) |
| C79 | Scoring formula, eligibility, tie-breaks, thresholds, worked examples fixed | Fixtures must pass identically under any implementation |
| C80 | Undated signals valid but not selectable; month/year precision uses period start | Cannot assert recency without a date |
| C81 | `signal_extractions` parent table | Zero-signal extraction needs a reusable record (blocker 4) |
| C82 | Versioning scope table including draft lanes and regeneration nonce | Exact partial unique indexes (blocker 5) |
| C83 | `complete_idempotency`, `reclaim_idempotency`; run creation completes the key atomically | Crash window after claim (blocker 6) |
| C84 | `gmail_operations` state machine with `unknown` and marker reconciliation; not exactly-once | External side effect cannot be made atomic with the database |
| C85 | `gmail_connections` with encrypted refresh token | Token storage was unspecified |
| C86 | `request_payload` on `gemini_calls`; `rendered_prompt` renamed | I6 test needs structured input (blocker 8) |
| C87 | Profile hashes and version stored on drafts | Gate needs to detect profile drift |
| C88 | `deriveEmploymentState` single function; expiry counts as unconfirmed; `confirm-employment` requires established identity and matching fingerprint | Database must enforce identity versus employment |
| C89 | Exact-normalised or domain match is evidence; fuzzy only suggests | Resolves contradiction with the fuzzy-is-not-proof rule |
| C90 | `candidate_selected` and `prospect_corrected` are separate audit actions | Section 4.6 and Appendix A disagreed |
| C91 | Cached status derivation rules; recompute at run creation and every terminal transition | Previously only on stage commit |
| C92 | Basic dashboard promoted to P0 | Brief requires a dashboard |

---

# Part III: Developer Handoff

For the people (and Cursor agents) who will write the code. Stack: **Node.js, GitHub, Cursor, Supabase, Vercel**, plus Gemini API and Zod.

## H.1 How to use this document

1. Export this document as Markdown into the repo as `docs/SPEC.md`. It is the contract. Changes go through a pull request that also adds a changelog entry (Section 8 / AM-13) and updates tests.
2. **Precedence:** Part II beats Sections 1 to 9 and Appendices. Read order: Section 1.7 (invariants), Part II, then Sections 3, 4, 5, 6, Appendix A, then Section 7 (tests).
3. If something is unclear or the spec seems wrong, **do not guess and do not quietly change it.** Open a GitHub issue labelled `spec-question`, tag the owner, and continue with another ticket.
4. The non-negotiables are the invariants I1 to I16. A pull request that weakens one is rejected.

## H.2 Repository and workflow (GitHub)

- One repo, `main` protected. Work in short branches named `t##-short-title`, one pull request per ticket (H.7).
- **CI (GitHub Actions) on every PR:** install, lint, unit tests, and a migrations job that starts local Supabase (`supabase start`), applies all migrations, and runs constraint and RPC tests. A PR cannot merge with CI red.
- Vercel creates a preview deployment per PR (preview env points at a separate Supabase **dev** project, never production data).
- Two Supabase projects: `dev` (previews, local testing) and `demo` (the deployment used for the video and interview). Migrations are applied to `demo` only from `main`.
- PR template: ticket id, which invariants are touched, which acceptance tests were added, changelog entry (if a contract changed), screenshots for UI.

## H.3 Repository layout (Vercel-adapted)

```
.cursor/rules/            Cursor rules (H.6)
AGENTS.md                 pointer to docs/SPEC.md and the rules
docs/SPEC.md              this document (exported)
api/index.js              exports the Express app as the Vercel handler
vercel.json               rewrites: /api/* to the function; function maxDuration; (cron if used)
public/                   static frontend (HTML + vanilla JS)
src/
  app.js                  builds the Express app (no listen)
  dev-server.js           local only: app.listen
  config/                 all tunable values (B.3) + ranking config + trigger map
  routes/  services/
  pipeline/
    planner.js            AM-3: target + forced stages, fingerprint checks
    fingerprint.js        canonical input objects + hashing
    advance.js            AM-1: lease, time budget, stage loop, hand-off
    stages/               resolveCompany, verify, research, extractSignals,
                          scoreSignals, draft, groundingCheck
    events.js             wraps append_event RPC
  integrations/gemini/    wrapper (grounded, structured, retry, repair, quota, fixtures)
  integrations/gmail/     OAuth, draft creation, gmail_operations flow
  integrations/supabase.js  RPC wrappers (the only DB access layer)
  validators/             pure functions (Section 2.2 list + deriveEmploymentState)
  schemas/                Zod: api/, gemini/, records/
supabase/
  migrations/             ordered SQL (Appendix A.3, with AM-5 to AM-8 changes)
  tests/                  constraint + RPC + concurrency tests
fixtures/live-recorded/  fixtures/hand-authored/
scripts/                  record-live-fixtures.js (local only), seed.js
tests/                    unit/ and pipeline/
```

## H.4 Environment variables

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Server-side DB access (never exposed to the browser) |
| `GEMINI_API_KEY` | Model calls |
| `GEMINI_MODEL_RESEARCH`, `GEMINI_MODEL_STRUCTURED`, `GEMINI_MODEL_EXTRACT` | Model names per call type (set after the Day 2 spike) |
| `GEMINI_DAILY_CAP` | Daily call cap |
| `DEMO_PASSWORD`, `SESSION_SECRET` | Login and signed cookie |
| `APP_ORIGIN` | Allowed Origin for state-changing requests |
| `INTERNAL_SECRET` | Authenticates watchdog and advance dispatch |
| `ADVANCE_BUDGET_MS`, `MIN_STAGE_MS`, `MAX_RESUMES` | Execution budget (AM-1) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Gmail OAuth |
| `TOKEN_ENCRYPTION_KEY` | Encrypts Gmail refresh token (32 bytes, base64) |
| `FIXTURE_TTL_OVERRIDE_DAYS` | Demo-only research TTL extension |

A Zod-validated `env.js` fails the boot loudly if anything is missing. Provide `.env.example` in the repo; real values live only in Vercel and local `.env` (git-ignored).

## H.5 One-time setup checklist

1. **GitHub:** create repo, protect `main`, add Actions secrets for the dev Supabase project.
2. **Supabase:** create `dev` and `demo` projects; install the Supabase CLI; `supabase init`; link; migrations live in `supabase/migrations`. Enable `pg_cron` and `pg_net` on `demo` for the watchdog schedule.
3. **Vercel:** import the repo; set env vars per environment; set the function max duration in `vercel.json`; confirm the plan's limits and set `ADVANCE_BUDGET_MS` to about 70 percent of it.
4. **Google Cloud:** create a project, enable the Gmail API, configure the OAuth consent screen in testing mode with the demo Google account as a test user, create web credentials with the Vercel redirect URI, use the minimum scope that allows creating drafts.
5. **Gemini:** create an API key; run the Day 2 spike script (T14) before choosing model names.
6. **Watchdog schedule:** create the `pg_cron` job that POSTs to `/api/internal/watchdog` every minute with the internal secret (or configure Vercel Cron if the plan allows).

## H.6 Cursor setup (prevents drift)

Put the following in `.cursor/rules/spec.mdc` (and a short `AGENTS.md` pointing to it). Cursor should treat it as standing instructions:

> Always read `docs/SPEC.md` before changing code. Part II overrides earlier sections. Never change a contract (schema, RPC signature, route, event type, gate rule, fingerprint input) without a changelog entry and updated tests in the same commit. Database access only through `integrations/supabase.js` RPC wrappers. Stage outputs are written only through `commit_stage_output`. Events only through `append_event`. No module-level mutable state. Any function may be killed at any time; stages must be idempotent. The model returns observations; code returns verdicts. Never let a prompt decide `verified`, `blocked`, `passed`, or ranking. Validators in `src/validators` are pure: no I/O, no imports from integrations or routes. Every request body and Gemini response is parsed with Zod; unknown fields are rejected. Never add auto-send. Gmail integration creates drafts only. Never edit files in `fixtures/hand-authored`. Never bump a prompt version without a changelog entry. One ticket per branch. Write the failing test first for validators and RPCs.

Use Cursor Agent per ticket with the ticket text, the relevant spec sections attached as context, and the rule file. Review each diff against the PR checklist (H.8).

## H.7 Work breakdown (ordered tickets)

Every ticket is complete only when its acceptance column passes in CI. "AC" references use the IDs in Section 7.3 and AM-12.

| ID | Ticket | Depends on | Deliverable and acceptance |
| --- | --- | --- | --- |
| T01 | Repo, CI, Vercel skeleton | none | Express exported to Vercel; `/healthz` live on a preview URL; CI runs lint and a placeholder test |
| T02 | Supabase projects and CLI | T01 | `dev` and `demo` linked; empty migration applies in CI via `supabase start` |
| T03 | Config and env validation | T01 | `env.js` with Zod; `config/` holding every value in B.3 and AM-4 defaults; boot fails on missing env |
| T04 | Migrations: profile, companies, imports, prospects | T02 | Tables and unique indexes per A.1 plus `state_version`; seeded AP-automation profile; constraint tests: duplicate email and dedupe key rejected |
| T05 | Migrations: derived tables | T04 | verifications, research\_records, signal\_extractions, signals, hook\_selections, drafts, grounding\_checks with scopes exactly as AM-6; tests: second current row rejected, duplicate fingerprint returns existing |
| T06 | Migrations: operations tables | T04 | runs (lease, resume\_count), run\_stages, run\_events, gemini\_calls (`request_payload`), audit\_log, idempotency\_keys, gemini\_quota, rate\_limits, gmail\_operations, gmail\_connections; second active run per prospect rejected |
| T07 | RPCs: stage commit, events, status | T05, T06 | `commit_stage_output`, `append_event`, `recompute_prospect_status`; tests: atomic supersede, failed output never current, `seq` contiguous under concurrent calls, N1 storage side |
| T08 | RPCs: runs and leases | T07 | `create_run` (with `stale_plan`), lease acquire/renew/release, `watchdog_scan`; N4, N5, N6, N7 database parts |
| T09 | RPCs: quota, idempotency, rate limit, approval, Gmail ops | T07 | `reserve_gemini_call`, `claim/complete/reclaim_idempotency`, `rate_limit_hit`, `approve_draft_versioned`, `gmail_op_begin/finish`; N8, N9, N10 |
| T10 | Validators with unit tests | T03 | All validators including scoring math, `quoteWithinSupportedSpan` (span and coarse modes), `deriveEmploymentState`, `approvalGate`, sensitivity order, keyword backstop with false positives; N11, N12, N13, N14, N16 |
| T11 | Gemini wrapper | T03, T09 | Grounded and structured calls, retry, repair, call logging with `request_payload`, atomic quota; unit tests with mocked SDK |
| T12 | Fixture mode | T11 | Bundle format and loader, version check throwing `FixtureIncompatibleError`, lookup by `(fixture_id, call_type, input_key)`, badge flag on prospect |
| T13 | Day 2 spike script and results | T11 | Written results in Appendix D: grounding plus structured compatibility, chunk and support shape, rate limits, Gmail marker behaviour (AM-7 item 7) |
| T14 | Fingerprints and planner | T10 | Canonical inputs per stage (4.4 with Part II changes); planner table-driven tests for every row of the change matrix and every trigger in AM-3 |
| T15 | `advance` runner and watchdog route | T08, T14 | Lease loop with time budget and hand-off; watchdog route; N5, N6, N7 end to end with fake stages |
| T16 | Stages: resolveCompany, verify | T11, T14 | Company resolution rules (AM-9), Calls 1 and parse, status derivation; fixtures B1, B2, E drive them |
| T17 | Stages: research, extract | T16 | Per-theme research with TTL, zero-finding records, extraction with `signal_extractions`; N1; D1 and D false positive |
| T18 | Stages: score and hook selection | T17 | Calls 4 and ranking per AM-4; N2; D2 ranking assertion; B1 persona null cap |
| T19 | Stages: draft and grounding | T18 | Calls 5 and 6, constraints, greeting rule, fallback lane, grounding rules; edit test and correction; N15 |
| T20 | Auth and middleware | T09 | Session cookie, Origin check, rate limit, idempotency middleware, error envelope, Zod request parsing |
| T21 | Routes: profile, prospects, imports | T20, T05 | CSV import with row report; dedupe; PATCH audit; profile versioning with approved-claims block |
| T22 | Routes: runs and events | T15, T20 | `POST runs` with plan response, run summary, SSE (database poll, bounded duration, `Last-Event-ID`), JSON replay form; reconnect and terminal-race tests |
| T23 | Routes: resolutions, review, approval | T19, T20 | Resolution routes version-bound; edit, regenerate, fallback, tone-ack, approve, reject; gate returns `gate_blocked` reasons |
| T24 | UI: prospects, add and import, badges | T21 | Table with status fields and attention label; fixture badge; import report |
| T25 | UI: live run view | T22 | Plan-driven stage list; `skipped_unchanged` versus `refreshed_expired` visually distinct; reconnect recovery; failed, needs\_input, interrupted panels (6.8) |
| T26 | UI: review screen | T23 | Four tabs; coarse attribution labelled "source-level"; draft with claims and gate reasons; edit, regenerate, approve; stale banner |
| T27 | UI: dashboard (P0) | T21 | Counts by status field, recent runs, latest draft status, needs-attention list, Gemini usage against cap |
| T28 | Gmail OAuth and draft creation | T09, T23 | OAuth with state, encrypted token, `gmail_operations` flow, reconciliation, copy-draft fallback; N9 |
| T29 | Fixture bundles and pipeline tests | T19 | A (recorded), B1, B2, C, C fallback, D1, D2, D false positive, E, edit, edit correction; all five assertions per row (7.3) |
| T30 | Hardening and rehearsal | all | Seeded demo data, TTL override, warm-up, re-authenticate Gmail, scripted five-minute run with no manual database steps |

**Suggested parallelisation:** after T07, one developer can take T10 and T11 (pure logic and wrapper) while another takes T08 and T09 (RPCs). UI tickets T24 to T27 can start against mocked API responses once T20 and T22 contracts exist.

## H.8 Definition of done and PR checklist

- [ ] Ticket acceptance tests pass in CI; new behaviour has tests that fail without the change.
- [ ] No invariant I1 to I16 weakened; touched invariants named in the PR.
- [ ] Contract changes have a changelog entry and updated spec text.
- [ ] All DB writes go through RPC wrappers; no module-level state; works if the function is killed.
- [ ] Zod at every boundary; errors use the closed error codes.
- [ ] No secret in the repo; `.env.example` updated if a variable was added.
- [ ] UI shows gate reasons from the server and never decides approvability.
- [ ] Fixture-backed data is visibly labelled.

## H.9 Demo readiness checklist

- [ ] Demo password, session and Origin configured on the `demo` deployment.
- [ ] Seeded profile and all fixture prospects present; badge visible.
- [ ] Prospect A recorded backup exists and replays.
- [ ] Research TTL override set for rehearsed prospects (stated openly in the demo).
- [ ] Prompt versions frozen before fixtures were recorded; fixture tests pass.
- [ ] Gmail re-authenticated within 7 days of the interview; copy-draft fallback tested.
- [ ] Watchdog schedule running; `/healthz` warmed shortly before the session.
- [ ] Gemini daily cap has headroom for a full rehearsal plus the live run.
- [ ] Five-minute script rehearsed in the order in 7.4.

## H.10 Things not to do

Do not add auto-send, queues, cancel or pause, extra CRM features, or a second model provider. Do not store state in memory. Do not bypass the approval gate, even in dev. Do not let the model choose a category, ranking, or verdict. Do not overwrite hand-authored fixtures. Do not expand scope beyond the cut list in 1.6 unless the owner approves in writing.

## H.11 Open items the owner must settle before or during Phase 1

| Item | Needed by |
| --- | --- |
| Vercel plan and its function duration limit (sets `ADVANCE_BUDGET_MS`) | T03, T15 |
| Watchdog scheduler: Supabase `pg_cron` + `pg_net` (recommended) or Vercel Cron | T15 |
| Gemini model names and free-tier limits (spike result) | T11, T13 |
| Demo prospects A and C chosen (time-boxed search) | T29 |
| Gmail account used for the demo, added as OAuth test user | T28 |
| Confirm AM-4 default weights and thresholds, or supply different ones | T10 |

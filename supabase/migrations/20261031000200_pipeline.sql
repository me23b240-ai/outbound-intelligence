-- The seeded profile needs real approved claims so seller statements can be grounded.
update seller_profiles
set approved_claims = '[
  "AI Accounts Payable automation",
  "Invoice data extraction",
  "Reduced manual processing",
  "Approval workflows",
  "Invoice to PO matching",
  "Payment visibility",
  "Automate repetitive invoice processing and approval workflows so finance teams spend less time on manual operations"
]'::jsonb
where version = 1;

create table runs (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  trigger text not null default 'manual' check (trigger in ('manual','reverify','regenerate','fallback')),
  params jsonb not null default '{}',
  status text not null default 'running' check (status in ('queued','running','completed','needs_input','failed','interrupted')),
  current_stage text,
  needs_input_reason text,
  error jsonb,
  heartbeat_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index runs_one_active on runs (prospect_id) where status in ('queued','running');
create index runs_prospect_idx on runs (prospect_id, started_at desc);

create table run_events (
  id bigserial primary key,
  run_id uuid not null references runs(id) on delete cascade,
  prospect_id uuid not null references prospects(id),
  type text not null,
  stage text,
  level text not null default 'info' check (level in ('info','warn','error')),
  message text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index run_events_run_idx on run_events (run_id, id);

create table audit_log (
  id bigserial primary key,
  prospect_id uuid references prospects(id),
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
create index audit_prospect_idx on audit_log (prospect_id, id desc);

create table research_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  prospect_id uuid references prospects(id),
  theme text not null,
  query text not null,
  sources jsonb not null default '[]',
  finding_count int not null default 0,
  search_call_id uuid references gemini_calls(id),
  input_fingerprint text not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index research_company_current_uq on research_records (company_id, theme)
  where prospect_id is null and superseded_at is null;
create unique index research_person_current_uq on research_records (prospect_id, theme)
  where prospect_id is not null and superseded_at is null;

create table signal_extractions (
  id uuid primary key default gen_random_uuid(),
  research_record_id uuid not null references research_records(id),
  input_fingerprint text not null,
  stage_version text not null,
  result_count int not null default 0,
  status text not null default 'complete',
  gemini_call_id uuid references gemini_calls(id),
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index extraction_current_uq on signal_extractions (research_record_id) where superseded_at is null;

create table signals (
  id uuid primary key default gen_random_uuid(),
  extraction_id uuid not null references signal_extractions(id),
  research_record_id uuid not null references research_records(id),
  company_id uuid references companies(id),
  prospect_id uuid references prospects(id),
  claim text not null,
  signal_type text not null check (signal_type in ('funding','expansion','ap_hiring','erp_transformation','exec_statement','growth','other')),
  scope text not null check (scope in ('company','person')),
  event_date date,
  date_precision text not null default 'unknown' check (date_precision in ('day','month','year','unknown')),
  date_source text check (date_source in ('stated','published')),
  source_url text,
  source_title text,
  evidence_quote text not null,
  sensitivity_model text not null default 'none',
  sensitivity_keyword text not null default 'none',
  sensitivity_effective text not null default 'none' check (sensitivity_effective in ('none','tone_review_required','blocked')),
  sensitivity_category text not null default 'none',
  status text not null check (status in ('valid','rejected')),
  rejection_reason text check (rejection_reason in ('unverifiable_source','unparseable_date','blocked_category','duplicate')),
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (extraction_id, content_hash)
);
create index signals_extraction_idx on signals (extraction_id);

create table hook_selections (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  seller_profile_id uuid not null references seller_profiles(id),
  scoring_fingerprint text not null,
  selection_fingerprint text not null,
  scored_signals jsonb not null default '[]',
  chosen_signal_id uuid references signals(id),
  signal_strength text not null check (signal_strength in ('strong','moderate','insufficient')),
  persona_unassessed boolean not null default false,
  tone_constraints jsonb,
  person_specific boolean not null default false,
  scoring_call_id uuid references gemini_calls(id),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (prospect_id, selection_fingerprint)
);
create unique index hook_current_uq on hook_selections (prospect_id) where superseded_at is null;
create index hook_scoring_idx on hook_selections (prospect_id, scoring_fingerprint, created_at desc);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  channel text not null default 'email' check (channel in ('email')),
  lane text not null check (lane in ('personalised','fallback')),
  version int not null,
  parent_draft_id uuid references drafts(id),
  origin text not null check (origin in ('generated','regenerated','edited','fallback')),
  subject text not null,
  body text not null,
  hook_selection_id uuid references hook_selections(id),
  verification_id uuid references verifications(id),
  signal_id uuid references signals(id),
  is_generic_fallback boolean not null default false,
  fallback_persona text,
  person_specific boolean not null default false,
  identity_state text not null default 'unknown',
  constraint_failed boolean not null default false,
  constraint_violations jsonb not null default '[]',
  requires_tone_ack boolean not null default false,
  tone_ack_at timestamptz,
  status text not null default 'review' check (status in ('review','approved','rejected','gmail_draft')),
  approved_at timestamptz,
  approved_against jsonb,
  rejection_reason text,
  human_touched boolean not null default false,
  generation_fingerprint text,
  profile_hashes jsonb,
  gemini_call_id uuid references gemini_calls(id),
  created_at timestamptz not null default now(),
  unique (prospect_id, channel, lane, version)
);
create unique index drafts_generation_uq on drafts (prospect_id, channel, lane, generation_fingerprint)
  where generation_fingerprint is not null;
create index drafts_prospect_idx on drafts (prospect_id, lane, version desc);

create table grounding_checks (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references drafts(id),
  input_fingerprint text not null,
  items jsonb not null default '[]',
  rule_results jsonb not null default '[]',
  evidence_hashes jsonb not null default '{}',
  result text not null check (result in ('passed','failed')),
  gemini_call_id uuid references gemini_calls(id),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (draft_id, input_fingerprint)
);
create unique index grounding_current_uq on grounding_checks (draft_id) where superseded_at is null;

alter table runs enable row level security;
alter table run_events enable row level security;
alter table audit_log enable row level security;
alter table research_records enable row level security;
alter table signal_extractions enable row level security;
alter table signals enable row level security;
alter table hook_selections enable row level security;
alter table drafts enable row level security;
alter table grounding_checks enable row level security;

create or replace function bump_prospect(p_prospect_id uuid)
returns bigint language plpgsql as $$
declare v bigint;
begin
  update prospects set state_version = state_version + 1 where id = p_prospect_id returning state_version into v;
  return v;
end $$;

create or replace function commit_extraction(
  p_record_id uuid, p_stage_version text, p_call_id uuid, p_signals jsonb
) returns uuid language plpgsql as $$
declare ext_id uuid; rec research_records%rowtype;
begin
  select * into rec from research_records where id = p_record_id;
  if not found then raise exception 'research record not found'; end if;
  update signal_extractions set superseded_at = now()
    where research_record_id = p_record_id and superseded_at is null;
  insert into signal_extractions (research_record_id, input_fingerprint, stage_version, result_count, gemini_call_id)
  values (
    p_record_id, rec.input_fingerprint, p_stage_version,
    (select count(*) from jsonb_array_elements(p_signals) s where s->>'status' = 'valid'),
    p_call_id
  ) returning id into ext_id;
  insert into signals (
    extraction_id, research_record_id, company_id, prospect_id, claim, signal_type, scope,
    event_date, date_precision, date_source, source_url, source_title, evidence_quote,
    sensitivity_model, sensitivity_keyword, sensitivity_effective, sensitivity_category,
    status, rejection_reason, content_hash
  )
  select
    ext_id, p_record_id, rec.company_id, rec.prospect_id, s->>'claim', s->>'signal_type', s->>'scope',
    nullif(s->>'event_date', '')::date, coalesce(s->>'date_precision', 'unknown'), nullif(s->>'date_source', ''),
    s->>'source_url', s->>'source_title', s->>'evidence_quote',
    coalesce(s->>'sensitivity_model', 'none'), coalesce(s->>'sensitivity_keyword', 'none'),
    coalesce(s->>'sensitivity_effective', 'none'), coalesce(s->>'sensitivity_category', 'none'),
    s->>'status', nullif(s->>'rejection_reason', ''), s->>'content_hash'
  from jsonb_array_elements(p_signals) s;
  return ext_id;
end $$;

create or replace function approve_draft(p_draft_id uuid, p_expected_version bigint, p_approved_against jsonb)
returns jsonb language plpgsql as $$
declare d drafts%rowtype; v bigint;
begin
  select * into d from drafts where id = p_draft_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select state_version into v from prospects where id = d.prospect_id for update;
  if v <> p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'conflict');
  end if;
  update drafts
    set status = 'approved', approved_at = now(), approved_against = p_approved_against, human_touched = true
    where id = p_draft_id and status = 'review';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_in_review'); end if;
  update prospects set draft_status = 'approved', state_version = state_version + 1 where id = d.prospect_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function bump_prospect(uuid) from public, anon, authenticated;
revoke all on function commit_extraction(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function approve_draft(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function bump_prospect(uuid) to service_role;
grant execute on function commit_extraction(uuid, text, uuid, jsonb) to service_role;
grant execute on function approve_draft(uuid, bigint, jsonb) to service_role;

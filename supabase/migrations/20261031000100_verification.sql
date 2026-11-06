create table gemini_quota (
  day date primary key,
  used int not null default 0,
  cap int not null
);

create table gemini_calls (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete set null,
  stage text not null,
  call_type text not null check (call_type in ('grounded','structured')),
  model text not null,
  prompt_version text not null,
  request_payload jsonb,
  rendered_prompt text,
  response text,
  grounding_metadata jsonb,
  input_tokens int,
  output_tokens int,
  latency_ms int,
  attempt int not null default 1,
  error jsonb,
  created_at timestamptz not null default now()
);
create index gemini_calls_prospect_idx on gemini_calls (prospect_id, created_at desc);

create table verifications (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  status text not null check (status in ('verified','uncertain','mismatch','failed')),
  identity_state text not null check (identity_state in ('established','ambiguous','unknown')),
  candidates jsonb not null default '[]',
  evidence jsonb,
  confirmation jsonb,
  grounded_call_id uuid references gemini_calls(id),
  parse_call_id uuid references gemini_calls(id),
  input_fingerprint text not null,
  stage_version text not null,
  expires_at timestamptz not null,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index verifications_current_uq on verifications (prospect_id) where superseded_at is null;

alter table gemini_quota enable row level security;
alter table gemini_calls enable row level security;
alter table verifications enable row level security;

create or replace function reserve_gemini_call(p_day date, p_cap int)
returns boolean language plpgsql as $$
declare n int;
begin
  insert into gemini_quota (day, used, cap) values (p_day, 0, p_cap) on conflict (day) do nothing;
  update gemini_quota set used = used + 1, cap = p_cap where day = p_day and used < p_cap;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function commit_verification(
  p_prospect_id uuid, p_fingerprint text, p_stage_version text, p_payload jsonb
) returns jsonb language plpgsql as $$
declare cur record; new_id uuid;
begin
  perform 1 from prospects where id = p_prospect_id for update;
  select * into cur from verifications where prospect_id = p_prospect_id and superseded_at is null;
  if found and cur.input_fingerprint = p_fingerprint and cur.expires_at > now() then
    return jsonb_build_object('id', cur.id, 'outcome', 'unchanged');
  end if;
  if found then
    update verifications set superseded_at = now() where id = cur.id;
  end if;
  insert into verifications
    (prospect_id, status, identity_state, candidates, evidence,
     grounded_call_id, parse_call_id, input_fingerprint, stage_version, expires_at)
  values
    (p_prospect_id, p_payload->>'status', p_payload->>'identity_state',
     coalesce(p_payload->'candidates', '[]'::jsonb), p_payload->'evidence',
     (p_payload->>'grounded_call_id')::uuid, (p_payload->>'parse_call_id')::uuid,
     p_fingerprint, p_stage_version, (p_payload->>'expires_at')::timestamptz)
  returning id into new_id;
  update prospects
    set verification_status = p_payload->>'status', state_version = state_version + 1
    where id = p_prospect_id;
  return jsonb_build_object('id', new_id, 'outcome', case when found then 'refreshed' else 'created' end);
end $$;

revoke all on function reserve_gemini_call(date, int) from public, anon, authenticated;
revoke all on function commit_verification(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function reserve_gemini_call(date, int) to service_role;
grant execute on function commit_verification(uuid, text, text, jsonb) to service_role;

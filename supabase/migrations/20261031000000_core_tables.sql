create table seller_profiles (
  id uuid primary key default gen_random_uuid(),
  version int not null unique,
  is_active boolean not null default false,
  product jsonb not null,
  value_props jsonb not null,
  icp jsonb not null,
  personas jsonb not null,
  tone_rules jsonb not null,
  approved_claims jsonb not null default '[]',
  banned_claims jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create unique index one_active_profile on seller_profiles (is_active) where is_active;

create table companies (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  name_normalized text not null,
  domain text,
  canonical_website text,
  created_at timestamptz not null default now()
);
create unique index companies_domain_uq on companies (domain) where domain is not null;
create index companies_name_idx on companies (name_normalized);

create table imports (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  accepted int not null default 0,
  duplicates int not null default 0,
  invalid int not null default 0,
  row_report jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table prospects (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  company_claimed text not null,
  designation text,
  email text,
  linkedin_url text,
  name_normalized text not null,
  company_normalized text not null,
  email_normalized text,
  dedupe_key text not null,
  source text not null default 'manual' check (source in ('manual','csv')),
  import_id uuid references imports(id),
  company_id uuid references companies(id),
  company_resolution jsonb,
  fixture_id text,
  verification_status text not null default 'none',
  research_status text not null default 'none',
  draft_status text not null default 'none',
  state_version bigint not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index prospects_email_uq on prospects (email_normalized)
  where email_normalized is not null and archived_at is null;
create unique index prospects_dedupe_uq on prospects (dedupe_key)
  where archived_at is null;

alter table seller_profiles enable row level security;
alter table companies enable row level security;
alter table imports enable row level security;
alter table prospects enable row level security;

insert into seller_profiles
  (version, is_active, product, value_props, icp, personas, tone_rules, approved_claims, banned_claims)
values (
  1, true,
  '{"category":"AI Accounts Payable automation","capabilities":["Invoice data extraction","Reduced manual processing","Approval workflows","Invoice to PO matching","Payment visibility"]}',
  '["Automate repetitive invoice processing and approval workflows so finance teams spend less time on manual operations"]',
  '{"segments":["Mid-market","Enterprise"],"traits":["High invoice volumes","Scaling finance operations"]}',
  '["CFO","VP Finance","Head of Finance Operations","AP Manager","Financial Controller"]',
  '{"style":"Insight-led, conversational, specific","rules":["Never assume a problem exists because a company-level signal exists"]}',
  '[]',
  '["guaranteed savings","industry-leading","100% accurate"]'
);

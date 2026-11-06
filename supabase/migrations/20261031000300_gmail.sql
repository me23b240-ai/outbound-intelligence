create table gmail_credentials (
  id int primary key default 1 check (id = 1),
  email text,
  refresh_token_enc text not null,
  scope text,
  created_at timestamptz not null default now()
);

create table gmail_drafts (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null unique references drafts(id),
  prospect_id uuid not null references prospects(id),
  status text not null check (status in ('creating','created','unknown','failed')),
  gmail_draft_id text,
  gmail_message_id text,
  gmail_thread_id text,
  to_email text,
  message_id_header text,
  attempts int not null default 1,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table gmail_credentials enable row level security;
alter table gmail_drafts enable row level security;

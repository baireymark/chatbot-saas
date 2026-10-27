-- Run once per database (safe to re-run). Paste into the Supabase SQL editor,
-- or run `npm run db:migrate` with DATABASE_URL set.

create table if not exists tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  public_key    text unique not null,
  secret_hash   text not null,
  system_prompt text not null default '',
  greeting      text not null,
  color         text not null,
  lead_webhook  text,
  created_at    timestamptz not null default now()
);

create table if not exists tenant_origins (
  origin    text not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  primary key (origin, tenant_id)
);
create index if not exists idx_origin on tenant_origins(origin);

create table if not exists documents (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  title      text not null,
  content    text not null,
  created_at timestamptz not null default now()
);

create table if not exists chunks (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  document_id bigint not null references documents(id) on delete cascade,
  text        text not null
);
create index if not exists idx_chunks_tenant on chunks(tenant_id);

create table if not exists messages (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id text not null,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  needs_human     boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists idx_messages_conv on messages(tenant_id, conversation_id);

create table if not exists leads (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id text,
  name            text,
  email           text,
  message         text,
  created_at      timestamptz not null default now()
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  email         text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  hits         integer not null
);

-- Supabase exposes public tables through its REST API using the anon key.
-- Enabling RLS with no policies blocks that access. The server connects as the
-- table owner, which bypasses RLS, so the app keeps working.
alter table tenants enable row level security;
alter table tenant_origins enable row level security;
alter table documents enable row level security;
alter table chunks enable row level security;
alter table messages enable row level security;
alter table leads enable row level security;
alter table users enable row level security;
alter table sessions enable row level security;
alter table rate_limits enable row level security;

-- ludo-pvp/server/schema.sql — Stage 3.1b
-- Idempotent. Safe to run more than once.
-- Creates: users, sessions, matches, moves.
-- Enables Row Level Security on all tables.
-- No table is accessible via the anon key.
-- Only the service_role key (server-only, in .env) can read/write.

-- ------------------------------------------------------------------
-- Extension for gen_random_uuid() (already present on Supabase, kept
-- here for safety when running against other Postgres instances).
-- ------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ------------------------------------------------------------------
-- users
-- ------------------------------------------------------------------
create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  username       text not null,
  email          text not null,
  password_hash  text not null,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz,
  constraint users_username_len   check (char_length(username) between 3 and 20),
  constraint users_username_chars check (username ~ '^[a-z0-9_]+$'),
  constraint users_email_chars    check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
create unique index if not exists users_username_uq on public.users (lower(username));
create unique index if not exists users_email_uq    on public.users (lower(email));

-- ------------------------------------------------------------------
-- sessions
--   token_hash is SHA-256 hex of the JWT we issue to the user.
--   We do not store the raw JWT — if the DB is ever dumped, tokens
--   cannot be replayed.
-- ------------------------------------------------------------------
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  token_hash  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  constraint sessions_token_hash_len check (char_length(token_hash) = 64)
);
create unique index if not exists sessions_token_hash_uq on public.sessions (token_hash);
create index        if not exists sessions_user_idx       on public.sessions (user_id);
create index        if not exists sessions_expires_idx    on public.sessions (expires_at);

-- ------------------------------------------------------------------
-- matches
-- ------------------------------------------------------------------
create table if not exists public.matches (
  id              uuid primary key default gen_random_uuid(),
  game            text not null default 'ludo',
  red_user_id     uuid not null references public.users(id),
  yellow_user_id  uuid not null references public.users(id),
  winner          text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint matches_game_chk   check (game in ('ludo')),
  constraint matches_winner_chk check (winner in ('red','yellow') or winner is null),
  constraint matches_distinct   check (red_user_id <> yellow_user_id)
);
create index if not exists matches_red_idx    on public.matches (red_user_id);
create index if not exists matches_yellow_idx on public.matches (yellow_user_id);
create index if not exists matches_finished_idx on public.matches (finished_at);

-- ------------------------------------------------------------------
-- moves
--   state_after is the authoritative game state after this move.
--   The (match_id, seq) pair is unique — duplicate submissions are
--   rejected at the DB level, not just in app code.
-- ------------------------------------------------------------------
create table if not exists public.moves (
  id           bigserial primary key,
  match_id     uuid not null references public.matches(id) on delete cascade,
  seq          integer not null,
  color        text not null,
  dice         integer not null,
  token_id     text not null,
  captured     text,
  state_after  jsonb not null,
  at           timestamptz not null default now(),
  constraint moves_seq_chk    check (seq >= 0),
  constraint moves_color_chk  check (color in ('red','yellow')),
  constraint moves_dice_chk   check (dice between 1 and 6)
);
create unique index if not exists moves_match_seq_uq on public.moves (match_id, seq);
create index        if not exists moves_match_idx    on public.moves (match_id);

-- ------------------------------------------------------------------
-- Row Level Security
--   Enabled on all tables. With RLS enabled and NO policies for the
--   anon/authenticated roles, ordinary clients cannot read or write
--   anything. The service_role key bypasses RLS — which is the point:
--   only our server (holding the service_role key in .env) has access.
-- ------------------------------------------------------------------
alter table public.users    enable row level security;
alter table public.sessions enable row level security;
alter table public.matches  enable row level security;
alter table public.moves    enable row level security;

-- ------------------------------------------------------------------
-- Verification query — should return the four table names.
-- ------------------------------------------------------------------
select tablename
from pg_tables
where schemaname = 'public'
  and tablename in ('users','sessions','matches','moves')
order by tablename;

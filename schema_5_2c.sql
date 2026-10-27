-- ludo-pvp-server/schema_5_2c.sql — Stage 5.2c profiles
-- Idempotent: safe to run more than once.
-- Adds optional profile fields to public.users.

alter table public.users add column if not exists country    text;
alter table public.users add column if not exists city       text;
alter table public.users add column if not exists age        integer;
alter table public.users add column if not exists about      text;
alter table public.users add column if not exists likes      text;

-- Constraints (only if not already present — Postgres does not support
-- "add constraint if not exists" directly, so we use a DO block).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_age_chk'
  ) then
    alter table public.users
      add constraint users_age_chk check (age is null or (age between 13 and 120));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'users_about_len_chk'
  ) then
    alter table public.users
      add constraint users_about_len_chk check (about is null or char_length(about) <= 500);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'users_likes_len_chk'
  ) then
    alter table public.users
      add constraint users_likes_len_chk check (likes is null or char_length(likes) <= 300);
  end if;
end $$;

-- Verification — should list the new columns.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'users'
  and column_name in ('country','city','age','about','likes')
order by column_name;

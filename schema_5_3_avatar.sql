-- Stage 5.3: Player profile avatars
-- Safe to run more than once; existing profiles are preserved.

alter table public.users
  add column if not exists avatar text;

-- Only allow the built-in avatar IDs.
alter table public.users
  drop constraint if exists users_avatar_chk;

alter table public.users
  add constraint users_avatar_chk
  check (
    avatar is null or
    avatar in (
      'avatar-1',
      'avatar-2',
      'avatar-3',
      'avatar-4',
      'avatar-5',
      'avatar-6',
      'avatar-7',
      'avatar-8'
    )
  );

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'users'
  and column_name = 'avatar';

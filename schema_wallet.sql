-- ludo-pvp-server/schema_wallet.sql
-- Phase 1: MH Coin wallet (DEMO ONLY, integer minor units).
-- Idempotent: safe to run more than once.
-- Adds: wallets, wallet_transactions, admin_audit_log, and 5 Postgres functions.

-- ============================================================
-- 1) wallets — one row per user. balance_minor in 1/100 MHC.
--    reserved_minor = funds held for pending withdrawals.
--    Invariants enforced at the DB level:
--      balance_minor  >= 0
--      reserved_minor >= 0
--      reserved_minor <= balance_minor
-- ============================================================
create table if not exists public.wallets (
  user_id         uuid primary key references public.users(id) on delete cascade,
  balance_minor   bigint not null default 0 check (balance_minor   >= 0),
  reserved_minor  bigint not null default 0 check (reserved_minor  >= 0),
  updated_at      timestamptz not null default now(),
  constraint wallets_reserved_le_balance check (reserved_minor <= balance_minor)
);

-- ============================================================
-- 2) wallet_transactions — one row per requested or applied change.
--    reference is UNIQUE — this is the idempotency key.
--    is_demo is always true in this phase.
-- ============================================================
create table if not exists public.wallet_transactions (
  id            bigserial primary key,
  user_id       uuid not null references public.users(id) on delete cascade,
  kind          text not null check (kind in ('deposit','withdraw','admin_credit','admin_debit','refund')),
  amount_minor  bigint not null check (amount_minor > 0),
  status        text not null check (status in ('pending','approved','rejected')),
  reference     text not null unique,
  admin_id      uuid references public.users(id),
  admin_note    text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  is_demo       boolean not null default true
);
create index if not exists wallet_tx_user_idx     on public.wallet_transactions (user_id, created_at desc);
create index if not exists wallet_tx_status_idx   on public.wallet_transactions (status);
create index if not exists wallet_tx_ref_idx      on public.wallet_transactions (reference);

-- ============================================================
-- 3) admin_audit_log — every admin action written permanently.
-- ============================================================
create table if not exists public.admin_audit_log (
  id              bigserial primary key,
  admin_id        uuid not null references public.users(id),
  action          text not null,
  target_user_id  uuid references public.users(id),
  amount_minor    bigint,
  reference       text,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_admin_idx   on public.admin_audit_log (admin_id, created_at desc);

-- ============================================================
-- 4) Row Level Security — same policy as existing tables.
--    RLS enabled, no anon policies. Only service_role can write.
-- ============================================================
alter table public.wallets             enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.admin_audit_log     enable row level security;

-- ============================================================
-- 5) Postgres functions — the atomic core.
--    Every balance change goes through one of these. They run
--    in a single transaction, use SELECT ... FOR UPDATE, and
--    cannot be called twice for the same reference.
-- ============================================================

-- 5a) fn_wallet_request_withdraw — reserve funds, insert pending row.
create or replace function public.fn_wallet_request_withdraw(
  p_user_id      uuid,
  p_amount_minor bigint,
  p_reference    text,
  p_note         text
) returns table (txn_id bigint, new_balance bigint, new_reserved bigint)
language plpgsql as $$
declare
  v_balance  bigint;
  v_reserved bigint;
  v_txn_id   bigint;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'bad_amount';
  end if;

  -- Lock the wallet row for the duration of this transaction.
  select balance_minor, reserved_minor
    into v_balance, v_reserved
    from public.wallets
   where user_id = p_user_id
   for update;

  if not found then
    raise exception 'wallet_not_found';
  end if;

  if (v_balance - v_reserved) < p_amount_minor then
    raise exception 'insufficient_funds';
  end if;

  update public.wallets
     set reserved_minor = reserved_minor + p_amount_minor,
         updated_at     = now()
   where user_id = p_user_id;

  insert into public.wallet_transactions (user_id, kind, amount_minor, status, reference, admin_note)
  values (p_user_id, 'withdraw', p_amount_minor, 'pending', p_reference, p_note)
  returning id into v_txn_id;

  return query select v_txn_id, v_balance, v_reserved + p_amount_minor;
end;
$$;

-- 5b) fn_wallet_deposit_approve — credit balance on admin approval.
create or replace function public.fn_wallet_deposit_approve(
  p_txn_id   bigint,
  p_admin_id uuid,
  p_note     text
) returns table (new_balance bigint)
language plpgsql as $$
declare
  v_user_id      uuid;
  v_amount       bigint;
  v_status       text;
  v_kind         text;
  v_new_balance  bigint;
begin
  select user_id, amount_minor, status, kind
    into v_user_id, v_amount, v_status, v_kind
    from public.wallet_transactions
   where id = p_txn_id
   for update;

  if not found then raise exception 'txn_not_found'; end if;
  if v_status <> 'pending' then raise exception 'txn_not_pending'; end if;
  if v_kind  <> 'deposit'  then raise exception 'txn_not_deposit'; end if;

  select balance_minor into v_new_balance
    from public.wallets
   where user_id = v_user_id
   for update;
  if not found then raise exception 'wallet_not_found'; end if;

  update public.wallets
     set balance_minor = balance_minor + v_amount,
         updated_at    = now()
   where user_id = v_user_id
   returning balance_minor into v_new_balance;

  update public.wallet_transactions
     set status = 'approved',
         admin_id = p_admin_id,
         admin_note = p_note,
         decided_at = now()
   where id = p_txn_id;

  insert into public.admin_audit_log (admin_id, action, target_user_id, amount_minor, reference, note)
  select p_admin_id, 'approve_deposit', v_user_id, v_amount, reference, p_note
    from public.wallet_transactions where id = p_txn_id;

  return query select v_new_balance;
end;
$$;

-- 5c) fn_wallet_withdraw_approve — deduct balance and release reservation.
create or replace function public.fn_wallet_withdraw_approve(
  p_txn_id   bigint,
  p_admin_id uuid,
  p_note     text
) returns table (new_balance bigint, new_reserved bigint)
language plpgsql as $$
declare
  v_user_id      uuid;
  v_amount       bigint;
  v_status       text;
  v_kind         text;
  v_new_balance  bigint;
  v_new_reserved bigint;
begin
  select user_id, amount_minor, status, kind
    into v_user_id, v_amount, v_status, v_kind
    from public.wallet_transactions
   where id = p_txn_id
   for update;

  if not found then raise exception 'txn_not_found'; end if;
  if v_status <> 'pending' then raise exception 'txn_not_pending'; end if;
  if v_kind  <> 'withdraw' then raise exception 'txn_not_withdraw'; end if;

  select balance_minor, reserved_minor
    into v_new_balance, v_new_reserved
    from public.wallets
   where user_id = v_user_id
   for update;
  if not found then raise exception 'wallet_not_found'; end if;

  if v_new_reserved < v_amount then raise exception 'reserved_mismatch'; end if;

  update public.wallets
     set balance_minor  = balance_minor - v_amount,
         reserved_minor = reserved_minor - v_amount,
         updated_at     = now()
   where user_id = v_user_id
   returning balance_minor, reserved_minor
     into v_new_balance, v_new_reserved;

  update public.wallet_transactions
     set status = 'approved',
         admin_id = p_admin_id,
         admin_note = p_note,
         decided_at = now()
   where id = p_txn_id;

  insert into public.admin_audit_log (admin_id, action, target_user_id, amount_minor, reference, note)
  select p_admin_id, 'approve_withdraw', v_user_id, v_amount, reference, p_note
    from public.wallet_transactions where id = p_txn_id;

  return query select v_new_balance, v_new_reserved;
end;
$$;

-- 5d) fn_wallet_withdraw_reject — release reservation.
create or replace function public.fn_wallet_withdraw_reject(
  p_txn_id   bigint,
  p_admin_id uuid,
  p_note     text
) returns table (new_balance bigint, new_reserved bigint)
language plpgsql as $$
declare
  v_user_id      uuid;
  v_amount       bigint;
  v_status       text;
  v_kind         text;
  v_new_balance  bigint;
  v_new_reserved bigint;
begin
  select user_id, amount_minor, status, kind
    into v_user_id, v_amount, v_status, v_kind
    from public.wallet_transactions
   where id = p_txn_id
   for update;

  if not found then raise exception 'txn_not_found'; end if;
  if v_status <> 'pending' then raise exception 'txn_not_pending'; end if;
  if v_kind  <> 'withdraw' then raise exception 'txn_not_withdraw'; end if;

  select balance_minor, reserved_minor
    into v_new_balance, v_new_reserved
    from public.wallets
   where user_id = v_user_id
   for update;
  if not found then raise exception 'wallet_not_found'; end if;

  update public.wallets
     set reserved_minor = reserved_minor - v_amount,
         updated_at     = now()
   where user_id = v_user_id
   returning balance_minor, reserved_minor
     into v_new_balance, v_new_reserved;

  update public.wallet_transactions
     set status = 'rejected',
         admin_id = p_admin_id,
         admin_note = p_note,
         decided_at = now()
   where id = p_txn_id;

  insert into public.admin_audit_log (admin_id, action, target_user_id, amount_minor, reference, note)
  select p_admin_id, 'reject_withdraw', v_user_id, v_amount, reference, p_note
    from public.wallet_transactions where id = p_txn_id;

  return query select v_new_balance, v_new_reserved;
end;
$$;

-- 5e) fn_wallet_deposit_reject — mark pending deposit rejected (no balance change).
create or replace function public.fn_wallet_deposit_reject(
  p_txn_id   bigint,
  p_admin_id uuid,
  p_note     text
) returns void
language plpgsql as $$
declare
  v_user_id uuid;
  v_amount  bigint;
  v_status  text;
  v_kind    text;
begin
  select user_id, amount_minor, status, kind
    into v_user_id, v_amount, v_status, v_kind
    from public.wallet_transactions
   where id = p_txn_id
   for update;

  if not found then raise exception 'txn_not_found'; end if;
  if v_status <> 'pending' then raise exception 'txn_not_pending'; end if;
  if v_kind  <> 'deposit'  then raise exception 'txn_not_deposit'; end if;

  update public.wallet_transactions
     set status = 'rejected',
         admin_id = p_admin_id,
         admin_note = p_note,
         decided_at = now()
   where id = p_txn_id;

  insert into public.admin_audit_log (admin_id, action, target_user_id, amount_minor, reference, note)
  select p_admin_id, 'reject_deposit', v_user_id, v_amount, reference, p_note
    from public.wallet_transactions where id = p_txn_id;
end;
$$;

-- ============================================================
-- 6) Verification — should return: wallets, wallet_transactions,
--    admin_audit_log, plus the five functions.
-- ============================================================
select 'table' as type, tablename as name
from pg_tables
where schemaname = 'public'
  and tablename in ('wallets','wallet_transactions','admin_audit_log')
union all
select 'function', proname
from pg_proc
where proname in (
  'fn_wallet_request_withdraw',
  'fn_wallet_deposit_approve',
  'fn_wallet_withdraw_approve',
  'fn_wallet_withdraw_reject',
  'fn_wallet_deposit_reject'
)
order by type, name;

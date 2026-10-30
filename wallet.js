// ludo-pvp-server/wallet.js — MH Coin wallet (DEMO ONLY, integer minor units).
// All balance-changing operations live here and only here.
// Every write goes through a Postgres function (fn_wallet_*) which runs
// inside a transaction with SELECT ... FOR UPDATE. No floats. No client
// writes. No direct updates to public.wallets from anywhere else.

import crypto from 'crypto';
import { supabase } from './supabase.js';

// ---------- helpers ----------

// Reference is the idempotency key. Every request gets a fresh unique value.
// A duplicate reference is rejected by the DB UNIQUE constraint.
export function newReference(prefix) {
  const rand = crypto.randomBytes(12).toString('hex');
  const ts   = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

function intMinor(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Map Postgres errors from the fn_wallet_* functions to stable error codes.
function mapRpcError(err) {
  const msg = (err && (err.message || err.error_description || '')) + '';
  const known = [
    'bad_amount',
    'wallet_not_found',
    'insufficient_funds',
    'reserved_mismatch',
    'txn_not_found',
    'txn_not_pending',
    'txn_not_deposit',
    'txn_not_withdraw',
    'duplicate_reference',
  ];
  for (const k of known) if (msg.includes(k)) return k;
  return 'db_error';
}

// ---------- reads ----------

// Create the wallet row on first use. Safe to call any time.
export async function getOrCreateWallet(userId) {
  if (!userId) throw new Error('missing_user_id');

  // Try insert-if-missing; ON CONFLICT DO NOTHING is enforced via upsert.
  const { error: upErr } = await supabase
    .from('wallets')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (upErr && !/duplicate key/i.test(upErr.message || '')) {
    throw new Error('wallet_create_failed: ' + (upErr.message || 'unknown'));
  }

  const { data, error } = await supabase
    .from('wallets')
    .select('user_id, balance_minor, reserved_minor, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error('wallet_read_failed: ' + error.message);
  if (!data) throw new Error('wallet_not_found');
  return data;
}

export async function getWallet(userId) {
  if (!userId) throw new Error('missing_user_id');
  const { data, error } = await supabase
    .from('wallets')
    .select('user_id, balance_minor, reserved_minor, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error('wallet_read_failed: ' + error.message);
  return data; // null if no wallet yet — callers should call getOrCreateWallet
}

export async function listTransactions(userId, limit = 20, before = null) {
  if (!userId) throw new Error('missing_user_id');
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);

  let q = supabase
    .from('wallet_transactions')
    .select('id, kind, amount_minor, status, reference, admin_note, created_at, decided_at, is_demo')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(cap);

  if (before) q = q.lt('created_at', before);

  const { data, error } = await q;
  if (error) throw new Error('txn_list_failed: ' + error.message);
  return data || [];
}

// ---------- deposit request (no balance change) ----------

// Creates a pending deposit. The admin approves later, which is the ONLY
// point at which the balance increases.
export async function createDepositRequest(userId, amountMinor, note) {
  const amount = intMinor(amountMinor);
  if (amount === null) throw new Error('bad_amount');

  const reference = newReference('dep');

  const { data, error } = await supabase
    .from('wallet_transactions')
    .insert({
      user_id: userId,
      kind: 'deposit',
      amount_minor: amount,
      status: 'pending',
      reference,
      admin_note: note || null,
    })
    .select('id, status, reference')
    .single();

  if (error) {
    if (/duplicate key/i.test(error.message || '')) throw new Error('duplicate_reference');
    throw new Error('deposit_insert_failed: ' + error.message);
  }
  return data;
}

// ---------- withdraw request (reserves funds atomically) ----------

export async function createWithdrawRequest(userId, amountMinor, note) {
  const amount = intMinor(amountMinor);
  if (amount === null) throw new Error('bad_amount');

  // Ensure a wallet exists — otherwise fn_wallet_request_withdraw raises.
  await getOrCreateWallet(userId);

  const reference = newReference('wd');

  const { data, error } = await supabase.rpc('fn_wallet_request_withdraw', {
    p_user_id: userId,
    p_amount_minor: amount,
    p_reference: reference,
    p_note: note || null,
  });

  if (error) {
    const code = mapRpcError(error);
    throw new Error(code);
  }
  // data is an array of one row (returns table). Grab the row.
  const row = Array.isArray(data) ? data[0] : data;
  return { txn_id: row.txn_id, new_balance: row.new_balance, new_reserved: row.new_reserved, reference };
}

// ---------- admin approvals ----------

export async function approveDeposit(txnId, adminId, note) {
  if (!Number.isInteger(Number(txnId))) throw new Error('bad_txn_id');
  if (!adminId) throw new Error('missing_admin_id');

  const { data, error } = await supabase.rpc('fn_wallet_deposit_approve', {
    p_txn_id: Number(txnId),
    p_admin_id: adminId,
    p_note: note || null,
  });
  if (error) throw new Error(mapRpcError(error));
  const row = Array.isArray(data) ? data[0] : data;
  return { new_balance: row.new_balance };
}

export async function rejectDeposit(txnId, adminId, note) {
  if (!Number.isInteger(Number(txnId))) throw new Error('bad_txn_id');
  if (!adminId) throw new Error('missing_admin_id');

  const { error } = await supabase.rpc('fn_wallet_deposit_reject', {
    p_txn_id: Number(txnId),
    p_admin_id: adminId,
    p_note: note || null,
  });
  if (error) throw new Error(mapRpcError(error));
  return { ok: true };
}

export async function approveWithdraw(txnId, adminId, note) {
  if (!Number.isInteger(Number(txnId))) throw new Error('bad_txn_id');
  if (!adminId) throw new Error('missing_admin_id');

  const { data, error } = await supabase.rpc('fn_wallet_withdraw_approve', {
    p_txn_id: Number(txnId),
    p_admin_id: adminId,
    p_note: note || null,
  });
  if (error) throw new Error(mapRpcError(error));
  const row = Array.isArray(data) ? data[0] : data;
  return { new_balance: row.new_balance, new_reserved: row.new_reserved };
}

export async function rejectWithdraw(txnId, adminId, note) {
  if (!Number.isInteger(Number(txnId))) throw new Error('bad_txn_id');
  if (!adminId) throw new Error('missing_admin_id');

  const { data, error } = await supabase.rpc('fn_wallet_withdraw_reject', {
    p_txn_id: Number(txnId),
    p_admin_id: adminId,
    p_note: note || null,
  });
  if (error) throw new Error(mapRpcError(error));
  const row = Array.isArray(data) ? data[0] : data;
  return { new_balance: row.new_balance, new_reserved: row.new_reserved };
}

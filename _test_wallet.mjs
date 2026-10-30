import { getOrCreateWallet, getWallet, listTransactions, createDepositRequest } from './wallet.js';

// 1) Log in as tester1 to get their user_id via /me.
async function getUserId() {
  const login = await fetch('https://ludo-pvp-server-2.onrender.com/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username_or_email: 'tester1', password: 'hello1234' }),
  });
  const lj = await login.json();
  if (!lj.token) throw new Error('login failed: ' + JSON.stringify(lj));
  const me = await fetch('https://ludo-pvp-server-2.onrender.com/me', {
    headers: { Authorization: 'Bearer ' + lj.token },
  });
  const mj = await me.json();
  if (!mj.user) throw new Error('/me failed: ' + JSON.stringify(mj));
  return mj.user.id;
}

const uid = await getUserId();
console.log('user_id:', uid);

// 2) Wallet created with zero.
const w1 = await getOrCreateWallet(uid);
console.log('wallet after create:', { balance_minor: w1.balance_minor, reserved_minor: w1.reserved_minor });

// 3) Create a deposit request for 5000 minor = 50.00 MHC.
const dep = await createDepositRequest(uid, 5000, 'test deposit');
console.log('deposit request:', dep);

// 4) Balance must NOT have changed.
const w2 = await getWallet(uid);
console.log('wallet after deposit request:', { balance_minor: w2.balance_minor, reserved_minor: w2.reserved_minor });
if (w2.balance_minor !== w1.balance_minor) {
  console.log('FAIL: balance changed on deposit request');
  process.exit(1);
}

// 5) Transactions list should include the pending deposit.
const txns = await listTransactions(uid, 5);
console.log('recent transactions:', txns.map(t => ({ id: t.id, kind: t.kind, amount_minor: t.amount_minor, status: t.status, reference: t.reference })));

// 6) Try a second deposit — should succeed as a new pending row (different reference).
const dep2 = await createDepositRequest(uid, 1000, 'test deposit 2');
console.log('deposit request 2:', dep2);

// 7) Final check.
const w3 = await getWallet(uid);
console.log('wallet final:', { balance_minor: w3.balance_minor, reserved_minor: w3.reserved_minor });

if (w3.balance_minor !== 0) {
  console.log('FAIL: balance should still be 0 (no approvals given)');
  process.exit(1);
}
console.log('PASS: wallet + deposit requests work; balance untouched');

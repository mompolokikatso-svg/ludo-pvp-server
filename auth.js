// ludo-pvp/server/auth.js — minimal HS256 JWT + password + hash helpers
// Uses only Node's built-in crypto. No external JWT library needed.
//
// Token shape: header.payload.signature (base64url), signed with HMAC-SHA256.
// This is exactly the standard JWT HS256 format, so any JWT library can
// verify it. We only need to sign and verify locally.

import crypto from 'crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/') + pad, 'base64');
}

export function signJwt(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const data   = header + '.' + claims;
  const sig    = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return data + '.' + sig;
}

export function verifyJwt(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, c, s] = parts;
  const data = h + '.' + c;
  const expected = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  // constant-time comparison
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(b64urlDecode(c).toString('utf8')); }
  catch { return null; }
  if (typeof body.exp !== 'number' || Math.floor(Date.now()/1000) >= body.exp) return null;
  return body;
}

export function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function newSessionToken(secret) {
  // 7 days
  return signJwt({ typ: 'session' }, secret, 7 * 24 * 3600);
}

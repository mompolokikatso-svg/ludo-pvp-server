// ludo-pvp/server/supabase.js — Supabase client (service-role)
// Reads .env once at startup and exposes a singleton client.
// NEVER import this file from anywhere inside www/ — it contains a
// service-role key path, which is server-only.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// Load .env manually — no dotenv dependency.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error('[supabase] missing server/.env — cannot start');
  process.exit(1);
}
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET']) {
  if (!env[k]) {
    console.error('[supabase] missing env var: ' + k);
    process.exit(1);
  }
}

// Use the service_role key — this bypasses RLS and is only for the server.
// If you ever expose this key to the client, the entire DB becomes writable
// by anyone. Do not do that.
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export const JWT_SECRET = env.JWT_SECRET;
console.log('[supabase] client ready — url=' + env.SUPABASE_URL);

import '../only';
import { createClient } from '@supabase/supabase-js';
import type { readServerConfig } from '../config';

/** Trusted workers only. Never use for browser reads or forward caller auth headers. */
export function createPrivilegedDatabase(config: ReturnType<typeof readServerConfig>) {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }) },
  });
}

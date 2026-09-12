import { createClient } from '@supabase/supabase-js';
import type { PublicConfig } from './config';

export function createBrowserDatabase(config: PublicConfig) {
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      storage: window.sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
  });
}

import { ConfigurationError, legacyKeyRole, required, supabaseUrl } from '../config/validation.ts';

export interface PublicConfig { supabaseUrl: string; supabasePublishableKey: string }

export function readPublicConfig(env: Record<string, unknown>): PublicConfig {
  const url = supabaseUrl(env.PUBLIC_SUPABASE_URL, 'PUBLIC_SUPABASE_URL');
  const key = required(env.PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && legacyKeyRole(key) !== 'anon') {
    throw new ConfigurationError('PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable or legacy anon key. Privileged keys are forbidden.');
  }
  return { supabaseUrl: url, supabasePublishableKey: key };
}

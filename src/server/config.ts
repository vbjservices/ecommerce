import './only';
import { ConfigurationError, legacyKeyRole, required, supabaseUrl } from '../config/validation';

export function readServerConfig(env: Record<string, unknown>) {
  const url = supabaseUrl(env.SUPABASE_URL, 'SUPABASE_URL');
  const key = required(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(key) && legacyKeyRole(key) !== 'service_role') {
    throw new ConfigurationError('SUPABASE_SERVICE_ROLE_KEY must be a secret or legacy service-role key.');
  }
  return { supabaseUrl: url, serviceRoleKey: key };
}

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

export function readCjConfig(env: Record<string, unknown>) {
  return { apiKey: required(env.CJ_API_KEY, 'CJ_API_KEY') };
}

export function readOptionalOllamaConfig(env: Record<string, unknown>) {
  const rawUrl = typeof env.OLLAMA_BASE_URL === 'string' ? env.OLLAMA_BASE_URL.trim() : '';
  const model = typeof env.OLLAMA_MODEL === 'string' ? env.OLLAMA_MODEL.trim() : '';
  if (!rawUrl && !model) return null;
  if (!rawUrl || !model) throw new ConfigurationError('OLLAMA_BASE_URL and OLLAMA_MODEL must be configured together.');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ConfigurationError('OLLAMA_BASE_URL must be a valid HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new ConfigurationError('OLLAMA_BASE_URL must be a valid HTTP(S) origin.');
  }
  if (model.length > 200) throw new ConfigurationError('OLLAMA_MODEL is invalid.');
  return { baseUrl: url.origin, model };
}

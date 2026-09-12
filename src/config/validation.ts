export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigurationError'; }
}

export function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigurationError(`Missing ${name}. See .env.example and docs/setup.md.`);
  }
  return value.trim();
}

export function supabaseUrl(value: unknown, name: string): string {
  const raw = required(value, name);
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new ConfigurationError(`${name} must be an HTTPS origin (HTTP is allowed for localhost).`);
  }
}

export function legacyKeyRole(key: string): unknown {
  try {
    const payload = key.split('.')[1];
    if (!payload) return null;
    return (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown }).role;
  } catch { return null; }
}

import type { SupabaseClient } from '@supabase/supabase-js';

export type Access =
  | { status: 'signed_out' }
  | { status: 'denied' }
  | { status: 'authorized'; email: string };

export async function checkAccess(client: SupabaseClient): Promise<Access> {
  const session = await client.auth.getSession();
  if (session.error) throw new Error('Your session could not be checked. Try signing in again.');
  if (!session.data.session) return { status: 'signed_out' };
  // Validate the token with Auth; local session presence alone is not authorization.
  const user = await client.auth.getUser();
  if (user.error || !user.data.user) throw new Error('Your session could not be verified. Sign in again.');
  const membership = await client.rpc('is_internal_user');
  if (membership.error) throw new Error('Workspace access could not be checked. Ask an administrator to check the database setup.');
  if (membership.data !== true) return { status: 'denied' };
  return { status: 'authorized', email: user.data.user.email ?? 'Internal user' };
}

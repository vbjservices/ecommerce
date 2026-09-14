import type { Access } from './auth';
import type { CandidateSummary } from './workspace-repository';

export const WORKSPACE_CACHE_TTL_MS = 5 * 60 * 1_000;

export interface WorkspaceSnapshot {
  access: Extract<Access, { status: 'authorized' }>;
  candidates: CandidateSummary[];
  fetchedAt: number;
}

/** Cache only for the lifetime of this page. Authenticated data never enters web storage. */
export function isWorkspaceSnapshotFresh(
  snapshot: WorkspaceSnapshot | null,
  now = Date.now(),
): snapshot is WorkspaceSnapshot {
  return snapshot !== null && now >= snapshot.fetchedAt && now - snapshot.fetchedAt < WORKSPACE_CACHE_TTL_MS;
}

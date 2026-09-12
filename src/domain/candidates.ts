import type { Id, Timestamp } from './shared';

export const candidateStatuses = [
  'discovered', 'ingesting', 'ready_for_analysis', 'analyzing',
  'ready_for_review', 'approved', 'rejected', 'failed', 'archived',
] as const;
export type CandidateStatus = typeof candidateStatuses[number];

/** Review state is independent of any channel's listing/publication state. */
export interface Candidate {
  id: Id;
  productId: Id;
  supplierProductId: Id;
  status: CandidateStatus;
  createdAt: Timestamp;
  reviewedAt: Timestamp | null;
  reviewedBy: Id | null;
}

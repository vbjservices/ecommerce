import type { Id, Timestamp } from './shared';

/** A configured channel connection/store, separate from its adapter provider. */
export interface SalesChannel { id: Id; provider: string; name: string }
export interface ChannelListing {
  salesChannelId: Id;
  productId: Id;
  externalListingId: string;
  status: 'draft' | 'active' | 'archived' | 'unknown';
  observedAt: Timestamp;
  variants: Array<{ productVariantId: Id; externalVariantId: string }>;
}

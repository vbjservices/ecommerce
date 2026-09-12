import type { Product, ProductVariant } from '../../domain/products';
import type { ChannelListing } from '../../domain/sales-channels';
import type { Id } from '../../domain/shared';

export interface SalesChannelAdapter {
  provider: string;
  /** Absent when a channel cannot create a non-public draft. Never fall back to live. */
  drafts?: {
    create(input: {
      salesChannelId: Id;
      product: Product;
      variants: ProductVariant[];
      idempotencyKey: string;
    }): Promise<ChannelListing & { status: 'draft' }>;
  };
  listings?: {
    get(externalListingId: string): Promise<ChannelListing>;
  };
}

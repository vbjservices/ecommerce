import type { Id, Money, Timestamp } from './shared';

/** Boundary only. Persistence and fulfillment workflows follow in later migrations. */
export interface Order {
  id: Id;
  salesChannelId: Id;
  externalOrderId: string;
  receivedAt: Timestamp;
  lines: Array<{
    id: Id;
    externalLineId: string;
    productVariantId: Id | null; // Unmapped means review, never guess.
    quantity: number;
    unitPrice: Money;
  }>;
}
export interface SupplierOrderMapping {
  orderId: Id;
  supplierId: Id;
  externalOrderId: string;
}

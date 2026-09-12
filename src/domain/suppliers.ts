import type { Id, Money, Observation, Timestamp } from './shared';

export interface Supplier { id: Id; code: string; name: string }
export interface SupplierProductMapping {
  id: Id;
  supplierId: Id;
  productId: Id;
  externalProductId: string;
  sourceUrl: string | null;
  lastSeenAt: Timestamp;
}
export interface SupplierVariantMapping {
  supplierProductId: Id;
  productVariantId: Id;
  externalVariantId: string;
}

/** Normalized supplier input, not the persistent internal product identity. */
export interface SupplierProduct {
  externalProductId: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  variants: Array<{
    externalVariantId: string;
    sku: string | null;
    options: Record<string, string>;
    cost: Observation<Money>;
    stock: Observation<number>;
  }>;
}

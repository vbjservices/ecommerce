import type { Json, Timestamp } from '../../domain/shared';
import type { SupplierProduct } from '../../domain/suppliers';

export interface SupplierSnapshot {
  product: SupplierProduct;
  source: string;
  retrievedAt: Timestamp;
  rawPayload: Json; // Server-only persistence; never return this to dashboard queries.
}

/** Capability presence is the source of truth; no flags that can disagree with methods. */
export interface SupplierAdapter {
  provider: string;
  catalog?: {
    getProduct(externalProductId: string): Promise<SupplierSnapshot>;
  };
  discovery?: {
    search(input: { query: string; cursor?: string }): Promise<{
      externalProductIds: string[];
      nextCursor: string | null;
    }>;
  };
}

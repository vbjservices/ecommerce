import type { Json, Timestamp } from '../../domain/shared';
import type { SupplierDiscoveryProduct, SupplierProduct } from '../../domain/suppliers';

export interface SupplierSnapshot {
  product: SupplierProduct;
  source: string;
  retrievedAt: Timestamp;
  rawPayload: Json; // Server-only persistence; never return this to dashboard queries.
}

export interface SupplierDiscoveryInput {
  query: string;
  cursor?: string;
  limit?: number;
  sortBy?: 'relevance' | 'listings' | 'cost' | 'newest' | 'inventory';
  sortDirection?: 'asc' | 'desc';
  filters?: {
    categoryId?: string;
    warehouseCountry?: string;
    minCost?: string;
    maxCost?: string;
    minInventory?: number;
    verifiedOnly?: boolean;
    productFlag?: 'trending' | 'new' | 'video' | 'slow_moving';
    freeShipping?: boolean;
    hasCertification?: boolean;
    customizable?: boolean;
  };
}

export interface SupplierDiscoverySnapshot {
  products: SupplierDiscoveryProduct[];
  nextCursor: string | null;
  totalResults: number;
  source: string;
  retrievedAt: Timestamp;
  rawPayload: Json;
}

/** Capability presence is the source of truth; no flags that can disagree with methods. */
export interface SupplierAdapter {
  provider: string;
  providerName: string;
  catalog?: {
    getProduct(externalProductId: string): Promise<SupplierSnapshot>;
  };
  discovery?: {
    search(input: SupplierDiscoveryInput): Promise<SupplierDiscoverySnapshot>;
  };
}

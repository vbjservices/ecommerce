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
  imageUrl: string | null;
  imageUrls: string[];
  sourceUrl: string | null;
  variants: Array<{
    externalVariantId: string;
    sku: string | null;
    options: Record<string, string>;
    cost: Observation<Money>;
    stock: Observation<number>;
  }>;
}

/** Lightweight supplier facts used for discovery before full product ingestion. */
export interface SupplierDiscoveryProduct {
  externalProductId: string;
  title: string;
  supplierSku: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  sourceUrl: string;
  category: string | null;
  costRange: {
    minAmount: string;
    maxAmount: string;
    currency: string;
  } | null;
  listedCount: number | null;
  inventory: number | null;
  verifiedInventory: number | null;
  unverifiedInventory: number | null;
  createdAt: Timestamp | null;
  deliveryDays: { min: number; max: number } | null;
  hasVideo: boolean | null;
  freeShipping: boolean | null;
  customizable: boolean | null;
  personalized: boolean | null;
  hasCertification: boolean | null;
  productType: string | null;
  saleStatus: 'on_sale' | 'not_on_sale' | null;
  visible: boolean | null;
}

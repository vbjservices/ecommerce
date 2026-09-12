import type { Id, Timestamp } from './shared';

export interface Product {
  id: Id;
  title: string;
  description: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ProductVariant {
  id: Id;
  productId: Id;
  sku: string | null;
  options: Record<string, string>;
}

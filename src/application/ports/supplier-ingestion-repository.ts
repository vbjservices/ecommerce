import type { SupplierSnapshot } from './supplier-adapter';

export interface SupplierIngestionResult {
  productId: string;
  supplierProductId: string;
  candidateId: string;
  created: boolean;
  variantCount: number;
}

export interface SupplierIngestionRepository {
  save(
    provider: { code: string; name: string },
    snapshot: SupplierSnapshot,
  ): Promise<SupplierIngestionResult>;
}

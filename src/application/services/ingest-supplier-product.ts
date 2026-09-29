import { IntegrationError } from '../ports/integration-error';
import type { SupplierAdapter } from '../ports/supplier-adapter';
import type {
  SupplierIngestionRepository,
  SupplierIngestionResult,
} from '../ports/supplier-ingestion-repository';

export async function ingestSupplierProduct(
  adapter: SupplierAdapter,
  repository: SupplierIngestionRepository,
  externalProductId: string,
): Promise<SupplierIngestionResult> {
  if (!adapter.catalog) {
    throw new IntegrationError('unsupported_capability', adapter.provider);
  }
  const snapshot = await adapter.catalog.getProduct(externalProductId);
  return repository.save(
    { code: adapter.provider, name: adapter.providerName },
    snapshot,
  );
}

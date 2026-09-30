import { IntegrationError } from '../ports/integration-error';
import type { SupplierAdapter, SupplierDiscoveryInput } from '../ports/supplier-adapter';
import type { SupplierDiscoveryProduct } from '../../domain/suppliers';
import { meaningfulSearchTerms } from './query-terms';

export interface SupplierSearchResult {
  products: SupplierDiscoveryProduct[];
  queryTerms: string[];
  providerMatchCount: number;
}

/**
 * Multi-term supplier search favors recall during acquisition. Ranking applies the
 * original all-term relevance requirement after provider results are merged.
 */
export async function searchSupplierProducts(
  adapter: SupplierAdapter,
  input: SupplierDiscoveryInput,
): Promise<SupplierSearchResult> {
  if (!adapter.discovery) {
    throw new IntegrationError('unsupported_capability', adapter.provider);
  }
  const terms = meaningfulSearchTerms(input.query);
  if (!terms.length || terms.length > 5) {
    throw new IntegrationError('invalid_payload', adapter.provider);
  }
  const products = new Map<string, SupplierDiscoveryProduct>();
  let providerMatchCount = 0;
  for (const term of terms) {
    const snapshot = await adapter.discovery.search({ ...input, query: term });
    providerMatchCount += snapshot.totalResults;
    for (const product of snapshot.products) {
      if (!products.has(product.externalProductId)) products.set(product.externalProductId, product);
    }
  }
  return { products: [...products.values()], queryTerms: terms, providerMatchCount };
}

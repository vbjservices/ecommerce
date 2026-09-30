import './only';
import { rankSupplierDiscoveryProducts } from '../application/discovery/rank-supplier-products';
import { searchSupplierProducts } from '../application/discovery/search-supplier-products';
import { ConfigurationError } from '../config/validation';
import { readCjConfig } from './config';
import { CjSupplierAdapter } from './integrations/suppliers/cj/adapter';
import { CjClient } from './integrations/suppliers/cj/client';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Pass a search phrase, for example: npm run cj:search -- "cat toy"');
  process.exitCode = 1;
} else {
  try {
    const config = readCjConfig(process.env);
    const adapter = new CjSupplierAdapter(new CjClient(config.apiKey));
    const discovery = await searchSupplierProducts(adapter, {
      query,
      limit: 50,
      sortBy: 'relevance',
      sortDirection: 'desc',
    });
    const allRanked = rankSupplierDiscoveryProducts(
      discovery.products, undefined, Date.now(), query,
    );
    const ranked = allRanked.slice(0, 10);
    console.table(ranked.map((item) => ({
      eligible: item.eligible ? 'yes' : 'no',
      score: item.score,
      coverage: `${item.coverage}%`,
      listed: item.product.listedCount ?? 'unknown',
      verifiedStock: item.product.verifiedInventory ?? 'unknown',
      cost: item.product.costRange
        ? `$${item.product.costRange.minAmount}-${item.product.costRange.maxAmount}`
        : 'unknown',
      title: item.product.title,
      productId: item.product.externalProductId,
      risks: item.risks.join('; '),
    })));
    console.log(
      `Ranked ${discovery.products.length} unique products from ` +
      `${discovery.queryTerms.join(', ')} (${discovery.providerMatchCount} provider matches); ` +
      `${allRanked.filter((item) => item.eligible).length} passed the current filters. ` +
      'Results were not imported.',
    );
  } catch (error) {
    console.error(error instanceof ConfigurationError
      ? error.message
      : 'CJ discovery failed. Check the query, API access, and provider availability.');
    process.exitCode = 1;
  }
}

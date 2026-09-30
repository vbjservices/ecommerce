import type {
  DiscoveryBudget,
  DiscoveryOccurrence,
  DiscoveryProfile,
  DiscoveryRunResult,
  DiscoveryStrategy,
  QueryExpansion,
  QueryExpansionSource,
} from '../../domain/discovery';
import type { Json } from '../../domain/shared';
import type { SupplierDiscoveryProduct } from '../../domain/suppliers';
import { IntegrationError } from '../ports/integration-error';
import type { QueryExpansionProvider } from '../ports/query-expansion-provider';
import type { SupplierAdapter, SupplierDiscoveryInput } from '../ports/supplier-adapter';
import { assessDiscoveryProduct, DISCOVERY_SCORING_VERSION } from './assess-product';
import { buildQueryExpansions, DISCOVERY_CONFIGURATION_VERSION } from './expand-query';
import { assertValidDiscoveryProfile } from './profiles';
import { meaningfulSearchTerms } from './query-terms';

export const DEFAULT_DISCOVERY_BUDGET: DiscoveryBudget = {
  maxApiRequests: 12,
  maxPagesPerStrategy: 2,
  maxRawCandidates: 300,
  maxEnrichments: 0,
  pageSize: 50,
};

interface StrategyPlan {
  strategy: DiscoveryStrategy;
  query: string;
  querySource: QueryExpansionSource;
  sortBy: NonNullable<SupplierDiscoveryInput['sortBy']>;
  maxPages: number;
  filters: NonNullable<SupplierDiscoveryInput['filters']>;
}

export interface ProductDiscoveryRequest {
  query: string;
  profile: DiscoveryProfile;
  budget?: DiscoveryBudget;
  filters?: SupplierDiscoveryInput['filters'];
}

function planStrategies(
  queries: QueryExpansion[],
  profile: DiscoveryProfile,
  baseFilters: SupplierDiscoveryInput['filters'],
  budget: DiscoveryBudget,
) {
  const original = queries[0]!;
  const enabled = new Set(profile.enabledStrategies);
  const plans: StrategyPlan[] = [];
  const add = (
    strategy: DiscoveryStrategy,
    query: QueryExpansion,
    sortBy: NonNullable<SupplierDiscoveryInput['sortBy']>,
    maxPages: number,
    strategyFilters: SupplierDiscoveryInput['filters'] = {},
  ) => {
    if (!enabled.has(strategy)) return;
    plans.push({
      strategy,
      query: query.query,
      querySource: query.source,
      sortBy,
      maxPages,
      filters: { ...baseFilters, ...strategyFilters },
    });
  };
  add('original_query', original, 'relevance', budget.maxPagesPerStrategy);
  add('listing_activity', original, 'listings', 1);
  add('inventory', original, 'inventory', 1);
  for (const expansion of queries.slice(1)) add('expanded_query', expansion, 'relevance', 1);
  const tokens = meaningfulSearchTerms(original.query, profile.search.stopWords);
  for (const token of tokens) add('token_query', {
    query: token,
    source: 'rule_based',
    confidence: 0.7,
    reason: 'original query token for recall',
  }, 'relevance', 1);
  add('trending', original, 'relevance', 1, { productFlag: 'trending' });
  add('new_products', original, 'newest', 1, { productFlag: 'new' });
  return plans;
}

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function warningCode(error: unknown) {
  return error instanceof IntegrationError ? error.code : 'unavailable';
}

function eligibilityOrder(status: string) {
  return status === 'pass' ? 0 : status === 'review' ? 1 : 2;
}

export async function runProductDiscovery(
  adapter: SupplierAdapter,
  request: ProductDiscoveryRequest,
  optionalExpansionProvider?: QueryExpansionProvider,
  clock: () => number = Date.now,
): Promise<DiscoveryRunResult> {
  if (!adapter.discovery) throw new IntegrationError('unsupported_capability', adapter.provider);
  assertValidDiscoveryProfile(request.profile);
  const startedAt = new Date(clock()).toISOString();
  const budget = request.budget ?? DEFAULT_DISCOVERY_BUDGET;
  const wholeNumberLimits = [
    budget.maxApiRequests,
    budget.maxPagesPerStrategy,
    budget.maxRawCandidates,
    budget.maxEnrichments,
    budget.pageSize,
  ];
  if (wholeNumberLimits.some((value) => !Number.isSafeInteger(value)) ||
      budget.maxApiRequests < 1 || budget.maxPagesPerStrategy < 1 ||
      budget.maxRawCandidates < 1 || budget.maxEnrichments < 0 ||
      budget.pageSize < 1 || budget.pageSize > 100) {
    throw new Error('Discovery budget is invalid.');
  }
  const expansionResult = await buildQueryExpansions(
    request.query, request.profile, optionalExpansionProvider,
  );
  const plans = planStrategies(
    expansionResult.queries, request.profile, request.filters, budget,
  );
  const queryMap = new Map(expansionResult.queries.map((query) => [query.query, query]));
  for (const plan of plans) {
    if (!queryMap.has(plan.query)) queryMap.set(plan.query, {
      query: plan.query,
      source: plan.querySource,
      confidence: 0.7,
      reason: 'original query token for recall',
    });
  }
  const products = new Map<string, { product: SupplierDiscoveryProduct; occurrences: DiscoveryOccurrence[] }>();
  const sourcePages: DiscoveryRunResult['sourcePages'] = [];
  const warnings = [...expansionResult.warnings];
  let apiRequestsUsed = 0;
  let pagesFetched = 0;
  let productsFetched = 0;
  let duplicatesFound = 0;
  let stoppingReason = 'strategies_exhausted';
  outer: for (const plan of plans) {
    const pageLimit = Math.min(plan.maxPages, budget.maxPagesPerStrategy);
    let cursor: string | undefined;
    for (let page = 1; page <= pageLimit; page++) {
      if (apiRequestsUsed >= budget.maxApiRequests) {
        stoppingReason = 'api_request_budget_reached';
        break outer;
      }
      if (productsFetched >= budget.maxRawCandidates) {
        stoppingReason = 'raw_candidate_budget_reached';
        break outer;
      }
      apiRequestsUsed++;
      try {
        const remainingCandidateBudget = budget.maxRawCandidates - productsFetched;
        const snapshot = await adapter.discovery.search({
          query: plan.query,
          ...(cursor === undefined ? {} : { cursor }),
          limit: Math.min(budget.pageSize, remainingCandidateBudget),
          sortBy: plan.sortBy,
          sortDirection: 'desc',
          filters: plan.filters,
        });
        pagesFetched++;
        productsFetched += snapshot.products.length;
        sourcePages.push({
          strategy: plan.strategy,
          query: plan.query,
          querySource: plan.querySource,
          page,
          source: snapshot.source,
          retrievedAt: snapshot.retrievedAt,
          rawPayload: snapshot.rawPayload,
        });
        let pageDuplicates = 0;
        snapshot.products.forEach((product, index) => {
          const occurrence: DiscoveryOccurrence = {
            strategy: plan.strategy,
            query: plan.query,
            querySource: plan.querySource,
            page,
            rank: index + 1,
            sortBy: plan.sortBy ?? 'relevance',
            filters: json(plan.filters),
            source: snapshot.source,
            retrievedAt: snapshot.retrievedAt,
          };
          const existing = products.get(product.externalProductId);
          if (existing) {
            existing.occurrences.push(occurrence);
            duplicatesFound++;
            pageDuplicates++;
          } else {
            products.set(product.externalProductId, { product, occurrences: [occurrence] });
          }
        });
        if (snapshot.products.length === 0 || snapshot.nextCursor === null) break;
        if (page > 1 && pageDuplicates / snapshot.products.length >= 0.9) {
          break;
        }
        cursor = snapshot.nextCursor;
      } catch (error) {
        warnings.push({ strategy: plan.strategy, query: plan.query, code: warningCode(error) });
        break;
      }
    }
  }
  const now = clock();
  const candidates = [...products.values()].map(({ product, occurrences }) => ({
    product,
    occurrences,
    assessment: assessDiscoveryProduct(product, expansionResult.queries[0]!.query, request.profile, occurrences, now),
  })).sort((left, right) =>
    eligibilityOrder(left.assessment.eligibility.status) - eligibilityOrder(right.assessment.eligibility.status) ||
    right.assessment.score - left.assessment.score ||
    right.assessment.confidence - left.assessment.confidence ||
    (right.product.listedCount ?? -1) - (left.product.listedCount ?? -1));
  const status = pagesFetched === 0 ? 'failed' : warnings.length ? 'completed_with_warnings' : 'completed';
  const completedAtMs = clock();
  return {
    profileId: request.profile.id,
    originalQuery: expansionResult.queries[0]!.query,
    status,
    configurationVersion: DISCOVERY_CONFIGURATION_VERSION,
    scoringVersion: DISCOVERY_SCORING_VERSION,
    startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    cacheExpiresAt: new Date(completedAtMs + request.profile.cacheTtlMinutes * 60_000).toISOString(),
    budget,
    queries: [...queryMap.values()],
    candidates,
    sourcePages,
    warnings,
    metrics: {
      apiRequestsUsed,
      pagesFetched,
      productsFetched,
      uniqueProductsFound: candidates.length,
      duplicatesFound,
      eligibleCandidateCount: candidates.filter((candidate) => candidate.assessment.eligibility.status === 'pass').length,
      stoppingReason,
    },
  };
}

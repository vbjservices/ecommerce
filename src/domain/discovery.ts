import type { Json, Timestamp } from './shared';
import type { SupplierDiscoveryProduct } from './suppliers';

export const queryExpansionSources = ['original', 'rule_based', 'synonym', 'category', 'local_model'] as const;
export type QueryExpansionSource = typeof queryExpansionSources[number];

export interface QueryExpansion {
  query: string;
  source: QueryExpansionSource;
  confidence: number;
  reason: string;
}

export const discoveryStrategies = [
  'original_query', 'expanded_query', 'token_query',
  'listing_activity', 'inventory', 'trending', 'new_products',
] as const;
export type DiscoveryStrategy = typeof discoveryStrategies[number];

export interface DiscoveryBudget {
  maxApiRequests: number;
  maxPagesPerStrategy: number;
  maxRawCandidates: number;
  maxEnrichments: number;
  pageSize: number;
}

export interface DiscoveryProfile {
  id: string;
  name: string;
  search: {
    stopWords: string[];
    synonyms: Record<string, string[]>;
    negativeTerms: string[];
    categoryHints: string[];
    maxExpansions: number;
  };
  eligibility: {
    minimumListedCount: number;
    minimumInventory: number;
    targetCostMin: number;
    targetCostMax: number;
    maximumCost: number;
  };
  scoring: {
    relevance: number;
    supplierActivity: number;
    inventoryHealth: number;
    costFit: number;
    freshness: number;
    fulfillmentReadiness: number;
    creativeAssetReadiness: number;
    operationalSimplicity: number;
  };
  enabledStrategies: DiscoveryStrategy[];
  riskRuleIds: string[];
  cacheTtlMinutes: number;
}

export interface DiscoveryOccurrence {
  strategy: DiscoveryStrategy;
  query: string;
  querySource: QueryExpansionSource;
  page: number;
  rank: number;
  sortBy: 'relevance' | 'listings' | 'cost' | 'newest' | 'inventory';
  filters: Json;
  source: string;
  retrievedAt: Timestamp;
}

export const relevanceLevels = ['exact', 'strong', 'related', 'weak', 'irrelevant'] as const;
export type RelevanceLevel = typeof relevanceLevels[number];

export interface RelevanceAssessment {
  level: RelevanceLevel;
  score: number;
  matchedTerms: string[];
  missingTerms: string[];
  matchedSynonyms: string[];
  negativeTerms: string[];
  reasons: string[];
}

export const eligibilityStatuses = ['pass', 'review', 'fail'] as const;
export type EligibilityStatus = typeof eligibilityStatuses[number];

export interface EligibilityAssessment {
  status: EligibilityStatus;
  reasons: string[];
}

export const riskSeverities = ['info', 'review', 'high_risk', 'block'] as const;
export type RiskSeverity = typeof riskSeverities[number];

export interface DiscoveryRiskFlag {
  ruleId: string;
  severity: RiskSeverity;
  explanation: string;
  matchedTerms: string[];
}

export interface DiscoveryScoreComponent {
  name: keyof DiscoveryProfile['scoring'];
  rawValue: Json;
  normalizedValue: number | null;
  weight: number;
  contribution: number;
  source: string;
  retrievedAt: Timestamp;
  explanation: string;
}

export interface ProductOpportunityAssessment {
  scoringVersion: string;
  relevance: RelevanceAssessment;
  eligibility: EligibilityAssessment;
  components: DiscoveryScoreComponent[];
  risks: DiscoveryRiskFlag[];
  score: number;
  confidence: number;
  coverage: number;
  positiveEvidence: string[];
  unknownEvidence: string[];
}

export interface AssessedDiscoveryCandidate {
  product: SupplierDiscoveryProduct;
  occurrences: DiscoveryOccurrence[];
  assessment: ProductOpportunityAssessment;
}

export interface DiscoverySourcePage {
  strategy: DiscoveryStrategy;
  query: string;
  querySource: QueryExpansionSource;
  page: number;
  source: string;
  retrievedAt: Timestamp;
  rawPayload: Json;
}

export interface DiscoveryRunWarning {
  strategy: DiscoveryStrategy | 'query_expansion';
  query: string;
  code: string;
}

export interface DiscoveryRunResult {
  profileId: string;
  originalQuery: string;
  status: 'completed' | 'completed_with_warnings' | 'failed';
  configurationVersion: string;
  scoringVersion: string;
  startedAt: Timestamp;
  completedAt: Timestamp;
  cacheExpiresAt: Timestamp;
  budget: DiscoveryBudget;
  queries: QueryExpansion[];
  candidates: AssessedDiscoveryCandidate[];
  sourcePages: DiscoverySourcePage[];
  warnings: DiscoveryRunWarning[];
  metrics: {
    apiRequestsUsed: number;
    pagesFetched: number;
    productsFetched: number;
    uniqueProductsFound: number;
    duplicatesFound: number;
    eligibleCandidateCount: number;
    stoppingReason: string;
  };
}

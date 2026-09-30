import type { DiscoveryProfile } from '../../domain/discovery';

const sharedRiskRules = [
  'battery', 'electrical', 'medical', 'supplement', 'cosmetic', 'pesticide',
  'baby', 'food', 'branded', 'licensed', 'customized',
];

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryProfile = {
  id: 'generic',
  name: 'Generic products',
  search: {
    stopWords: ['and', 'for', 'the', 'with'],
    synonyms: {},
    negativeTerms: [],
    categoryHints: [],
    maxExpansions: 4,
  },
  eligibility: {
    minimumListedCount: 10,
    minimumInventory: 100,
    targetCostMin: 1,
    targetCostMax: 15,
    maximumCost: 25,
  },
  scoring: {
    relevance: 25,
    supplierActivity: 15,
    inventoryHealth: 15,
    costFit: 15,
    freshness: 10,
    fulfillmentReadiness: 10,
    creativeAssetReadiness: 5,
    operationalSimplicity: 5,
  },
  enabledStrategies: [
    'original_query', 'expanded_query', 'token_query',
    'listing_activity', 'inventory', 'trending', 'new_products',
  ],
  riskRuleIds: sharedRiskRules,
  cacheTtlMinutes: 360,
};

export const discoveryProfiles: Record<string, DiscoveryProfile> = {
  generic: DEFAULT_DISCOVERY_CONFIG,
  pets: {
    ...DEFAULT_DISCOVERY_CONFIG,
    id: 'pets',
    name: 'Pet products',
    search: {
      ...DEFAULT_DISCOVERY_CONFIG.search,
      synonyms: {
        cat: ['kitten', 'feline'],
        dog: ['puppy', 'canine'],
        toy: ['interactive toy', 'enrichment toy', 'puzzle toy', 'ball'],
        feeder: ['feeding bowl', 'slow feeder'],
        bed: ['pet sleeping mat', 'pet cushion'],
      },
      negativeTerms: ['hoodie', 'coffee mug', 'phone case', 'costume'],
      categoryHints: ['pet', 'cat', 'dog', 'kitten', 'puppy'],
    },
  },
  'home-products': {
    ...DEFAULT_DISCOVERY_CONFIG,
    id: 'home-products',
    name: 'Home products',
    search: {
      ...DEFAULT_DISCOVERY_CONFIG.search,
      synonyms: {
        storage: ['organizer', 'space saving storage'],
        lamp: ['lighting', 'led lamp'],
        kitchen: ['cooking', 'food preparation'],
      },
      negativeTerms: ['weapon', 'tobacco'],
      categoryHints: ['home', 'kitchen', 'household', 'storage'],
    },
  },
};

export function assertValidDiscoveryProfile(profile: DiscoveryProfile) {
  const weights = Object.values(profile.scoring);
  const eligibility = profile.eligibility;
  if (!profile.id.trim() || !profile.name.trim() ||
      !Number.isSafeInteger(profile.search.maxExpansions) ||
      profile.search.maxExpansions < 0 || profile.search.maxExpansions > 20 ||
      !Number.isSafeInteger(profile.cacheTtlMinutes) || profile.cacheTtlMinutes < 0 ||
      weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
      weights.reduce((total, weight) => total + weight, 0) <= 0 ||
      eligibility.minimumListedCount < 0 || eligibility.minimumInventory < 0 ||
      eligibility.targetCostMin < 0 || eligibility.targetCostMax <= eligibility.targetCostMin ||
      eligibility.maximumCost <= eligibility.targetCostMax ||
      new Set(profile.enabledStrategies).size !== profile.enabledStrategies.length) {
    throw new Error(`Discovery profile ${profile.id || '(unnamed)'} is invalid.`);
  }
}

export function resolveDiscoveryProfile(id = 'generic') {
  const profile = discoveryProfiles[id] ?? null;
  if (profile) assertValidDiscoveryProfile(profile);
  return profile;
}

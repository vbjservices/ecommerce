import type { SupplierDiscoveryProduct } from '../../domain/suppliers';
import { meaningfulSearchTerms } from './query-terms';

export interface DiscoveryProfile {
  minimumListedCount: number;
  minimumInventory: number;
  targetCostMin: number;
  targetCostMax: number;
  maximumCost: number;
  riskTerms: string[];
}

export const defaultDiscoveryProfile: DiscoveryProfile = {
  minimumListedCount: 10,
  minimumInventory: 100,
  targetCostMin: 1,
  targetCostMax: 15,
  maximumCost: 25,
  riskTerms: [
    'battery', 'supplement', 'medical', 'medicine', 'cosmetic', 'pesticide',
    'baby', 'food', 'treat', 'edible', 'licensed', 'branded',
  ],
};

export interface RankedDiscoveryProduct {
  product: SupplierDiscoveryProduct;
  score: number;
  coverage: number;
  eligible: boolean;
  components: {
    relevance: number | null;
    demand: number | null;
    inventory: number | null;
    costFit: number | null;
    freshness: number | null;
    fulfillment: number | null;
    media: number | null;
  };
  reasons: string[];
  risks: string[];
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function tokenForms(token: string) {
  const forms = new Set([token, `${token}s`, `${token}es`]);
  if (token.endsWith('y') && token.length > 2) forms.add(`${token.slice(0, -1)}ies`);
  if (token.endsWith('s') && token.length > 2) forms.add(token.slice(0, -1));
  return forms;
}

function costMidpoint(product: SupplierDiscoveryProduct) {
  if (!product.costRange) return null;
  const min = Number(product.costRange.minAmount);
  const max = Number(product.costRange.maxAmount);
  return Number.isFinite(min) && Number.isFinite(max) ? (min + max) / 2 : null;
}

function costFit(cost: number, profile: DiscoveryProfile) {
  if (cost >= profile.targetCostMin && cost <= profile.targetCostMax) return 15;
  if (cost > profile.maximumCost) return 0;
  if (cost < profile.targetCostMin) {
    return clamp(15 * (cost / profile.targetCostMin), 0, 15);
  }
  return clamp(15 * (1 - (cost - profile.targetCostMax) /
    (profile.maximumCost - profile.targetCostMax)), 0, 15);
}

export function rankSupplierDiscoveryProducts(
  products: SupplierDiscoveryProduct[],
  profile: DiscoveryProfile = defaultDiscoveryProfile,
  now = Date.now(),
  query = '',
): RankedDiscoveryProduct[] {
  const fullWeight = 100;
  const queryTokens = meaningfulSearchTerms(query);
  return products.map((product) => {
    const searchable = `${product.title} ${product.category ?? ''} ${product.supplierSku ?? ''}`
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const searchableWords = new Set(searchable.trim().split(/\s+/));
    const matchedTokens = queryTokens.filter((token) =>
      [...tokenForms(token)].some((form) => searchableWords.has(form)));
    const phrase = queryTokens.join(' ');
    const components: RankedDiscoveryProduct['components'] = {
      relevance: queryTokens.length === 0 ? null : clamp(
        matchedTokens.length / queryTokens.length * 20 +
        (phrase && searchable.includes(phrase) ? 5 : 0),
        0,
        25,
      ),
      demand: product.listedCount === null ? null :
        clamp(Math.log1p(product.listedCount) / Math.log1p(1_000) * 20, 0, 20),
      inventory: product.verifiedInventory === null ? null :
        clamp(Math.log1p(product.verifiedInventory) / Math.log1p(5_000) * 15, 0, 15),
      costFit: null,
      freshness: null,
      fulfillment: null,
      media: product.imageUrl === null && product.hasVideo === null ? null :
        (product.imageUrl ? 3 : 0) + (product.hasVideo ? 2 : 0),
    };
    const midpoint = costMidpoint(product);
    if (midpoint !== null) components.costFit = costFit(midpoint, profile);
    if (product.createdAt !== null) {
      const ageDays = Math.max(0, (now - Date.parse(product.createdAt)) / 86_400_000);
      components.freshness = clamp(10 * (1 - ageDays / (365 * 3)), 0, 10);
    }
    if (product.deliveryDays !== null) {
      const days = product.deliveryDays.max;
      components.fulfillment = days <= 5 ? 10 : days <= 8 ? 7 : days <= 12 ? 4 : 1;
    }

    const weights: Record<keyof typeof components, number> = {
      relevance: 25, demand: 20, inventory: 15, costFit: 15,
      freshness: 10, fulfillment: 10, media: 5,
    };
    let earned = 0;
    let available = 0;
    for (const [name, value] of Object.entries(components) as Array<[
      keyof typeof components, number | null,
    ]>) {
      if (value !== null) {
        earned += value;
        available += weights[name];
      }
    }
    const coverage = Math.round(available / fullWeight * 100);
    const normalized = available === 0 ? 0 : earned / available * 100;
    const confidenceAdjusted = normalized * (0.7 + 0.3 * coverage / 100);

    const reasons: string[] = [];
    const risks: string[] = [];
    if (queryTokens.length > 0 && matchedTokens.length === queryTokens.length) {
      reasons.push('matches all search terms');
    }
    if ((product.listedCount ?? 0) >= 100) reasons.push('strong listing activity');
    if ((product.verifiedInventory ?? 0) >= 1_000) reasons.push('deep verified inventory');
    if (components.costFit !== null && components.costFit >= 12) reasons.push('cost fits target band');
    if (product.deliveryDays && product.deliveryDays.max <= 8) reasons.push('short supplier delivery cycle');
    if (product.verifiedInventory !== null && product.inventory !== null &&
        product.inventory > 0 && product.verifiedInventory / product.inventory < 0.5) {
      risks.push('most reported inventory is unverified');
    }
    const matchedTerms = profile.riskTerms.filter((term) => searchable.includes(term));
    if (matchedTerms.length) risks.push(`manual compliance review: ${matchedTerms.join(', ')}`);
    if (product.customizable) risks.push('customization adds fulfillment complexity');
    if (product.listedCount === null) risks.push('listing activity unavailable');
    if (product.costRange === null) risks.push('supplier cost unavailable');
    if (product.verifiedInventory === null) risks.push('verified inventory unavailable');

    const relevant = queryTokens.length === 0 || matchedTokens.length === queryTokens.length;
    if (!relevant) risks.push('weak query match');
    const eligible = relevant &&
      product.listedCount !== null && product.listedCount >= profile.minimumListedCount &&
      product.inventory !== null && product.inventory >= profile.minimumInventory &&
      midpoint !== null && midpoint <= profile.maximumCost;
    if (!eligible) risks.push('outside current discovery thresholds');

    return {
      product,
      score: Math.round(clamp(confidenceAdjusted - Math.min(risks.length * 3, 12), 0, 100)),
      coverage,
      eligible,
      components,
      reasons,
      risks,
    };
  }).sort((left, right) =>
    Number(right.eligible) - Number(left.eligible) ||
    right.score - left.score ||
    (right.product.listedCount ?? -1) - (left.product.listedCount ?? -1),
  );
}

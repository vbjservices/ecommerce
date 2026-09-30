import type {
  DiscoveryOccurrence,
  DiscoveryProfile,
  DiscoveryScoreComponent,
  EligibilityAssessment,
  ProductOpportunityAssessment,
} from '../../domain/discovery';
import type { SupplierDiscoveryProduct } from '../../domain/suppliers';
import { assessProductRelevance } from './assess-relevance';
import { evaluateDiscoveryRisks } from './risk-rules';

export const DISCOVERY_SCORING_VERSION = 'supplier-opportunity-v2.0';

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

function costMidpoint(product: SupplierDiscoveryProduct) {
  if (!product.costRange) return null;
  const min = Number(product.costRange.minAmount);
  const max = Number(product.costRange.maxAmount);
  return Number.isFinite(min) && Number.isFinite(max) ? (min + max) / 2 : null;
}

function costScore(cost: number, profile: DiscoveryProfile) {
  const config = profile.eligibility;
  if (cost >= config.targetCostMin && cost <= config.targetCostMax) return 100;
  if (cost > config.maximumCost) return 0;
  if (cost < config.targetCostMin) return clamp(cost / config.targetCostMin * 100);
  return clamp((1 - (cost - config.targetCostMax) /
    (config.maximumCost - config.targetCostMax)) * 100);
}

function component(
  name: DiscoveryScoreComponent['name'],
  rawValue: DiscoveryScoreComponent['rawValue'],
  normalizedValue: number | null,
  profile: DiscoveryProfile,
  source: string,
  retrievedAt: string,
  explanation: string,
): DiscoveryScoreComponent {
  const weight = profile.scoring[name];
  return {
    name,
    rawValue,
    normalizedValue,
    weight,
    contribution: normalizedValue === null ? 0 : normalizedValue / 100 * weight,
    source,
    retrievedAt,
    explanation,
  };
}

function assessEligibility(
  product: SupplierDiscoveryProduct,
  profile: DiscoveryProfile,
  relevance: ReturnType<typeof assessProductRelevance>,
  risks: ReturnType<typeof evaluateDiscoveryRisks>,
  midpoint: number | null,
): EligibilityAssessment {
  const failures: string[] = [];
  const reviews: string[] = [];
  if (relevance.level === 'irrelevant' || relevance.level === 'weak') failures.push('insufficient query relevance');
  if (relevance.negativeTerms.length) failures.push('profile exclusion matched');
  if (product.saleStatus === 'not_on_sale') failures.push('supplier product is not on sale');
  if (product.visible === false) failures.push('supplier product is not publicly visible');
  if (midpoint !== null && midpoint > profile.eligibility.maximumCost) failures.push('supplier cost exceeds the absolute ceiling');
  if (product.inventory !== null && product.inventory < profile.eligibility.minimumInventory) failures.push('reported inventory is below the minimum');
  if (risks.some((risk) => risk.severity === 'block')) failures.push('blocking risk rule matched');
  if (relevance.level === 'related') reviews.push('related rather than direct query match');
  if (product.listedCount === null) reviews.push('supplier listing activity is unknown');
  else if (product.listedCount < profile.eligibility.minimumListedCount) reviews.push('supplier listing activity is below the preferred minimum');
  if (product.inventory === null) reviews.push('reported inventory is unknown');
  if (product.verifiedInventory === null) reviews.push('verified inventory is unknown');
  if (midpoint === null) reviews.push('supplier cost is unknown');
  if (risks.some((risk) => risk.severity === 'review' || risk.severity === 'high_risk')) {
    reviews.push('manual risk review required');
  }
  if (failures.length) return { status: 'fail', reasons: [...failures, ...reviews] };
  if (reviews.length) return { status: 'review', reasons: reviews };
  return { status: 'pass', reasons: ['meets current supplier-side discovery gates'] };
}

export function assessDiscoveryProduct(
  product: SupplierDiscoveryProduct,
  originalQuery: string,
  profile: DiscoveryProfile,
  occurrences: DiscoveryOccurrence[],
  now = Date.now(),
): ProductOpportunityAssessment {
  const relevance = assessProductRelevance(product, originalQuery, profile);
  const risks = evaluateDiscoveryRisks(product, profile);
  const midpoint = costMidpoint(product);
  const observedAt = occurrences[0]?.retrievedAt ?? new Date(now).toISOString();
  const source = occurrences[0]?.source ?? 'supplier';
  const createdAt = product.createdAt === null ? null : Date.parse(product.createdAt);
  const ageDays = createdAt === null || !Number.isFinite(createdAt)
    ? null : Math.max(0, (now - createdAt) / 86_400_000);
  const verifiedRatio = product.inventory && product.verifiedInventory !== null
    ? clamp(product.verifiedInventory / product.inventory * 100) : null;
  const components: DiscoveryScoreComponent[] = [
    component('relevance', relevance.level, relevance.score, profile, 'normalized supplier facts', observedAt,
      'Original query intent compared with title, category, SKU, and configured synonyms.'),
    component('supplierActivity', product.listedCount, product.listedCount === null ? null :
      clamp(Math.log1p(product.listedCount) / Math.log1p(1_000) * 100), profile, source, observedAt,
      'Log-scaled CJ listing activity; this is not verified consumer sales.'),
    component('inventoryHealth', { total: product.inventory, verified: product.verifiedInventory },
      product.verifiedInventory === null ? null :
        clamp(Math.log1p(product.verifiedInventory) / Math.log1p(5_000) * 80 + (verifiedRatio ?? 0) * 0.2),
      profile, source, observedAt, 'Verified inventory depth and its share of reported inventory.'),
    component('costFit', midpoint, midpoint === null ? null : costScore(midpoint, profile), profile, source, observedAt,
      'Supplier cost midpoint compared with the configured research band.'),
    component('freshness', ageDays, ageDays === null ? null : clamp((1 - ageDays / (365 * 3)) * 100),
      profile, source, observedAt, 'Supplier listing recency over a three-year scoring window.'),
    component('fulfillmentReadiness', product.deliveryDays?.max ?? null, product.deliveryDays === null ? null :
      product.deliveryDays.max <= 5 ? 100 : product.deliveryDays.max <= 8 ? 70 :
        product.deliveryDays.max <= 12 ? 40 : 10, profile, source, observedAt,
      'Supplier-reported delivery cycle; destination shipping is not yet validated.'),
    component('creativeAssetReadiness', { image: Boolean(product.imageUrl), video: product.hasVideo },
      product.imageUrl === null && product.hasVideo === null ? null :
        (product.imageUrl ? 60 : 0) + (product.hasVideo ? 40 : 0), profile, source, observedAt,
      'Availability of supplier image and video assets; advertising performance is unknown.'),
    component('operationalSimplicity', product.customizable, product.customizable === null ? null :
      product.customizable ? 40 : 100, profile, source, observedAt,
      'Non-custom products are operationally simpler at the discovery stage.'),
  ];
  const totalWeight = Object.values(profile.scoring).reduce((sum, weight) => sum + weight, 0);
  const availableWeight = components.filter((item) => item.normalizedValue !== null)
    .reduce((sum, item) => sum + item.weight, 0);
  const coverage = Math.round(availableWeight / totalWeight * 100);
  const riskPenalty = risks.reduce((sum, risk) => sum + ({ info: 0, review: 2, high_risk: 6, block: 12 })[risk.severity], 0);
  const score = Math.round(clamp(components.reduce((sum, item) => sum + item.contribution, 0) - riskPenalty));
  const inventoryConfidence = product.verifiedInventory === null ? 0.65 :
    product.inventory && product.verifiedInventory / product.inventory < 0.5 ? 0.8 : 1;
  const confidence = Math.round(clamp(coverage * inventoryConfidence));
  const eligibility = assessEligibility(product, profile, relevance, risks, midpoint);
  const positiveEvidence = components
    .filter((item) => (item.normalizedValue ?? 0) >= 70)
    .map((item) => item.explanation);
  if (new Set(occurrences.map((item) => item.strategy)).size > 1) {
    positiveEvidence.push('Product appeared through multiple supplier discovery strategies.');
  }
  const unknownEvidence = [
    'External consumer demand has not been measured.',
    'Destination shipping and landed cost have not been validated.',
    'Retail price, advertising cost, and profitability are unknown.',
    ...components.filter((item) => item.normalizedValue === null)
      .map((item) => `${item.name} evidence is unavailable.`),
  ];
  return {
    scoringVersion: DISCOVERY_SCORING_VERSION,
    relevance,
    eligibility,
    components,
    risks,
    score,
    confidence,
    coverage,
    positiveEvidence,
    unknownEvidence,
  };
}

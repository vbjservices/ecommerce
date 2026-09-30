import type { DiscoveryProfile, DiscoveryRiskFlag, RiskSeverity } from '../../domain/discovery';
import type { SupplierDiscoveryProduct } from '../../domain/suppliers';
import { normalizeSearchText } from './query-terms';

interface TermRiskRule {
  id: string;
  severity: RiskSeverity;
  terms: string[];
  explanation: string;
}

const termRules: TermRiskRule[] = [
  { id: 'battery', severity: 'high_risk', terms: ['battery', 'lithium'], explanation: 'Battery products require transport and compliance review.' },
  { id: 'electrical', severity: 'review', terms: ['electric', 'electrical', 'charger', 'voltage', 'plug'], explanation: 'Electrical products require destination compatibility review.' },
  { id: 'medical', severity: 'high_risk', terms: ['medical', 'medicine', 'therapeutic'], explanation: 'Medical claims or use require specialist compliance review.' },
  { id: 'supplement', severity: 'block', terms: ['supplement', 'vitamin'], explanation: 'Supplements are outside the current low-risk discovery scope.' },
  { id: 'cosmetic', severity: 'high_risk', terms: ['cosmetic', 'skincare', 'makeup'], explanation: 'Cosmetics require formulation and destination compliance review.' },
  { id: 'pesticide', severity: 'block', terms: ['pesticide', 'insecticide'], explanation: 'Pesticides are outside the current discovery scope.' },
  { id: 'baby', severity: 'high_risk', terms: ['baby', 'infant'], explanation: 'Baby products require elevated product-safety review.' },
  { id: 'food', severity: 'high_risk', terms: ['food', 'treat', 'edible'], explanation: 'Food and edible products require destination compliance review.' },
  { id: 'branded', severity: 'review', terms: ['branded', 'brand logo'], explanation: 'Brand references require intellectual-property review.' },
  { id: 'licensed', severity: 'high_risk', terms: ['licensed', 'disney', 'marvel', 'pokemon'], explanation: 'Licensed-character products require intellectual-property review.' },
];

function phraseMatches(searchable: string, term: string) {
  const normalized = normalizeSearchText(term);
  return ` ${searchable} `.includes(` ${normalized} `);
}

export function evaluateDiscoveryRisks(
  product: SupplierDiscoveryProduct,
  profile: DiscoveryProfile,
): DiscoveryRiskFlag[] {
  const searchable = normalizeSearchText(
    `${product.title} ${product.category ?? ''} ${product.supplierSku ?? ''}`,
  );
  const flags: DiscoveryRiskFlag[] = [];
  for (const rule of termRules) {
    if (!profile.riskRuleIds.includes(rule.id)) continue;
    const matchedTerms = rule.terms.filter((term) => phraseMatches(searchable, term));
    if (matchedTerms.length) flags.push({
      ruleId: rule.id,
      severity: rule.severity,
      explanation: rule.explanation,
      matchedTerms,
    });
  }
  const negativeTerms = profile.search.negativeTerms.filter((term) => phraseMatches(searchable, term));
  if (negativeTerms.length) flags.push({
    ruleId: 'profile_negative_term',
    severity: 'block',
    explanation: 'The product matches a profile exclusion term.',
    matchedTerms: negativeTerms,
  });
  if (profile.riskRuleIds.includes('customized') && product.customizable) flags.push({
    ruleId: 'customized',
    severity: 'review',
    explanation: 'Customization adds operational and fulfillment complexity.',
    matchedTerms: [],
  });
  if (product.inventory !== null && product.inventory > 0 && product.verifiedInventory !== null &&
      product.verifiedInventory / product.inventory < 0.5) flags.push({
    ruleId: 'mostly_unverified_inventory',
    severity: 'review',
    explanation: 'Less than half of reported inventory is verified.',
    matchedTerms: [],
  });
  return flags;
}

import type { DiscoveryProfile, RelevanceAssessment, RelevanceLevel } from '../../domain/discovery';
import type { SupplierDiscoveryProduct } from '../../domain/suppliers';
import { canonicalTerm, meaningfulSearchTerms, normalizeSearchText } from './query-terms';

function containsPhrase(searchable: string, phrase: string) {
  return ` ${searchable} `.includes(` ${normalizeSearchText(phrase)} `);
}

function synonymMatches(searchable: string, term: string, profile: DiscoveryProfile) {
  const entry = Object.entries(profile.search.synonyms).find(([key]) =>
    canonicalTerm(key) === canonicalTerm(term));
  return (entry?.[1] ?? []).filter((synonym) => containsPhrase(searchable, synonym));
}

export function assessProductRelevance(
  product: SupplierDiscoveryProduct,
  originalQuery: string,
  profile: DiscoveryProfile,
): RelevanceAssessment {
  const searchable = normalizeSearchText(
    `${product.title} ${product.category ?? ''} ${product.supplierSku ?? ''}`,
  );
  const searchableTerms = new Set(meaningfulSearchTerms(searchable, []).map(canonicalTerm));
  const queryTerms = meaningfulSearchTerms(originalQuery, profile.search.stopWords);
  const matchedTerms: string[] = [];
  const missingTerms: string[] = [];
  const matchedSynonyms: string[] = [];
  for (const term of queryTerms) {
    if (searchableTerms.has(canonicalTerm(term))) {
      matchedTerms.push(term);
      continue;
    }
    const synonyms = synonymMatches(searchable, term, profile);
    if (synonyms.length) {
      matchedTerms.push(term);
      matchedSynonyms.push(...synonyms);
    } else {
      missingTerms.push(term);
    }
  }
  const negativeTerms = profile.search.negativeTerms.filter((term) => containsPhrase(searchable, term));
  const exactPhrase = containsPhrase(searchable, originalQuery);
  const directCoverage = queryTerms.length ?
    queryTerms.filter((term) => searchableTerms.has(canonicalTerm(term))).length / queryTerms.length : 0;
  const semanticCoverage = queryTerms.length ? matchedTerms.length / queryTerms.length : 0;
  const categoryMatch = profile.search.categoryHints.some((hint) =>
    containsPhrase(normalizeSearchText(product.category ?? ''), hint));
  let level: RelevanceLevel;
  let score: number;
  if (negativeTerms.length || semanticCoverage < 0.5) {
    level = semanticCoverage === 0 ? 'irrelevant' : 'weak';
    score = Math.round(semanticCoverage * 40);
  } else if (exactPhrase && directCoverage === 1) {
    level = 'exact';
    score = 100;
  } else if (directCoverage === 1) {
    level = 'strong';
    score = 88;
  } else if (semanticCoverage === 1 && (categoryMatch || matchedSynonyms.length > 0)) {
    level = 'related';
    score = 72;
  } else {
    level = 'weak';
    score = Math.round(semanticCoverage * 55);
  }
  const reasons: string[] = [];
  if (exactPhrase) reasons.push('exact query phrase appears in supplier facts');
  if (directCoverage === 1 && !exactPhrase) reasons.push('all query terms appear in supplier facts');
  if (matchedSynonyms.length) reasons.push(`profile synonyms matched: ${[...new Set(matchedSynonyms)].join(', ')}`);
  if (categoryMatch) reasons.push('supplier category matches the discovery profile');
  if (missingTerms.length) reasons.push(`missing query concepts: ${missingTerms.join(', ')}`);
  if (negativeTerms.length) reasons.push(`profile exclusions matched: ${negativeTerms.join(', ')}`);
  return { level, score, matchedTerms, missingTerms, matchedSynonyms, negativeTerms, reasons };
}

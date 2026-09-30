import type { DiscoveryProfile, DiscoveryRunWarning, QueryExpansion } from '../../domain/discovery';
import type { QueryExpansionProvider } from '../ports/query-expansion-provider';
import { canonicalTerm, meaningfulSearchTerms, normalizeSearchText } from './query-terms';

export const DISCOVERY_CONFIGURATION_VERSION = 'discovery-v2.0';

export class DeterministicQueryExpansionProvider implements QueryExpansionProvider {
  readonly name = 'deterministic';

  async expand(input: {
    originalQuery: string;
    profile: DiscoveryProfile;
    maximumExpansions: number;
  }): Promise<QueryExpansion[]> {
    if (input.maximumExpansions <= 0) return [];
    const original = normalizeSearchText(input.originalQuery);
    const originalWords = original.split(' ');
    const expansions: QueryExpansion[] = [];
    for (const [term, synonyms] of Object.entries(input.profile.search.synonyms)) {
      const normalizedTerm = normalizeSearchText(term);
      const conceptIndex = originalWords.findIndex((word) =>
        canonicalTerm(word) === canonicalTerm(normalizedTerm));
      if (conceptIndex < 0) continue;
      for (const synonym of synonyms) {
        const expandedWords = [...originalWords];
        expandedWords.splice(conceptIndex, 1, ...normalizeSearchText(synonym).split(' '));
        const query = expandedWords.join(' ');
        expansions.push({
          query,
          source: 'synonym',
          confidence: 0.85,
          reason: `profile synonym for ${normalizedTerm}`,
        });
        if (expansions.length >= input.maximumExpansions) return expansions;
      }
    }
    return expansions;
  }
}

function allowedExpansionTerms(profile: DiscoveryProfile, originalTerms: string[]) {
  const terms = new Set(originalTerms);
  for (const [key, values] of Object.entries(profile.search.synonyms)) {
    for (const term of meaningfulSearchTerms(key, profile.search.stopWords)) terms.add(term);
    for (const value of values) {
      for (const term of meaningfulSearchTerms(value, profile.search.stopWords)) terms.add(term);
    }
  }
  for (const hint of profile.search.categoryHints) {
    for (const term of meaningfulSearchTerms(hint, profile.search.stopWords)) terms.add(term);
  }
  return terms;
}

function validateExpansion(
  expansion: QueryExpansion,
  profile: DiscoveryProfile,
  originalTerms: string[],
) {
  const query = normalizeSearchText(expansion.query);
  const terms = meaningfulSearchTerms(query, profile.search.stopWords);
  if (!query || query.length > 200 || terms.length === 0 || terms.length > 10) return null;
  const allowed = allowedExpansionTerms(profile, originalTerms);
  if (!terms.every((term) => allowed.has(term))) return null;
  if (profile.search.negativeTerms.some((term) => query.includes(normalizeSearchText(term)))) return null;
  if (!Number.isFinite(expansion.confidence) || expansion.confidence < 0 || expansion.confidence > 1) return null;
  return { ...expansion, query };
}

export async function buildQueryExpansions(
  originalQuery: string,
  profile: DiscoveryProfile,
  optionalProvider?: QueryExpansionProvider,
) {
  const original = normalizeSearchText(originalQuery);
  const originalTerms = meaningfulSearchTerms(original, profile.search.stopWords);
  if (!original || original.length > 200 || originalTerms.length === 0 || originalTerms.length > 8) {
    throw new Error('Discovery query must contain between one and eight meaningful terms.');
  }
  const originalExpansion: QueryExpansion = {
    query: original,
    source: 'original',
    confidence: 1,
    reason: 'original user query',
  };
  const deterministic = new DeterministicQueryExpansionProvider();
  const warnings: DiscoveryRunWarning[] = [];
  const proposals = await deterministic.expand({
    originalQuery: original,
    profile,
    maximumExpansions: profile.search.maxExpansions,
  });
  if (optionalProvider && proposals.length < profile.search.maxExpansions) {
    try {
      proposals.push(...await optionalProvider.expand({
        originalQuery: original,
        profile,
        maximumExpansions: profile.search.maxExpansions - proposals.length,
      }));
    } catch {
      warnings.push({ strategy: 'query_expansion', query: original, code: `${optionalProvider.name}_unavailable` });
    }
  }
  const seen = new Set([original]);
  const valid: QueryExpansion[] = [];
  for (const proposal of proposals) {
    const expansion = validateExpansion(proposal, profile, originalTerms);
    if (!expansion || seen.has(expansion.query)) continue;
    seen.add(expansion.query);
    valid.push(expansion);
    if (valid.length >= profile.search.maxExpansions) break;
  }
  return { queries: [originalExpansion, ...valid], warnings };
}

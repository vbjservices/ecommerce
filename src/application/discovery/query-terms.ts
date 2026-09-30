const defaultStopWords = ['and', 'for', 'the', 'with'];

export function normalizeSearchText(value: string) {
  return value.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function meaningfulSearchTerms(query: string, configuredStopWords = defaultStopWords) {
  const stopWords = new Set(configuredStopWords.map(normalizeSearchText));
  return [...new Set(normalizeSearchText(query).split(' '))]
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

export function canonicalTerm(token: string) {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

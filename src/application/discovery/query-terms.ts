const stopWords = new Set(['and', 'for', 'the', 'with']);

export function meaningfulSearchTerms(query: string) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

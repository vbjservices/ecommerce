const candidateIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceRoute =
  | { kind: 'workspace' }
  | { kind: 'imported-product'; candidateId: string };

export function importedProductHash(candidateId: string) {
  if (!candidateIdPattern.test(candidateId)) throw new Error('Invalid imported product ID.');
  return `#/imported/${candidateId}`;
}

export function readWorkspaceRoute(hash: string): WorkspaceRoute {
  const match = hash.match(/^#\/imported\/([^/?#]+)$/i);
  if (!match || !candidateIdPattern.test(match[1]!)) return { kind: 'workspace' };
  return { kind: 'imported-product', candidateId: match[1]!.toLowerCase() };
}

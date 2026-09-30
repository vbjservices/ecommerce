import type { DiscoveryProfile, QueryExpansion } from '../../domain/discovery';

export interface QueryExpansionInput {
  originalQuery: string;
  profile: DiscoveryProfile;
  maximumExpansions: number;
}

export interface QueryExpansionProvider {
  readonly name: string;
  expand(input: QueryExpansionInput): Promise<QueryExpansion[]>;
}

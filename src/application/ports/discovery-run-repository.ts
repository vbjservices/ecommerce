import type { DiscoveryRunResult } from '../../domain/discovery';

export interface PersistedDiscoveryRun {
  runId: string;
  candidateCount: number;
  observationCount: number;
}

export interface DiscoveryRunRepository {
  findFresh(input: {
    providerCode: string;
    profileId: string;
    originalQuery: string;
    configurationVersion: string;
    scoringVersion: string;
    now: string;
  }): Promise<PersistedDiscoveryRun | null>;
  save(
    provider: { code: string; name: string },
    run: DiscoveryRunResult,
  ): Promise<PersistedDiscoveryRun>;
}

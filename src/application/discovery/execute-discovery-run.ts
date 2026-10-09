import type { DiscoveryBudget, DiscoveryProfile } from '../../domain/discovery';
import type { DiscoveryRunRepository, PersistedDiscoveryRun } from '../ports/discovery-run-repository';
import type { QueryExpansionProvider } from '../ports/query-expansion-provider';
import type { SupplierAdapter, SupplierDiscoveryInput } from '../ports/supplier-adapter';
import { DISCOVERY_SCORING_VERSION } from './assess-product';
import { DISCOVERY_CONFIGURATION_VERSION } from './expand-query';
import { normalizeSearchText } from './query-terms';
import { runProductDiscovery } from './run-product-discovery';

export interface ExecuteDiscoveryRunDependencies {
  adapter: SupplierAdapter;
  repository: DiscoveryRunRepository;
  expansionProvider?: QueryExpansionProvider;
  clock?: () => number;
}

export interface ExecuteDiscoveryRunRequest {
  query: string;
  profile: DiscoveryProfile;
  refresh?: boolean;
  budget?: DiscoveryBudget;
  filters?: SupplierDiscoveryInput['filters'];
}

export type ExecuteDiscoveryRunResult =
  | { source: 'cache'; persisted: PersistedDiscoveryRun; run: null }
  | {
      source: 'supplier';
      persisted: PersistedDiscoveryRun;
      run: Awaited<ReturnType<typeof runProductDiscovery>>;
    };

export async function executeDiscoveryRun(
  dependencies: ExecuteDiscoveryRunDependencies,
  request: ExecuteDiscoveryRunRequest,
): Promise<ExecuteDiscoveryRunResult> {
  const normalizedQuery = normalizeSearchText(request.query);
  if (!normalizedQuery) throw new Error('Discovery query is required.');
  const clock = dependencies.clock ?? Date.now;
  if (!request.refresh) {
    const cached = await dependencies.repository.findFresh({
      providerCode: dependencies.adapter.provider,
      profileId: request.profile.id,
      originalQuery: normalizedQuery,
      configurationVersion: DISCOVERY_CONFIGURATION_VERSION,
      scoringVersion: DISCOVERY_SCORING_VERSION,
      now: new Date(clock()).toISOString(),
    });
    if (cached) return { source: 'cache', persisted: cached, run: null };
  }

  const run = await runProductDiscovery(
    dependencies.adapter,
    {
      query: normalizedQuery,
      profile: request.profile,
      ...(request.budget ? { budget: request.budget } : {}),
      ...(request.filters ? { filters: request.filters } : {}),
    },
    dependencies.expansionProvider,
    clock,
  );
  const persisted = await dependencies.repository.save(
    { code: dependencies.adapter.provider, name: dependencies.adapter.providerName },
    run,
  );
  return { source: 'supplier', persisted, run };
}

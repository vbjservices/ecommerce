import '../only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { DiscoveryRunResult } from '../../domain/discovery';
import type {
  DiscoveryRunRepository,
  PersistedDiscoveryRun,
} from '../../application/ports/discovery-run-repository';

const persistenceRow = z.object({
  run_id: z.uuid(),
  candidate_count: z.number().int().nonnegative(),
  observation_count: z.number().int().nonnegative(),
});

const cachedRun = z.object({
  id: z.uuid(),
  metrics: z.object({
    uniqueProductsFound: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

function payload(run: DiscoveryRunResult) {
  return {
    profile_id: run.profileId,
    original_query: run.originalQuery,
    status: run.status,
    configuration_version: run.configurationVersion,
    scoring_version: run.scoringVersion,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    cache_expires_at: run.cacheExpiresAt,
    budget: run.budget,
    metrics: run.metrics,
    warnings: run.warnings,
    queries: run.queries,
    candidates: run.candidates.map((candidate) => {
      const product = candidate.product;
      const firstOccurrence = candidate.occurrences[0];
      return {
        external_product_id: product.externalProductId,
        title: product.title,
        image_url: product.imageUrl,
        source_url: product.sourceUrl,
        eligibility_status: candidate.assessment.eligibility.status,
        relevance_level: candidate.assessment.relevance.level,
        score: candidate.assessment.score,
        confidence: candidate.assessment.confidence,
        coverage: candidate.assessment.coverage,
        assessment: candidate.assessment,
        occurrences: candidate.occurrences.map((occurrence) => ({
          strategy: occurrence.strategy,
          query: occurrence.query,
          query_source: occurrence.querySource,
          page: occurrence.page,
          rank: occurrence.rank,
          sort_by: occurrence.sortBy,
          filters: occurrence.filters,
          source: occurrence.source,
          retrieved_at: occurrence.retrievedAt,
        })),
        observation: {
          observed_at: firstOccurrence?.retrievedAt ?? run.completedAt,
          source: firstOccurrence?.source ?? 'supplier-discovery',
          supplier_cost_min: product.costRange?.minAmount ?? null,
          supplier_cost_max: product.costRange?.maxAmount ?? null,
          currency: product.costRange?.currency ?? null,
          listing_count: product.listedCount,
          inventory: product.inventory,
          verified_inventory: product.verifiedInventory,
          unverified_inventory: product.unverifiedInventory,
          delivery_days_min: product.deliveryDays?.min ?? null,
          delivery_days_max: product.deliveryDays?.max ?? null,
          sale_status: product.saleStatus,
          visible: product.visible,
          normalized_snapshot: product,
        },
      };
    }),
    source_pages: run.sourcePages.map((page) => ({
      strategy: page.strategy,
      query: page.query,
      page: page.page,
      source: page.source,
      retrieved_at: page.retrievedAt,
      raw_payload: page.rawPayload,
    })),
  };
}

export class SupabaseDiscoveryRunRepository implements DiscoveryRunRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findFresh(input: {
    providerCode: string;
    profileId: string;
    originalQuery: string;
    configurationVersion: string;
    scoringVersion: string;
    now: string;
  }): Promise<PersistedDiscoveryRun | null> {
    const result = await this.client.from('discovery_runs')
      .select('id,metrics,suppliers!inner(code)')
      .eq('suppliers.code', input.providerCode)
      .eq('profile_id', input.profileId)
      .eq('original_query', input.originalQuery)
      .eq('configuration_version', input.configurationVersion)
      .eq('scoring_version', input.scoringVersion)
      .in('status', ['completed', 'completed_with_warnings'])
      .gt('cache_expires_at', input.now)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw new Error('Discovery cache could not be checked.');
    if (result.data === null) return null;
    const parsed = cachedRun.safeParse(result.data);
    if (!parsed.success) throw new Error('Discovery cache returned an unexpected result.');
    return {
      runId: parsed.data.id,
      candidateCount: parsed.data.metrics.uniqueProductsFound,
      observationCount: parsed.data.metrics.uniqueProductsFound,
    };
  }

  async save(
    provider: { code: string; name: string },
    run: DiscoveryRunResult,
  ): Promise<PersistedDiscoveryRun> {
    const result = await this.client.rpc('persist_discovery_run', {
      p_supplier_code: provider.code,
      p_supplier_name: provider.name,
      p_run: payload(run),
    });
    if (result.error) throw new Error('Discovery run could not be saved.');
    const parsed = z.array(persistenceRow).safeParse(result.data);
    if (!parsed.success || parsed.data.length !== 1) {
      throw new Error('Discovery persistence returned an unexpected result.');
    }
    const row = parsed.data[0]!;
    return {
      runId: row.run_id,
      candidateCount: row.candidate_count,
      observationCount: row.observation_count,
    };
  }
}

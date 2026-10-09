import '../only';
import type { SupplierDiscoveryInput } from '../../application/ports/supplier-adapter';
import { executeDiscoveryRun } from '../../application/discovery/execute-discovery-run';
import { resolveDiscoveryProfile } from '../../application/discovery/profiles';
import { normalizeSearchText } from '../../application/discovery/query-terms';
import { ConfigurationError } from '../../config/validation';
import { readCjConfig, readOptionalOllamaConfig, readServerConfig } from '../config';
import { createPrivilegedDatabase } from '../db/supabase';
import { SupabaseDiscoveryRunRepository } from './supabase-discovery-run-repository';
import { OllamaQueryExpansionProvider } from '../integrations/query-expansion/ollama';
import { CjSupplierAdapter } from '../integrations/suppliers/cj/adapter';
import { CjClient } from '../integrations/suppliers/cj/client';

export const discoveryJobOutputSchema = 'product-discovery-job.v1';

export interface CjDiscoveryJobRequest {
  query: string;
  profileId: string;
  refresh?: boolean;
  filters?: SupplierDiscoveryInput['filters'];
}

export interface CjDiscoveryJobSummary {
  schema: typeof discoveryJobOutputSchema;
  provider: string;
  profileId: string;
  originalQuery: string;
  source: 'cache' | 'supplier';
  status: 'reused' | 'completed' | 'completed_with_warnings' | 'failed';
  runId: string;
  candidateCount: number;
  observationCount: number;
  eligibleCandidateCount: number | null;
  apiRequestsUsed: number;
  warnings: Array<{ strategy: string; query: string; code: string }>;
  startedAt: string | null;
  completedAt: string | null;
}

export function safeDiscoveryErrorMessage(error: unknown) {
  const safeInputError = error instanceof Error &&
    /^(Usage:|Unknown option:|Unknown discovery profile:|Discovery query|Discovery budget|Discovery profile|Invalid discovery plan)/.test(error.message);
  return error instanceof ConfigurationError || safeInputError
    ? error.message
    : 'CJ discovery failed. Check provider access, Supabase migration, and server configuration.';
}

export function createCjDiscoveryJobRunner(env: Record<string, unknown> = process.env) {
  const cjConfig = readCjConfig(env);
  const serverConfig = readServerConfig(env);
  const ollamaConfig = readOptionalOllamaConfig(env);
  const adapter = new CjSupplierAdapter(new CjClient(cjConfig.apiKey));
  const repository = new SupabaseDiscoveryRunRepository(createPrivilegedDatabase(serverConfig));
  const expansionProvider = ollamaConfig
    ? new OllamaQueryExpansionProvider(ollamaConfig.baseUrl, ollamaConfig.model)
    : undefined;

  return async (request: CjDiscoveryJobRequest) => {
    const profile = resolveDiscoveryProfile(request.profileId);
    if (!profile) throw new Error(`Unknown discovery profile: ${request.profileId}`);
    const result = await executeDiscoveryRun({
      adapter,
      repository,
      ...(expansionProvider ? { expansionProvider } : {}),
    }, {
      query: request.query,
      profile,
      ...(request.refresh === undefined ? {} : { refresh: request.refresh }),
      ...(request.filters === undefined ? {} : { filters: request.filters }),
    });
    const summary: CjDiscoveryJobSummary = {
      schema: discoveryJobOutputSchema,
      provider: adapter.provider,
      profileId: profile.id,
      originalQuery: result.run?.originalQuery ?? normalizeSearchText(request.query),
      source: result.source,
      status: result.run?.status ?? 'reused',
      runId: result.persisted.runId,
      candidateCount: result.persisted.candidateCount,
      observationCount: result.persisted.observationCount,
      eligibleCandidateCount: result.run?.metrics.eligibleCandidateCount ?? null,
      apiRequestsUsed: result.run?.metrics.apiRequestsUsed ?? 0,
      warnings: result.run?.warnings ?? [],
      startedAt: result.run?.startedAt ?? null,
      completedAt: result.run?.completedAt ?? null,
    };
    return { summary, execution: result };
  };
}

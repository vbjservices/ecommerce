import './only';
import { executeDiscoveryRun } from '../application/discovery/execute-discovery-run';
import { resolveDiscoveryProfile } from '../application/discovery/profiles';
import { normalizeSearchText } from '../application/discovery/query-terms';
import { ConfigurationError } from '../config/validation';
import { readCjConfig, readOptionalOllamaConfig, readServerConfig } from './config';
import { createPrivilegedDatabase } from './db/supabase';
import { SupabaseDiscoveryRunRepository } from './discovery/supabase-discovery-run-repository';
import { OllamaQueryExpansionProvider } from './integrations/query-expansion/ollama';
import { CjSupplierAdapter } from './integrations/suppliers/cj/adapter';
import { CjClient } from './integrations/suppliers/cj/client';

function argumentsFrom(values: string[]) {
  let profileId = 'generic';
  let refresh = false;
  let json = false;
  const query: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value.startsWith('--profile=')) {
      profileId = value.slice('--profile='.length);
    } else if (value === '--profile') {
      profileId = values[++index] ?? '';
    } else if (value === '--refresh') {
      refresh = true;
    } else if (value === '--json') {
      json = true;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      query.push(value);
    }
  }
  return { profileId, query: query.join(' ').trim(), refresh, json };
}

const outputSchema = 'product-discovery-job.v1';
const jsonRequested = process.argv.slice(2).includes('--json');

try {
  const input = argumentsFrom(process.argv.slice(2));
  const profile = resolveDiscoveryProfile(input.profileId);
  if (!input.query || !profile) {
    throw new Error('Usage: npm run discovery:run -- "cat toy" --profile=pets [--refresh] [--json]');
  }
  const cjConfig = readCjConfig(process.env);
  const serverConfig = readServerConfig(process.env);
  const ollamaConfig = readOptionalOllamaConfig(process.env);
  const adapter = new CjSupplierAdapter(new CjClient(cjConfig.apiKey));
  const repository = new SupabaseDiscoveryRunRepository(createPrivilegedDatabase(serverConfig));
  const expansionProvider = ollamaConfig
    ? new OllamaQueryExpansionProvider(ollamaConfig.baseUrl, ollamaConfig.model)
    : undefined;
  const result = await executeDiscoveryRun({
    adapter,
    repository,
    ...(expansionProvider ? { expansionProvider } : {}),
  }, {
    query: input.query,
    profile,
    refresh: input.refresh,
  });
  const summary = {
    schema: outputSchema,
    provider: adapter.provider,
    profileId: profile.id,
    originalQuery: result.run?.originalQuery ?? normalizeSearchText(input.query),
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
  if (input.json) {
    console.log(JSON.stringify(summary));
  } else if (result.source === 'cache') {
    console.log(
      `Reused fresh discovery run ${result.persisted.runId} with ` +
      `${result.persisted.candidateCount} candidates. Pass --refresh to collect new supplier observations.`,
    );
  } else {
    console.table(result.run.candidates.slice(0, 10).map((candidate) => ({
      eligibility: candidate.assessment.eligibility.status,
      score: candidate.assessment.score,
      confidence: `${candidate.assessment.confidence}%`,
      coverage: `${candidate.assessment.coverage}%`,
      relevance: candidate.assessment.relevance.level,
      strategies: new Set(candidate.occurrences.map((item) => item.strategy)).size,
      images: candidate.product.imageUrls.length,
      listed: candidate.product.listedCount ?? 'unknown',
      verifiedStock: candidate.product.verifiedInventory ?? 'unknown',
      title: candidate.product.title,
      productId: candidate.product.externalProductId,
      risks: candidate.assessment.risks.map((risk) => risk.ruleId).join(', '),
    })));
    console.log(
      `Saved discovery run ${result.persisted.runId}: ${result.persisted.candidateCount} candidates, ` +
      `${result.persisted.observationCount} observations, ${result.run.metrics.apiRequestsUsed} CJ requests, ` +
      `status ${result.run.status}.`,
    );
  }
  if (result.run?.status === 'failed') process.exitCode = 1;
} catch (error) {
  const safeInputError = error instanceof Error &&
    /^(Usage:|Unknown option:|Discovery budget|Discovery profile)/.test(error.message);
  const message = error instanceof ConfigurationError || safeInputError
    ? error.message
    : 'CJ discovery failed. Check provider access, Supabase migration, and server configuration.';
  console.error(jsonRequested
    ? JSON.stringify({ schema: outputSchema, status: 'failed', error: message })
    : message);
  process.exitCode = 1;
}

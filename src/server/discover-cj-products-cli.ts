import './only';
import { DISCOVERY_SCORING_VERSION } from '../application/discovery/assess-product';
import { DISCOVERY_CONFIGURATION_VERSION } from '../application/discovery/expand-query';
import { normalizeSearchText } from '../application/discovery/query-terms';
import { runProductDiscovery } from '../application/discovery/run-product-discovery';
import { resolveDiscoveryProfile } from '../application/discovery/profiles';
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
  const query: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value.startsWith('--profile=')) {
      profileId = value.slice('--profile='.length);
    } else if (value === '--profile') {
      profileId = values[++index] ?? '';
    } else if (value === '--refresh') {
      refresh = true;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      query.push(value);
    }
  }
  return { profileId, query: query.join(' ').trim(), refresh };
}

try {
  const input = argumentsFrom(process.argv.slice(2));
  const profile = resolveDiscoveryProfile(input.profileId);
  if (!input.query || !profile) {
    throw new Error('Usage: npm run cj:discover -- "cat toy" --profile=pets');
  }
  const cjConfig = readCjConfig(process.env);
  const serverConfig = readServerConfig(process.env);
  const ollamaConfig = readOptionalOllamaConfig(process.env);
  const adapter = new CjSupplierAdapter(new CjClient(cjConfig.apiKey));
  const repository = new SupabaseDiscoveryRunRepository(createPrivilegedDatabase(serverConfig));
  const expansionProvider = ollamaConfig
    ? new OllamaQueryExpansionProvider(ollamaConfig.baseUrl, ollamaConfig.model)
    : undefined;
  const cached = input.refresh ? null : await repository.findFresh({
    providerCode: adapter.provider,
    profileId: profile.id,
    originalQuery: normalizeSearchText(input.query),
    configurationVersion: DISCOVERY_CONFIGURATION_VERSION,
    scoringVersion: DISCOVERY_SCORING_VERSION,
    now: new Date().toISOString(),
  });
  if (cached) {
    console.log(
      `Reused fresh discovery run ${cached.runId} with ${cached.candidateCount} candidates. ` +
      'Pass --refresh to collect new supplier observations.',
    );
  } else {
    const run = await runProductDiscovery(adapter, { query: input.query, profile }, expansionProvider);
    const saved = await repository.save(
      { code: adapter.provider, name: adapter.providerName },
      run,
    );
    console.table(run.candidates.slice(0, 10).map((candidate) => ({
      eligibility: candidate.assessment.eligibility.status,
      score: candidate.assessment.score,
      confidence: `${candidate.assessment.confidence}%`,
      coverage: `${candidate.assessment.coverage}%`,
      relevance: candidate.assessment.relevance.level,
      strategies: new Set(candidate.occurrences.map((item) => item.strategy)).size,
      listed: candidate.product.listedCount ?? 'unknown',
      verifiedStock: candidate.product.verifiedInventory ?? 'unknown',
      title: candidate.product.title,
      productId: candidate.product.externalProductId,
      risks: candidate.assessment.risks.map((risk) => risk.ruleId).join(', '),
    })));
    console.log(
      `Saved discovery run ${saved.runId}: ${saved.candidateCount} candidates, ` +
      `${saved.observationCount} observations, ${run.metrics.apiRequestsUsed} CJ requests, ` +
      `status ${run.status}.`,
    );
    if (run.status === 'failed') process.exitCode = 1;
  }
} catch (error) {
  const safeInputError = error instanceof Error &&
    /^(Usage:|Unknown option:|Discovery budget|Discovery profile)/.test(error.message);
  console.error(error instanceof ConfigurationError || safeInputError
    ? error.message
    : 'CJ discovery failed. Check provider access, Supabase migration, and server configuration.');
  process.exitCode = 1;
}

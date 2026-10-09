import './only';
import {
  createCjDiscoveryJobRunner,
  discoveryJobOutputSchema,
  safeDiscoveryErrorMessage,
} from './discovery/cj-discovery-job';

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

const jsonRequested = process.argv.slice(2).includes('--json');

try {
  const input = argumentsFrom(process.argv.slice(2));
  if (!input.query) {
    throw new Error('Usage: npm run discovery:run -- "cat toy" --profile=pets [--refresh] [--json]');
  }
  const { summary, execution: result } = await createCjDiscoveryJobRunner(process.env)({
    query: input.query,
    profileId: input.profileId,
    refresh: input.refresh,
  });
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
  const message = safeDiscoveryErrorMessage(error);
  console.error(jsonRequested
    ? JSON.stringify({ schema: discoveryJobOutputSchema, status: 'failed', error: message })
    : message);
  process.exitCode = 1;
}

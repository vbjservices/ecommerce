import './only';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveDiscoveryProfile } from '../application/discovery/profiles';
import {
  createCjDiscoveryJobRunner,
  safeDiscoveryErrorMessage,
  type CjDiscoveryJobRequest,
  type CjDiscoveryJobSummary,
} from './discovery/cj-discovery-job';
import {
  discoveryBatchOutputSchema,
  discoveryPlanInputSchema,
  parseDiscoveryPlan,
} from './discovery/discovery-plan';

function argumentsFrom(values: string[]) {
  let planPath = '';
  let validate = false;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value.startsWith('--plan=')) planPath = value.slice('--plan='.length);
    else if (value === '--plan') planPath = values[++index] ?? '';
    else if (value === '--validate') validate = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!planPath) throw new Error('Usage: npm run discovery:batch -- --plan <file.json> [--validate]');
  return { planPath, validate };
}

const startedAt = new Date().toISOString();

function definedFilters(
  filters: Record<string, string | number | boolean | undefined>,
): NonNullable<CjDiscoveryJobRequest['filters']> {
  return Object.fromEntries(
    Object.entries(filters).filter((entry): entry is [string, string | number | boolean] =>
      entry[1] !== undefined),
  ) as NonNullable<CjDiscoveryJobRequest['filters']>;
}

try {
  const input = argumentsFrom(process.argv.slice(2));
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(input.planPath), 'utf8'));
  } catch {
    throw new Error('Invalid discovery plan. The plan file must contain valid JSON.');
  }
  const plan = parseDiscoveryPlan(raw);
  for (const job of plan.jobs) {
    if (!resolveDiscoveryProfile(job.profileId)) {
      throw new Error(`Unknown discovery profile: ${job.profileId}`);
    }
  }
  if (input.validate) {
    console.log(JSON.stringify({
      schema: 'product-discovery-plan-validation.v1',
      planSchema: discoveryPlanInputSchema,
      planId: plan.planId,
      jobCount: plan.jobs.length,
      valid: true,
    }));
  } else {
    const runJob = createCjDiscoveryJobRunner(process.env);
    const results: Array<CjDiscoveryJobSummary | {
      schema: 'product-discovery-job.v1';
      profileId: string;
      originalQuery: string;
      status: 'failed';
      error: string;
    }> = [];
    let failedJobCount = 0;
    for (const job of plan.jobs) {
      try {
        const result = await runJob({
          query: job.query,
          profileId: job.profileId,
          ...(job.refresh === undefined ? {} : { refresh: job.refresh }),
          ...(job.filters === undefined ? {} : { filters: definedFilters(job.filters) }),
        });
        results.push(result.summary);
        if (result.summary.status === 'failed') failedJobCount++;
      } catch (error) {
        failedJobCount++;
        results.push({
          schema: 'product-discovery-job.v1',
          profileId: job.profileId,
          originalQuery: job.query,
          status: 'failed',
          error: safeDiscoveryErrorMessage(error),
        });
      }
    }
    const completed = results.filter((result): result is CjDiscoveryJobSummary => 'runId' in result);
    const hasWarnings = completed.some((result) => result.status === 'completed_with_warnings');
    const status = failedJobCount === plan.jobs.length
      ? 'failed'
      : failedJobCount > 0 || hasWarnings ? 'completed_with_warnings' : 'completed';
    console.log(JSON.stringify({
      schema: discoveryBatchOutputSchema,
      planId: plan.planId,
      status,
      jobCount: plan.jobs.length,
      completedJobCount: completed.length,
      failedJobCount,
      totals: {
        candidateCount: completed.reduce((total, result) => total + result.candidateCount, 0),
        observationCount: completed.reduce((total, result) => total + result.observationCount, 0),
        apiRequestsUsed: completed.reduce((total, result) => total + result.apiRequestsUsed, 0),
      },
      startedAt,
      completedAt: new Date().toISOString(),
      results,
    }));
    if (failedJobCount > 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({
    schema: discoveryBatchOutputSchema,
    status: 'failed',
    error: safeDiscoveryErrorMessage(error),
  }));
  process.exitCode = 1;
}

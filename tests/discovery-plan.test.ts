import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoveryPlanInputSchema,
  maximumJobsPerPlan,
  parseDiscoveryPlan,
} from '../src/server/discovery/discovery-plan';

test('ORION discovery plans are bounded, strict, and preserve dynamic supplier filters', () => {
  const parsed = parseDiscoveryPlan({
    schema: discoveryPlanInputSchema,
    planId: 'pets-night-01',
    jobs: [{
      query: 'interactive cat toy',
      profileId: 'pets',
      filters: { categoryId: 'cat-toys', warehouseCountry: 'DE', minInventory: 250 },
    }],
  });
  assert.equal(parsed.jobs[0]!.filters?.warehouseCountry, 'DE');
  assert.throws(() => parseDiscoveryPlan({
    schema: discoveryPlanInputSchema,
    planId: 'too-many',
    jobs: Array.from({ length: maximumJobsPerPlan + 1 }, (_, index) => ({ query: `query ${index}` })),
  }), /Invalid discovery plan/);
  assert.throws(() => parseDiscoveryPlan({
    schema: discoveryPlanInputSchema,
    planId: 'unknown-field',
    jobs: [{ query: 'cat toy', unsafeBudget: 100_000 }],
  }), /Invalid discovery plan/);
});

test('ORION discovery plans reject duplicate jobs that would waste supplier budget', () => {
  assert.throws(() => parseDiscoveryPlan({
    schema: discoveryPlanInputSchema,
    planId: 'duplicates',
    jobs: [
      { query: 'Cat Toy', profileId: 'pets' },
      { query: ' cat   toy ', profileId: 'pets' },
    ],
  }), /Invalid discovery plan/);
});

import '../only';
import { z } from 'zod';
import { normalizeSearchText } from '../../application/discovery/query-terms';

export const discoveryPlanInputSchema = 'product-discovery-plan.v1';
export const discoveryBatchOutputSchema = 'product-discovery-batch.v1';
export const maximumJobsPerPlan = 4;

const filters = z.object({
  categoryId: z.string().trim().min(1).max(200).optional(),
  warehouseCountry: z.string().trim().regex(/^[A-Z]{2}$/).optional(),
  minCost: z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).optional(),
  maxCost: z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).optional(),
  minInventory: z.number().int().nonnegative().optional(),
  verifiedOnly: z.boolean().optional(),
  productFlag: z.enum(['trending', 'new', 'video', 'slow_moving']).optional(),
  freeShipping: z.boolean().optional(),
  hasCertification: z.boolean().optional(),
  customizable: z.boolean().optional(),
}).strict();

const job = z.object({
  query: z.string().trim().min(1).max(200),
  profileId: z.string().trim().min(1).max(100).default('generic'),
  refresh: z.boolean().optional(),
  filters: filters.optional(),
}).strict();

const plan = z.object({
  schema: z.literal(discoveryPlanInputSchema),
  planId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  jobs: z.array(job).min(1).max(maximumJobsPerPlan),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.jobs.forEach((item, index) => {
    const identity = JSON.stringify([
      normalizeSearchText(item.query), item.profileId, item.filters ?? {}, item.refresh ?? false,
    ]);
    if (seen.has(identity)) {
      context.addIssue({
        code: 'custom',
        path: ['jobs', index],
        message: 'Duplicate discovery job.',
      });
    }
    seen.add(identity);
  });
});

export type DiscoveryPlan = z.infer<typeof plan>;

export function parseDiscoveryPlan(value: unknown): DiscoveryPlan {
  const parsed = plan.safeParse(value);
  if (!parsed.success) throw new Error('Invalid discovery plan. Check its schema, limits, and field values.');
  return parsed.data;
}

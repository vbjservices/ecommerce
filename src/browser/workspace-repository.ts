import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { candidateStatuses } from '../domain/candidates';

const candidateSummary = z.object({
  id: z.uuid(), status: z.enum(candidateStatuses), created_at: z.string(),
  products: z.object({
    title: z.string(),
    image_url: z.string().nullable(),
    image_urls: z.array(z.string()),
  }),
  supplier_products: z.object({
    external_product_id: z.string(),
    source_url: z.string().nullable(),
    last_seen_at: z.string(),
    suppliers: z.object({ name: z.string() }),
    supplier_variants: z.array(z.object({
      cost: z.union([z.number().nonnegative(), z.string()]).nullable(),
      currency: z.string().nullable(),
      stock: z.number().int().nonnegative().nullable(),
    })),
  }),
});
export type CandidateSummary = z.infer<typeof candidateSummary>;

const discoveryCandidateSummary = z.object({
  id: z.uuid(),
  rank: z.number().int().positive(),
  external_product_id: z.string(),
  title: z.string(),
  image_url: z.string().nullable(),
  image_urls: z.array(z.string()),
  source_url: z.string().nullable(),
  eligibility_status: z.enum(['pass', 'review', 'fail']),
  relevance_level: z.enum(['exact', 'strong', 'related', 'weak', 'irrelevant']),
  score: z.union([z.number(), z.string()]),
  confidence: z.union([z.number(), z.string()]),
  coverage: z.union([z.number(), z.string()]),
  suppliers: z.object({ name: z.string() }),
  discovery_runs: z.object({
    original_query: z.string(),
    profile_id: z.string(),
    completed_at: z.string(),
  }),
  discovery_occurrences: z.array(z.object({ strategy: z.string() })),
  supplier_product_observations: z.array(z.object({
    supplier_cost_min: z.union([z.number().nonnegative(), z.string()]).nullable(),
    supplier_cost_max: z.union([z.number().nonnegative(), z.string()]).nullable(),
    currency: z.string().nullable(),
    listing_count: z.number().int().nonnegative().nullable(),
    inventory: z.number().int().nonnegative().nullable(),
    verified_inventory: z.number().int().nonnegative().nullable(),
    delivery_days_min: z.number().int().nonnegative().nullable(),
    delivery_days_max: z.number().int().nonnegative().nullable(),
  })).max(1),
  assessment: z.object({
    positiveEvidence: z.array(z.string()),
    unknownEvidence: z.array(z.string()),
    eligibility: z.object({ reasons: z.array(z.string()) }),
    risks: z.array(z.object({
      ruleId: z.string(),
      severity: z.string(),
      explanation: z.string(),
    })),
  }),
});
export type DiscoveryCandidateSummary = z.infer<typeof discoveryCandidateSummary>;

/** A narrow, RLS-protected read model; no raw payloads or browser workflow writes. */
export async function readRecentCandidates(client: SupabaseClient): Promise<CandidateSummary[]> {
  const result = await client.from('product_candidates')
    .select(`id,status,created_at,products!inner(title,image_url,image_urls),supplier_products!inner(
      external_product_id,source_url,last_seen_at,suppliers!inner(name),
      supplier_variants(cost,currency,stock)
    )`)
    .order('created_at', { ascending: false }).limit(20);
  // Keep Pages usable while either additive image migration is being applied.
  let data: unknown = result.data;
  let error = result.error;
  if (error?.code === '42703' || error?.code === 'PGRST204') {
    const primaryOnly = await client.from('product_candidates')
      .select(`id,status,created_at,products!inner(title,image_url),supplier_products!inner(
        external_product_id,source_url,last_seen_at,suppliers!inner(name),
        supplier_variants(cost,currency,stock)
      )`)
      .order('created_at', { ascending: false }).limit(20);
    const primaryData = primaryOnly.data as unknown as Array<Record<string, unknown>> | null;
    error = primaryOnly.error;
    data = primaryData?.map((candidate) => {
      const product = candidate.products as Record<string, unknown>;
      const imageUrl = typeof product.image_url === 'string' ? product.image_url : null;
      return {
        ...candidate,
        products: { ...product, image_urls: imageUrl ? [imageUrl] : [] },
      };
    }) ?? null;
    if (error?.code === '42703' || error?.code === 'PGRST204') {
      const legacy = await client.from('product_candidates')
        .select(`id,status,created_at,products!inner(title),supplier_products!inner(
          external_product_id,source_url,last_seen_at,suppliers!inner(name),
          supplier_variants(cost,currency,stock)
        )`)
        .order('created_at', { ascending: false }).limit(20);
      const legacyData = legacy.data as unknown as Array<Record<string, unknown>> | null;
      error = legacy.error;
      data = legacyData?.map((candidate) => ({
          ...candidate,
          products: { ...(candidate.products as Record<string, unknown>), image_url: null, image_urls: [] },
      })) ?? null;
    }
  }
  if (error) throw new Error('Candidates could not be loaded. Please try again.');
  const parsed = z.array(candidateSummary).safeParse(data);
  if (!parsed.success) throw new Error('The workspace data is not in the expected format. Contact an administrator.');
  return parsed.data;
}

/** V2 discovery results are optional during the additive schema rollout. */
export async function readRecentDiscoveryCandidates(
  client: SupabaseClient,
): Promise<DiscoveryCandidateSummary[]> {
  const result = await client.from('discovery_candidates')
    .select(`id,rank,external_product_id,title,image_url,image_urls,source_url,eligibility_status,relevance_level,
      score,confidence,coverage,assessment,suppliers!inner(name),
      discovery_runs!inner(original_query,profile_id,completed_at),
      discovery_occurrences(strategy),supplier_product_observations(
        supplier_cost_min,supplier_cost_max,currency,listing_count,inventory,
        verified_inventory,delivery_days_min,delivery_days_max
      )`)
    .order('created_at', { ascending: false })
    .order('rank', { ascending: true })
    .limit(20);
  if (result.error?.code === '42P01' || result.error?.code === 'PGRST205') return [];
  let data: unknown = result.data;
  let error = result.error;
  if (error?.code === '42703' || error?.code === 'PGRST204') {
    const primaryOnly = await client.from('discovery_candidates')
      .select(`id,rank,external_product_id,title,image_url,source_url,eligibility_status,relevance_level,
        score,confidence,coverage,assessment,suppliers!inner(name),
        discovery_runs!inner(original_query,profile_id,completed_at),
        discovery_occurrences(strategy),supplier_product_observations(
          supplier_cost_min,supplier_cost_max,currency,listing_count,inventory,
          verified_inventory,delivery_days_min,delivery_days_max
        )`)
      .order('created_at', { ascending: false })
      .order('rank', { ascending: true })
      .limit(20);
    error = primaryOnly.error;
    data = (primaryOnly.data as unknown as Array<Record<string, unknown>> | null)?.map((candidate) => ({
      ...candidate,
      image_urls: typeof candidate.image_url === 'string' ? [candidate.image_url] : [],
    })) ?? null;
  }
  if (error) throw new Error('Discovery results could not be loaded. Please try again.');
  const parsed = z.array(discoveryCandidateSummary).safeParse(data);
  if (!parsed.success) throw new Error('The discovery data is not in the expected format. Contact an administrator.');
  return parsed.data;
}

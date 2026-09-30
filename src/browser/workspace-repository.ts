import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { candidateStatuses } from '../domain/candidates';

const candidateSummary = z.object({
  id: z.uuid(), status: z.enum(candidateStatuses), created_at: z.string(),
  products: z.object({ title: z.string(), image_url: z.string().nullable() }),
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

/** A narrow, RLS-protected read model; no raw payloads or browser workflow writes. */
export async function readRecentCandidates(client: SupabaseClient): Promise<CandidateSummary[]> {
  const result = await client.from('product_candidates')
    .select(`id,status,created_at,products!inner(title,image_url),supplier_products!inner(
      external_product_id,source_url,last_seen_at,suppliers!inner(name),
      supplier_variants(cost,currency,stock)
    )`)
    .order('created_at', { ascending: false }).limit(20);
  if (result.error) throw new Error('Candidates could not be loaded. Please try again.');
  const parsed = z.array(candidateSummary).safeParse(result.data);
  if (!parsed.success) throw new Error('The workspace data is not in the expected format. Contact an administrator.');
  return parsed.data;
}

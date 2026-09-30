import '../only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  SupplierIngestionRepository,
  SupplierIngestionResult,
} from '../../application/ports/supplier-ingestion-repository';
import type { SupplierSnapshot } from '../../application/ports/supplier-adapter';

const ingestionRow = z.object({
  product_id: z.uuid(),
  supplier_product_id: z.uuid(),
  candidate_id: z.uuid(),
  created: z.boolean(),
  variant_count: z.number().int().nonnegative(),
});

export class SupabaseSupplierIngestionRepository implements SupplierIngestionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async save(
    provider: { code: string; name: string },
    snapshot: SupplierSnapshot,
  ): Promise<SupplierIngestionResult> {
    const result = await this.client.rpc('ingest_supplier_product', {
      p_supplier_code: provider.code,
      p_supplier_name: provider.name,
      p_external_product_id: snapshot.product.externalProductId,
      p_title: snapshot.product.title,
      p_description: snapshot.product.description,
      p_image_url: snapshot.product.imageUrl,
      p_source_url: snapshot.product.sourceUrl,
      p_retrieved_at: snapshot.retrievedAt,
      p_source: snapshot.source,
      p_variants: snapshot.product.variants.map((variant) => ({
        external_variant_id: variant.externalVariantId,
        sku: variant.sku,
        options: variant.options,
        cost: variant.cost.value?.amount ?? null,
        currency: variant.cost.value?.currency ?? null,
        stock: variant.stock.value,
      })),
      p_raw_payload: snapshot.rawPayload,
    });
    if (result.error) throw new Error('Supplier product could not be saved.');
    const parsed = z.array(ingestionRow).safeParse(result.data);
    if (!parsed.success || parsed.data.length !== 1) {
      throw new Error('Supplier ingestion returned an unexpected result.');
    }
    const row = parsed.data[0]!;
    return {
      productId: row.product_id,
      supplierProductId: row.supplier_product_id,
      candidateId: row.candidate_id,
      created: row.created,
      variantCount: row.variant_count,
    };
  }
}

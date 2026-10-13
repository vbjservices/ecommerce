import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const rpcSql = `select * from public.ingest_supplier_product(
  $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::jsonb, $11::jsonb
)`;

async function migrate(db: PGlite) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
  `);
  for (const file of (await readdir('supabase/migrations')).sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  }
  // The gallery migration is also distributed for SQL Editor use, where a previous
  // attempt can leave the first helper function behind. A retry must be harmless.
  await db.exec(await readFile(
    'supabase/migrations/20260930000300_product_image_galleries.sql',
    'utf8',
  ));
  await db.exec(await readFile(
    'supabase/migrations/20261001000100_supplier_shipping_quotes.sql',
    'utf8',
  ));
  await db.exec(await readFile(
    'supabase/migrations/20261001000200_product_reviews.sql',
    'utf8',
  ));
  await db.exec(await readFile(
    'supabase/migrations/20261001000300_shopify_draft_listings.sql',
    'utf8',
  ));
}

async function ingest(
  db: PGlite,
  role: 'service_role' | 'authenticated',
  retrievedAt: string,
  variants: unknown[],
) {
  await db.exec('begin');
  try {
    await db.exec(`set local role ${role}`);
    const result = await db.query<{
      product_id: string;
      supplier_product_id: string;
      candidate_id: string;
      created: boolean;
      variant_count: number;
    }>(rpcSql, [
      'cj',
      'CJdropshipping',
      '1561984433618694144',
      'Catnip Balls Cat Treats Rotary Molar Teeth Cleaning',
      'Plain text description',
      'https://cf.cjdropshipping.com/product/catnip-balls.jpg',
      'https://cjdropshipping.com/product/catnip-p-1561984433618694144.html',
      retrievedAt,
      'cj-api-v2',
      JSON.stringify(variants),
      JSON.stringify({
        product: {
          requestId: `product-${retrievedAt}`,
          data: {
            bigImage: 'https://cf.cjdropshipping.com/product/catnip-balls.jpg',
            productImageSet: [
              'https://cf.cjdropshipping.com/product/catnip-balls-alt.jpg',
              'javascript:invalid',
            ],
          },
        },
        variants: {
          data: variants.map((variant) => {
            const value = variant as { external_variant_id?: unknown; image_url?: unknown };
            return {
              vid: value.external_variant_id,
              variantImage: value.image_url,
            };
          }),
        },
      }),
    ]);
    await db.exec('commit');
    return result.rows[0]!;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

test('trusted supplier ingestion is atomic, idempotent, and retains raw history', async () => {
  const db = new PGlite();
  await migrate(db);
  const reviewer = '00000000-0000-4000-8000-000000000099';
  await db.exec(`
    insert into auth.users(id) values ('${reviewer}');
    insert into private.internal_users(user_id) values ('${reviewer}');
  `);
  const initialVariants = [
    {
      external_variant_id: '1561984433677414400',
      sku: 'CJMY154835401AZ',
      options: { Quantity: '1pcs' },
      cost: null,
      currency: null,
      stock: null,
      image_url: 'https://cf.cjdropshipping.com/product/catnip-one.jpg',
    },
    {
      external_variant_id: '2506170616321605300',
      sku: 'CJMY154835404DW',
      options: { Quantity: '10pcs' },
      cost: '3.16',
      currency: 'USD',
      stock: 8337,
      image_url: 'https://cf.cjdropshipping.com/product/catnip-ten.jpg',
    },
  ];
  try {
    await assert.rejects(
      ingest(db, 'authenticated', '2026-09-29T10:00:00Z', initialVariants),
      /permission denied/,
    );

    const first = await ingest(db, 'service_role', '2026-09-29T10:00:00Z', initialVariants);
    assert.equal(first.created, true);
    assert.equal(first.variant_count, 2);

    const refreshedVariants = structuredClone(initialVariants);
    refreshedVariants[1]!.cost = '3.25';
    refreshedVariants[1]!.stock = 8200;
    const second = await ingest(db, 'service_role', '2026-09-29T11:00:00Z', refreshedVariants);
    assert.equal(second.created, false);
    assert.equal(second.product_id, first.product_id);
    assert.equal(second.supplier_product_id, first.supplier_product_id);
    assert.equal(second.candidate_id, first.candidate_id);

    for (const [table, expected] of [
      ['products', 1],
      ['supplier_products', 1],
      ['product_variants', 2],
      ['supplier_variants', 2],
      ['product_candidates', 1],
    ] as const) {
      const count = await db.query<{ count: number }>(`select count(*)::int as count from public.${table}`);
      assert.equal(count.rows[0]!.count, expected, table);
    }
    const snapshots = await db.query<{ count: number }>(
      'select count(*)::int as count from private.supplier_snapshots',
    );
    assert.equal(snapshots.rows[0]!.count, 2);

    const products = await db.query<{ image_url: string | null; image_urls: string[] }>(
      'select image_url,image_urls from public.products',
    );
    assert.equal(products.rows[0]!.image_url, 'https://cf.cjdropshipping.com/product/catnip-balls.jpg');
    assert.deepEqual(products.rows[0]!.image_urls, [
      'https://cf.cjdropshipping.com/product/catnip-balls.jpg',
      'https://cf.cjdropshipping.com/product/catnip-balls-alt.jpg',
    ]);

    const variants = await db.query<{
      external_variant_id: string;
      cost: string | null;
      currency: string | null;
      stock: number | null;
      image_url: string | null;
    }>('select external_variant_id,cost::text,currency,stock,image_url from public.supplier_variants order by external_variant_id');
    assert.deepEqual(variants.rows, [
      {
        external_variant_id: '1561984433677414400',
        cost: null,
        currency: null,
        stock: null,
        image_url: 'https://cf.cjdropshipping.com/product/catnip-one.jpg',
      },
      {
        external_variant_id: '2506170616321605300',
        cost: '3.250000',
        currency: 'USD',
        stock: 8200,
        image_url: 'https://cf.cjdropshipping.com/product/catnip-ten.jpg',
      },
    ]);

    const quotedVariant = await db.query<{ id: string }>(
      `select id from public.supplier_variants
       where external_variant_id = '2506170616321605300'`,
    );
    const quoteSql = `select public.upsert_supplier_shipping_quotes(
      $1::uuid, $2::timestamptz, $3, $4::jsonb, $5::jsonb
    ) as saved`;
    const quotePayload = JSON.stringify([
      {
        destination_country_code: 'NL', origin_country_code: 'CN', quantity: 1,
        available: true, shipping_method: 'CJPacket', cost: '4.25', currency: 'USD',
        delivery_days_min: 7, delivery_days_max: 12,
      },
      {
        destination_country_code: 'BE', origin_country_code: 'CN', quantity: 1,
        available: false, shipping_method: null, cost: null, currency: null,
        delivery_days_min: null, delivery_days_max: null,
      },
    ]);
    await db.exec('begin');
    try {
      await db.exec('set local role authenticated');
      await assert.rejects(db.query(quoteSql, [
        quotedVariant.rows[0]!.id, '2026-09-29T11:30:00Z', 'cj-freight',
        quotePayload, JSON.stringify({ request: 'private' }),
      ]), /permission denied/);
    } finally {
      await db.exec('rollback');
    }
    await db.exec('begin');
    try {
      await db.exec('set local role service_role');
      const saved = await db.query<{ saved: number }>(quoteSql, [
        quotedVariant.rows[0]!.id, '2026-09-29T11:30:00Z', 'cj-freight',
        quotePayload, JSON.stringify({ request: 'private' }),
      ]);
      assert.equal(saved.rows[0]!.saved, 2);
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
    const shippingQuotes = await db.query<{
      destination_country_code: string; available: boolean; cost: string | null;
    }>(`select destination_country_code,available,cost::text
        from public.supplier_shipping_quotes order by destination_country_code desc`);
    assert.deepEqual(shippingQuotes.rows, [
      { destination_country_code: 'NL', available: true, cost: '4.250000' },
      { destination_country_code: 'BE', available: false, cost: null },
    ]);
    const shippingSnapshots = await db.query<{ count: number }>(
      'select count(*)::int as count from private.supplier_shipping_snapshots',
    );
    assert.equal(shippingSnapshots.rows[0]!.count, 1);

    const supplier = await db.query<{ id: string }>(
      `select id from public.suppliers where code = 'cj'`,
    );
    const run = await db.query<{ id: string }>(`
      insert into public.discovery_runs(
        supplier_id,profile_id,original_query,status,configuration_version,scoring_version,
        started_at,completed_at,cache_expires_at,budget,metrics,warnings
      ) values (
        $1::uuid,'pets','cat toy','completed','test','test',
        '2026-09-29T09:00:00Z','2026-09-29T09:01:00Z','2026-09-30T09:01:00Z',
        '{}'::jsonb,'{}'::jsonb,'[]'::jsonb
      ) returning id
    `, [supplier.rows[0]!.id]);
    const discovery = await db.query<{ id: string }>(`
      insert into public.discovery_candidates(
        run_id,supplier_id,external_product_id,rank,title,eligibility_status,relevance_level,
        score,confidence,coverage,assessment
      ) values (
        $1::uuid,$2::uuid,'1561984433618694144',1,'Catnip Balls','pass','exact',
        90,90,90,'{}'::jsonb
      ) returning id
    `, [run.rows[0]!.id, supplier.rows[0]!.id]);
    await db.exec('begin');
    try {
      await db.exec('set local role service_role');
      const discoveryQuotePayload = JSON.stringify([{
        destination_country_code: 'DE', origin_country_code: 'CN', quantity: 1,
        available: true, shipping_method: 'CJPacket', cost: '5.50', currency: 'USD',
        delivery_days_min: 6, delivery_days_max: 10,
      }]);
      const saved = await db.query<{ saved: number }>(`
        select public.upsert_discovery_shipping_quotes(
          $1::uuid,$2,$3::timestamptz,$4,$5::jsonb,$6::jsonb
        ) as saved
      `, [
        discovery.rows[0]!.id, '2506170616321605300', '2026-09-29T11:45:00Z',
        'cj-freight', discoveryQuotePayload, JSON.stringify({ request: 'private' }),
      ]);
      assert.equal(saved.rows[0]!.saved, 1);
      const promoted = await db.query<{ promoted: number }>(`
        select public.promote_discovery_shipping_quotes($1::uuid,$2::uuid) as promoted
      `, [discovery.rows[0]!.id, first.supplier_product_id]);
      assert.equal(promoted.rows[0]!.promoted, 1);
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
    const promotedQuote = await db.query<{ cost: string }>(`
      select cost::text from public.supplier_shipping_quotes
      where supplier_variant_id = $1::uuid and destination_country_code = 'DE'
    `, [quotedVariant.rows[0]!.id]);
    assert.deepEqual(promotedQuote.rows, [{ cost: '5.500000' }]);

    const reviewVariants = JSON.stringify([{
      supplier_variant_id: quotedVariant.rows[0]!.id,
      selected: true,
      retail_price: '19.99',
    }]);
    const reviewSql = `select * from public.review_product_candidate(
      $1::uuid,'approve',$2,$3,'EUR','USD',0.90,10,array['NL'],$4,$5::jsonb,$6::uuid
    )`;
    await db.exec('begin');
    try {
      await db.exec('set local role authenticated');
      await assert.rejects(db.query(reviewSql, [
        first.candidate_id, 'Reviewed Catnip Balls', 'Store description',
        'Ready for a Shopify draft.', reviewVariants, reviewer,
      ]), /permission denied/);
    } finally {
      await db.exec('rollback');
    }
    await db.exec('begin');
    try {
      await db.exec('set local role service_role');
      await assert.rejects(db.query(reviewSql.replace("array['NL']", "array['FR']"), [
        first.candidate_id, 'Reviewed Catnip Balls', 'Store description',
        'Ready for a Shopify draft.', reviewVariants, reviewer,
      ]), /review_shipping_evidence_missing/);
    } finally {
      await db.exec('rollback');
    }
    await db.exec('begin');
    try {
      await db.exec('set local role service_role');
      const approved = await db.query<{ candidate_status: string }>(reviewSql, [
        first.candidate_id, 'Reviewed Catnip Balls', 'Store description',
        'Ready for a Shopify draft.', reviewVariants, reviewer,
      ]);
      assert.equal(approved.rows[0]!.candidate_status, 'approved');
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
    const reviewState = await db.query<{
      status: string; title: string; events: number; variants: number;
    }>(`
      select candidate.status,review.title,
        (select count(*)::int from public.product_review_events where review_id = review.id) as events,
        (select count(*)::int from public.product_review_variants where review_id = review.id) as variants
      from public.product_candidates as candidate
      join public.product_reviews as review on review.candidate_id = candidate.id
      where candidate.id = $1::uuid
    `, [first.candidate_id]);
    assert.deepEqual(reviewState.rows, [{
      status: 'approved', title: 'Reviewed Catnip Balls', events: 1, variants: 1,
    }]);

    const beginListingSql = `select * from public.begin_shopify_draft_listing(
      $1::uuid,'example-store.myshopify.com',$2::uuid
    )`;
    await db.exec('begin');
    try {
      await db.exec('set local role authenticated');
      await assert.rejects(
        db.query(beginListingSql, [first.candidate_id, reviewer]),
        /permission denied/,
      );
    } finally {
      await db.exec('rollback');
    }
    const begun = await db.query<{
      listing_id: string; attempt_id: string; external_listing_id: string | null;
      external_handle: string; source_payload: { variants: unknown[] };
    }>(beginListingSql, [first.candidate_id, reviewer]);
    assert.equal(begun.rows[0]!.external_listing_id, null);
    assert.match(begun.rows[0]!.external_handle, /^ecommerce-[a-f0-9]+$/);
    assert.equal(begun.rows[0]!.source_payload.variants.length, 1);
    await assert.rejects(
      db.query(beginListingSql, [first.candidate_id, reviewer]),
      /listing_in_progress/,
    );

    const mapping = JSON.stringify([{
      product_variant_id: refreshedVariants[1]!.external_variant_id === '2506170616321605300'
        ? (await db.query<{ id: string }>(
            `select product_variant_id as id from public.supplier_variants where id = $1::uuid`,
            [quotedVariant.rows[0]!.id],
          )).rows[0]!.id
        : '',
      external_variant_id: 'gid://shopify/ProductVariant/9001',
    }]);
    await db.query(`select public.complete_shopify_draft_listing(
      $1::uuid,$2::uuid,'gid://shopify/Product/8001',$3::jsonb,$4::jsonb,$5::uuid
    )`, [
      begun.rows[0]!.listing_id, begun.rows[0]!.attempt_id, mapping,
      JSON.stringify({ product: { id: 'gid://shopify/Product/8001', status: 'DRAFT' } }),
      reviewer,
    ]);
    const listingState = await db.query<{
      status: string; external_listing_id: string; variants: number; attempts: number;
    }>(`
      select listing.status,listing.external_listing_id,
        (select count(*)::int from public.channel_listing_variants
          where channel_listing_id = listing.id) as variants,
        (select count(*)::int from private.channel_listing_attempts
          where channel_listing_id = listing.id and status = 'succeeded') as attempts
      from public.channel_listings as listing
      where listing.id = $1::uuid
    `, [begun.rows[0]!.listing_id]);
    assert.deepEqual(listingState.rows, [{
      status: 'draft', external_listing_id: 'gid://shopify/Product/8001', variants: 1, attempts: 1,
    }]);

    const retry = await db.query<{
      listing_id: string; attempt_id: string; external_listing_id: string | null;
      source_payload: { variants: Array<{ existingExternalVariantId: string | null }> };
    }>(beginListingSql, [first.candidate_id, reviewer]);
    assert.equal(retry.rows[0]!.listing_id, begun.rows[0]!.listing_id);
    assert.equal(retry.rows[0]!.external_listing_id, 'gid://shopify/Product/8001');
    assert.equal(
      retry.rows[0]!.source_payload.variants[0]!.existingExternalVariantId,
      'gid://shopify/ProductVariant/9001',
    );
    await db.query(`select public.fail_shopify_draft_listing(
      $1::uuid,$2::uuid,'shopify_unavailable',$3::jsonb,$4::uuid
    )`, [
      retry.rows[0]!.listing_id, retry.rows[0]!.attempt_id,
      JSON.stringify({ httpStatus: 503 }), reviewer,
    ]);
    const failedListing = await db.query<{ status: string; last_error_code: string }>(`
      select status,last_error_code from public.channel_listings where id = $1::uuid
    `, [retry.rows[0]!.listing_id]);
    assert.deepEqual(failedListing.rows, [{
      status: 'failed', last_error_code: 'shopify_unavailable',
    }]);

    await db.exec('begin');
    try {
      await db.exec('set local role service_role');
      await assert.rejects(
        db.exec(`update public.product_review_events set note = 'rewritten'`),
        /permission denied/,
      );
    } finally {
      await db.exec('rollback');
    }

    const duplicate = [initialVariants[0], initialVariants[0]];
    await assert.rejects(
      ingest(db, 'service_role', '2026-09-29T12:00:00Z', duplicate),
      /Duplicate external variant ID/,
    );
    const snapshotsAfterFailure = await db.query<{ count: number }>(
      'select count(*)::int as count from private.supplier_snapshots',
    );
    assert.equal(snapshotsAfterFailure.rows[0]!.count, 2);
  } finally {
    await db.close();
  }
});

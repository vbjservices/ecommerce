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
  const initialVariants = [
    {
      external_variant_id: '1561984433677414400',
      sku: 'CJMY154835401AZ',
      options: { Quantity: '1pcs' },
      cost: null,
      currency: null,
      stock: null,
    },
    {
      external_variant_id: '2506170616321605300',
      sku: 'CJMY154835404DW',
      options: { Quantity: '10pcs' },
      cost: '3.16',
      currency: 'USD',
      stock: 8337,
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
    }>('select external_variant_id,cost::text,currency,stock from public.supplier_variants order by external_variant_id');
    assert.deepEqual(variants.rows, [
      {
        external_variant_id: '1561984433677414400',
        cost: null,
        currency: null,
        stock: null,
      },
      {
        external_variant_id: '2506170616321605300',
        cost: '3.250000',
        currency: 'USD',
        stock: 8200,
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

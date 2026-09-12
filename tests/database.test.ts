import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('migrations enforce authorization and domain integrity in PostgreSQL', async (t) => {
  const db = new PGlite();
  const member = '00000000-0000-4000-8000-000000000001';
  const outsider = '00000000-0000-4000-8000-000000000002';
  // Minimal Supabase Auth harness. SQL/RLS runs in real PostgreSQL, not a query mock.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    insert into auth.users values ('${member}'), ('${outsider}');
  `);
  for (const file of (await readdir('supabase/migrations')).sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  }
  await db.exec(`insert into private.internal_users(user_id) values ('${member}');`);
  const insert = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0]!.id;
  const product = await insert("insert into public.products(title) values ('Test product') returning id");
  const secondProduct = await insert("insert into public.products(title) values ('Second product') returning id");
  const supplier = await insert("insert into public.suppliers(code,name) values ('test','Test supplier') returning id");
  const mapping = await insert(`insert into public.supplier_products(supplier_id,product_id,external_product_id,first_seen_at,last_seen_at) values ('${supplier}','${product}','external-1',now(),now()) returning id`);
  await db.exec(`insert into public.product_candidates(product_id,supplier_product_id) values ('${product}','${mapping}');`);
  const asRole = async (role: string, userId: string, sql: string) => {
    await db.exec('begin');
    try {
      await db.exec(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      return await db.query(sql);
    } finally { await db.exec('rollback'); }
  };
  try {
    await t.test('every application table has RLS', async () => {
      const result = await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r' and not c.relrowsecurity`);
      assert.deepEqual(result.rows, []);
    });
    await t.test('anonymous cannot read and an arbitrary authenticated account sees no rows', async () => {
      await assert.rejects(asRole('anon', '', 'select * from public.products'), /permission denied/);
      assert.deepEqual((await asRole('authenticated', outsider, 'select * from public.product_candidates')).rows, []);
      assert.deepEqual((await asRole('authenticated', '', 'select * from public.products')).rows, []);
    });
    await t.test('active members can read, but cannot mutate or self-enroll', async () => {
      assert.equal((await asRole('authenticated', member, 'select * from public.products')).rows.length, 2);
      for (const sql of [
        "insert into public.products(title) values ('Injected')",
        "update public.product_candidates set status='approved'",
        'delete from public.product_candidates',
        `insert into private.internal_users(user_id) values ('${outsider}')`,
        'select * from private.supplier_snapshots',
      ]) await assert.rejects(asRole('authenticated', member, sql), /permission denied/);
    });
    await t.test('revocation removes read access with the same JWT identity', async () => {
      await db.exec(`update private.internal_users set active=false where user_id='${member}'`);
      assert.deepEqual((await asRole('authenticated', member, 'select * from public.products')).rows, []);
      await db.exec(`update private.internal_users set active=true where user_id='${member}'`);
    });
    await t.test('trusted service role can write; raw observations are append-only for that role', async () => {
      assert.equal((await asRole('service_role', '', "insert into public.products(title) values ('Worker product') returning id")).rows.length, 1);
      await assert.rejects(asRole('service_role', '', 'delete from private.supplier_snapshots'), /permission denied/);
    });
    await t.test('duplicate source IDs and mismatched product relationships are rejected', async () => {
      await assert.rejects(db.exec(`insert into public.supplier_products(supplier_id,product_id,external_product_id,first_seen_at,last_seen_at) values ('${supplier}','${product}','external-1',now(),now())`), /unique constraint/);
      await assert.rejects(db.exec(`update public.product_candidates set product_id='${secondProduct}'`), /foreign key constraint/);
      await assert.rejects(db.exec("update public.product_candidates set status='approved'"), /check constraint/);
    });
    await t.test('unknown metrics remain null and variants cannot cross products', async () => {
      const variant = await insert(`insert into public.product_variants(product_id) values ('${product}') returning id`);
      const wrongVariant = await insert(`insert into public.product_variants(product_id) values ('${secondProduct}') returning id`);
      const values = (id: string, external: string) => `('${mapping}','${product}','${id}','${external}','test',now())`;
      const columns = '(supplier_product_id,product_id,product_variant_id,external_variant_id,source,retrieved_at)';
      await db.exec(`insert into public.supplier_variants${columns} values ${values(variant, 'variant-1')}`);
      const row = (await db.query('select stock,cost,currency from public.supplier_variants')).rows[0];
      assert.deepEqual(row, { stock: null, cost: null, currency: null });
      await assert.rejects(db.exec(`insert into public.supplier_variants${columns} values ${values(wrongVariant, 'variant-2')}`), /foreign key constraint/);
      await assert.rejects(db.exec('update public.supplier_variants set stock=-1'), /check constraint/);
    });
  } finally { await db.close(); }
});

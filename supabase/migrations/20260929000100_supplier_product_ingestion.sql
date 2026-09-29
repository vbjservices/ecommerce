-- One trusted, atomic write boundary for normalized supplier product snapshots.
-- The function is public only so PostgREST can route service-role RPC calls; browser roles cannot execute it.
create function public.ingest_supplier_product(
  p_supplier_code text,
  p_supplier_name text,
  p_external_product_id text,
  p_title text,
  p_description text,
  p_source_url text,
  p_retrieved_at timestamptz,
  p_source text,
  p_variants jsonb,
  p_raw_payload jsonb
) returns table (
  product_id uuid,
  supplier_product_id uuid,
  candidate_id uuid,
  created boolean,
  variant_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supplier_id uuid;
  v_product_id uuid;
  v_supplier_product_id uuid;
  v_candidate_id uuid;
  v_product_variant_id uuid;
  v_created boolean := false;
  v_variant record;
begin
  if p_supplier_code is null or btrim(p_supplier_code) = '' or length(p_supplier_code) > 100 or
     p_supplier_name is null or btrim(p_supplier_name) = '' or
     p_external_product_id is null or btrim(p_external_product_id) = '' or length(p_external_product_id) > 200 or
     p_title is null or btrim(p_title) = '' or
     p_retrieved_at is null or
     p_source is null or btrim(p_source) = '' then
    raise exception 'Invalid supplier ingestion metadata' using errcode = '22023';
  end if;
  if p_variants is null or jsonb_typeof(p_variants) <> 'array' or
     jsonb_array_length(p_variants) = 0 or jsonb_array_length(p_variants) > 5000 then
    raise exception 'Variants must be a non-empty JSON array' using errcode = '22023';
  end if;
  if p_raw_payload is null or jsonb_typeof(p_raw_payload) <> 'object' then
    raise exception 'Raw payload must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_variants) as item(
      external_variant_id text, sku text, options jsonb,
      cost numeric, currency text, stock integer
    )
    where item.external_variant_id is null or btrim(item.external_variant_id) = '' or
          length(item.external_variant_id) > 200 or
          item.options is null or jsonb_typeof(item.options) <> 'object' or
          item.cost < 0 or item.stock < 0 or
          ((item.cost is null) <> (item.currency is null)) or
          (item.currency is not null and item.currency !~ '^[A-Z]{3}$')
  ) then
    raise exception 'Invalid normalized variant' using errcode = '22023';
  end if;
  if (
    select count(*) <> count(distinct item.external_variant_id)
    from jsonb_to_recordset(p_variants) as item(external_variant_id text)
  ) then
    raise exception 'Duplicate external variant ID' using errcode = '22023';
  end if;

  insert into public.suppliers(code, name)
  values (btrim(p_supplier_code), btrim(p_supplier_name))
  on conflict (code) do update set name = excluded.name
  returning id into v_supplier_id;

  -- Serialize imports per supplier so concurrent first sightings cannot create duplicate internal products.
  perform 1 from public.suppliers where id = v_supplier_id for update;

  select mapping.product_id, mapping.id
  into v_product_id, v_supplier_product_id
  from public.supplier_products as mapping
  where mapping.supplier_id = v_supplier_id
    and mapping.external_product_id = btrim(p_external_product_id);

  if v_supplier_product_id is null then
    insert into public.products(title, description)
    values (btrim(p_title), p_description)
    returning id into v_product_id;

    insert into public.supplier_products(
      supplier_id, product_id, external_product_id, source_url,
      first_seen_at, last_seen_at
    ) values (
      v_supplier_id, v_product_id, btrim(p_external_product_id), p_source_url,
      p_retrieved_at, p_retrieved_at
    ) returning id into v_supplier_product_id;
    v_created := true;
  else
    update public.products
    set title = btrim(p_title), description = p_description
    where id = v_product_id;

    update public.supplier_products
    set source_url = p_source_url,
        last_seen_at = greatest(last_seen_at, p_retrieved_at)
    where id = v_supplier_product_id;
  end if;

  for v_variant in
    select *
    from jsonb_to_recordset(p_variants) as item(
      external_variant_id text, sku text, options jsonb,
      cost numeric, currency text, stock integer
    )
  loop
    v_product_variant_id := null;
    select mapping.product_variant_id
    into v_product_variant_id
    from public.supplier_variants as mapping
    where mapping.supplier_product_id = v_supplier_product_id
      and mapping.external_variant_id = btrim(v_variant.external_variant_id);

    if v_product_variant_id is null then
      insert into public.product_variants(product_id, sku, options)
      values (
        v_product_id,
        nullif(btrim(v_variant.sku), ''),
        v_variant.options
      ) returning id into v_product_variant_id;

      insert into public.supplier_variants(
        supplier_product_id, product_id, product_variant_id,
        external_variant_id, cost, currency, stock, source, retrieved_at
      ) values (
        v_supplier_product_id, v_product_id, v_product_variant_id,
        btrim(v_variant.external_variant_id), v_variant.cost, v_variant.currency,
        v_variant.stock, btrim(p_source), p_retrieved_at
      );
    else
      update public.product_variants
      set sku = nullif(btrim(v_variant.sku), ''), options = v_variant.options
      where id = v_product_variant_id;

      update public.supplier_variants as target
      set cost = v_variant.cost,
          currency = v_variant.currency,
          stock = v_variant.stock,
          source = btrim(p_source),
          retrieved_at = p_retrieved_at
      where target.supplier_product_id = v_supplier_product_id
        and target.external_variant_id = btrim(v_variant.external_variant_id);
    end if;
  end loop;

  insert into public.product_candidates(product_id, supplier_product_id)
  values (v_product_id, v_supplier_product_id)
  on conflict on constraint product_candidates_supplier_product_id_key do nothing
  returning id into v_candidate_id;

  if v_candidate_id is null then
    select candidate.id into v_candidate_id
    from public.product_candidates as candidate
    where candidate.supplier_product_id = v_supplier_product_id;
  end if;

  insert into private.supplier_snapshots(
    supplier_product_id, source, retrieved_at, raw_payload
  ) values (
    v_supplier_product_id, btrim(p_source), p_retrieved_at, p_raw_payload
  );

  return query select
    v_product_id,
    v_supplier_product_id,
    v_candidate_id,
    v_created,
    jsonb_array_length(p_variants);
end;
$$;

revoke all on function public.ingest_supplier_product(
  text, text, text, text, text, text, timestamptz, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_supplier_product(
  text, text, text, text, text, text, timestamptz, text, jsonb, jsonb
) to service_role;

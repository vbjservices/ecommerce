-- Retain supplier-provided variant media for accurate color/style review.
alter table public.supplier_variants
  add column if not exists image_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_variants'::regclass
      and conname = 'supplier_variants_image_url_check'
  ) then
    alter table public.supplier_variants
      add constraint supplier_variants_image_url_check
      check (image_url is null or (length(image_url) <= 2048 and image_url ~ '^https://'));
  end if;
end;
$$;

create or replace function private.apply_supplier_variant_images(
  p_supplier_product_id uuid,
  p_raw_payload jsonb
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_variants jsonb := p_raw_payload #> '{variants,data}';
  v_updated integer := 0;
begin
  if p_supplier_product_id is null or jsonb_typeof(v_variants) <> 'array' then
    return 0;
  end if;

  with provider_images as (
    select
      btrim(item->>'vid') as external_variant_id,
      btrim(item->>'variantImage') as image_url
    from jsonb_array_elements(v_variants) as item
    where jsonb_typeof(item) = 'object'
      and btrim(coalesce(item->>'vid', '')) <> ''
      and length(btrim(coalesce(item->>'variantImage', ''))) <= 2048
      and btrim(coalesce(item->>'variantImage', '')) ~ '^https://'
  ), updated as (
    update public.supplier_variants as variant
    set image_url = provider_image.image_url
    from provider_images as provider_image
    where variant.supplier_product_id = p_supplier_product_id
      and variant.external_variant_id = provider_image.external_variant_id
      and variant.image_url is distinct from provider_image.image_url
    returning 1
  )
  select count(*)::integer into v_updated from updated;
  return v_updated;
end;
$$;

create or replace function private.sync_supplier_variant_images()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.apply_supplier_variant_images(new.supplier_product_id, new.raw_payload);
  return new;
end;
$$;

drop trigger if exists sync_supplier_variant_images on private.supplier_snapshots;
create trigger sync_supplier_variant_images
after insert on private.supplier_snapshots
for each row execute function private.sync_supplier_variant_images();

-- Populate existing imports from their latest retained CJ snapshot.
do $$
declare
  v_snapshot record;
begin
  for v_snapshot in
    select distinct on (snapshot.supplier_product_id)
      snapshot.supplier_product_id, snapshot.raw_payload
    from private.supplier_snapshots as snapshot
    order by snapshot.supplier_product_id, snapshot.retrieved_at desc, snapshot.created_at desc
  loop
    perform private.apply_supplier_variant_images(
      v_snapshot.supplier_product_id,
      v_snapshot.raw_payload
    );
  end loop;
end;
$$;

revoke all on function private.apply_supplier_variant_images(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function private.sync_supplier_variant_images()
  from public, anon, authenticated;

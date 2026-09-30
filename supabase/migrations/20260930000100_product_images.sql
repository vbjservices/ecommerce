-- Keep a browser-safe primary image with the normalized product record.
-- Raw supplier payloads remain private and are never queried by the dashboard.
alter table public.products add column image_url text;

create function public.ingest_supplier_product(
  p_supplier_code text,
  p_supplier_name text,
  p_external_product_id text,
  p_title text,
  p_description text,
  p_image_url text,
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
  v_result record;
begin
  if p_image_url is not null and (
    length(p_image_url) > 2048 or p_image_url !~ '^https://'
  ) then
    raise exception 'Invalid product image URL' using errcode = '22023';
  end if;

  select * into strict v_result
  from public.ingest_supplier_product(
    p_supplier_code,
    p_supplier_name,
    p_external_product_id,
    p_title,
    p_description,
    p_source_url,
    p_retrieved_at,
    p_source,
    p_variants,
    p_raw_payload
  );

  update public.products
  set image_url = coalesce(p_image_url, image_url)
  where id = v_result.product_id;

  return query select
    v_result.product_id::uuid,
    v_result.supplier_product_id::uuid,
    v_result.candidate_id::uuid,
    v_result.created::boolean,
    v_result.variant_count::integer;
end;
$$;

revoke all on function public.ingest_supplier_product(
  text, text, text, text, text, text, text, timestamptz, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_supplier_product(
  text, text, text, text, text, text, text, timestamptz, text, jsonb, jsonb
) to service_role;

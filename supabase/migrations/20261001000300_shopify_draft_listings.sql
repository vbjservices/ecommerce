-- Durable sales-channel intent and explicit product/variant mappings.
-- Provider credentials remain Edge Function secrets and are never stored here.
alter table public.sales_channels
  add column if not exists external_account_id text;

create unique index if not exists sales_channels_provider_account_idx
  on public.sales_channels(provider, external_account_id);

create table if not exists public.channel_listings (
  id uuid primary key default gen_random_uuid(),
  sales_channel_id uuid not null references public.sales_channels(id),
  product_id uuid not null references public.products(id),
  candidate_id uuid not null references public.product_candidates(id),
  external_listing_id text,
  external_handle text not null check (btrim(external_handle) <> ''),
  status text not null default 'pending'
    check (status in ('pending', 'syncing', 'draft', 'failed', 'active', 'archived', 'unknown')),
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  source_review_updated_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  last_attempted_at timestamptz,
  synced_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sales_channel_id, product_id),
  unique (sales_channel_id, idempotency_key),
  unique (sales_channel_id, external_listing_id),
  unique (id, product_id)
);

create table if not exists public.channel_listing_variants (
  id uuid primary key default gen_random_uuid(),
  channel_listing_id uuid not null references public.channel_listings(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_variant_id uuid not null,
  external_variant_id text not null check (btrim(external_variant_id) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (channel_listing_id, product_id)
    references public.channel_listings(id, product_id) on delete cascade,
  foreign key (product_variant_id, product_id)
    references public.product_variants(id, product_id),
  unique (channel_listing_id, product_variant_id),
  unique (channel_listing_id, external_variant_id)
);

create table if not exists private.channel_listing_attempts (
  id uuid primary key default gen_random_uuid(),
  channel_listing_id uuid not null references public.channel_listings(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  status text not null check (status in ('started', 'succeeded', 'failed')),
  request_snapshot jsonb not null check (jsonb_typeof(request_snapshot) = 'object'),
  response_snapshot jsonb check (response_snapshot is null or jsonb_typeof(response_snapshot) = 'object'),
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists channel_listings_candidate_idx
  on public.channel_listings(candidate_id, created_at desc);
create index if not exists channel_listing_variants_listing_idx
  on public.channel_listing_variants(channel_listing_id);
create index if not exists channel_listing_attempts_listing_idx
  on private.channel_listing_attempts(channel_listing_id, started_at desc);

alter table public.channel_listings enable row level security;
alter table public.channel_listing_variants enable row level security;
alter table private.channel_listing_attempts enable row level security;

revoke all on public.channel_listings from public, anon, authenticated;
revoke all on public.channel_listing_variants from public, anon, authenticated;
revoke all on private.channel_listing_attempts from public, anon, authenticated;
grant select on public.channel_listings, public.channel_listing_variants to authenticated;
grant all on public.channel_listings, public.channel_listing_variants to service_role;
grant all on private.channel_listing_attempts to service_role;

drop policy if exists internal_read on public.channel_listings;
create policy internal_read on public.channel_listings
  for select to authenticated using ((select public.is_internal_user()));
drop policy if exists internal_read on public.channel_listing_variants;
create policy internal_read on public.channel_listing_variants
  for select to authenticated using ((select public.is_internal_user()));

drop trigger if exists set_updated_at on public.channel_listings;
create trigger set_updated_at before update on public.channel_listings
for each row execute function private.set_updated_at();
drop trigger if exists set_updated_at on public.channel_listing_variants;
create trigger set_updated_at before update on public.channel_listing_variants
for each row execute function private.set_updated_at();

create or replace function public.begin_shopify_draft_listing(
  p_candidate_id uuid,
  p_store_domain text,
  p_actor_id uuid
) returns table(
  listing_id uuid,
  attempt_id uuid,
  external_listing_id text,
  external_handle text,
  source_payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.product_candidates%rowtype;
  v_review public.product_reviews%rowtype;
  v_channel_id uuid;
  v_listing public.channel_listings%rowtype;
  v_attempt_id uuid;
  v_variants jsonb;
  v_images jsonb;
  v_payload jsonb;
  v_domain text;
begin
  v_domain := lower(btrim(coalesce(p_store_domain, '')));
  if p_candidate_id is null or p_actor_id is null or
     v_domain !~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$' then
    raise exception 'listing_validation_failed' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.internal_users
    where user_id = p_actor_id and active
  ) then
    raise exception 'listing_actor_forbidden' using errcode = '42501';
  end if;

  select * into v_candidate
  from public.product_candidates
  where id = p_candidate_id
  for update;
  if not found then
    raise exception 'listing_candidate_not_found' using errcode = '22023';
  end if;
  if v_candidate.status <> 'approved' then
    raise exception 'listing_candidate_not_approved' using errcode = '22023';
  end if;

  select * into v_review
  from public.product_reviews
  where candidate_id = p_candidate_id;
  if not found then
    raise exception 'listing_review_missing' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'supplierVariantId', supplier_variant.id,
    'internalProductVariantId', product_variant.id,
    'supplierExternalVariantId', supplier_variant.external_variant_id,
    'sku', product_variant.sku,
    'options', product_variant.options,
    'retailPrice', review_variant.retail_price
  ) order by supplier_variant.external_variant_id), '[]'::jsonb)
  into v_variants
  from public.product_review_variants as review_variant
  join public.supplier_variants as supplier_variant
    on supplier_variant.id = review_variant.supplier_variant_id
  join public.product_variants as product_variant
    on product_variant.id = supplier_variant.product_variant_id
  where review_variant.review_id = v_review.id
    and review_variant.selected
    and supplier_variant.product_id = v_candidate.product_id;

  if jsonb_array_length(v_variants) = 0 or jsonb_array_length(v_variants) > 200 or
     exists (
       select 1
       from jsonb_array_elements(v_variants) as variant
       where variant->>'retailPrice' is null
     ) then
    raise exception 'listing_review_incomplete' using errcode = '22023';
  end if;

  select coalesce(to_jsonb(product.image_urls), '[]'::jsonb)
  into v_images
  from public.products as product
  where product.id = v_candidate.product_id;

  v_payload := jsonb_build_object(
    'candidateId', v_candidate.id,
    'productId', v_candidate.product_id,
    'reviewId', v_review.id,
    'reviewUpdatedAt', v_review.updated_at,
    'title', v_review.title,
    'description', v_review.description,
    'retailCurrency', v_review.retail_currency,
    'targetMarketCodes', to_jsonb(v_review.target_market_codes),
    'imageUrls', v_images,
    'variants', v_variants
  );

  insert into public.sales_channels(provider, name, external_account_id)
  values ('shopify', 'Shopify - ' || v_domain, v_domain)
  on conflict (provider, external_account_id) do update set
    name = excluded.name,
    updated_at = now()
  returning id into v_channel_id;

  select * into v_listing
  from public.channel_listings
  where sales_channel_id = v_channel_id
    and product_id = v_candidate.product_id
  for update;

  if found and v_listing.status = 'syncing' and
     v_listing.last_attempted_at > now() - interval '2 minutes' then
    raise exception 'listing_in_progress' using errcode = '55000';
  end if;

  if not found then
    insert into public.channel_listings(
      sales_channel_id, product_id, candidate_id, external_handle, status,
      idempotency_key, source_review_updated_at, attempt_count,
      last_attempted_at, created_by, updated_by
    ) values (
      v_channel_id, v_candidate.product_id, v_candidate.id,
      'ecommerce-' || replace(v_candidate.id::text, '-', ''), 'syncing',
      'shopify:' || v_channel_id::text || ':product:' || v_candidate.product_id::text,
      v_review.updated_at, 1, now(), p_actor_id, p_actor_id
    ) returning * into v_listing;
  else
    update public.channel_listings set
      candidate_id = v_candidate.id,
      status = 'syncing',
      source_review_updated_at = v_review.updated_at,
      attempt_count = attempt_count + 1,
      last_error_code = null,
      last_attempted_at = now(),
      updated_by = p_actor_id
    where id = v_listing.id
    returning * into v_listing;
  end if;

  -- Once mappings exist, pass Shopify variant IDs back to productSet so updates
  -- preserve variant identity instead of replacing variants on every review sync.
  select coalesce(jsonb_agg(jsonb_build_object(
    'supplierVariantId', supplier_variant.id,
    'internalProductVariantId', product_variant.id,
    'supplierExternalVariantId', supplier_variant.external_variant_id,
    'existingExternalVariantId', listing_variant.external_variant_id,
    'sku', product_variant.sku,
    'options', product_variant.options,
    'retailPrice', review_variant.retail_price
  ) order by supplier_variant.external_variant_id), '[]'::jsonb)
  into v_variants
  from public.product_review_variants as review_variant
  join public.supplier_variants as supplier_variant
    on supplier_variant.id = review_variant.supplier_variant_id
  join public.product_variants as product_variant
    on product_variant.id = supplier_variant.product_variant_id
  left join public.channel_listing_variants as listing_variant
    on listing_variant.channel_listing_id = v_listing.id
   and listing_variant.product_variant_id = product_variant.id
  where review_variant.review_id = v_review.id
    and review_variant.selected
    and supplier_variant.product_id = v_candidate.product_id;
  v_payload := jsonb_set(v_payload, '{variants}', v_variants);

  insert into private.channel_listing_attempts(
    channel_listing_id, actor_id, status, request_snapshot
  ) values (
    v_listing.id, p_actor_id, 'started', v_payload
  ) returning id into v_attempt_id;

  return query select
    v_listing.id, v_attempt_id, v_listing.external_listing_id,
    v_listing.external_handle, v_payload;
end;
$$;

create or replace function public.complete_shopify_draft_listing(
  p_listing_id uuid,
  p_attempt_id uuid,
  p_external_listing_id text,
  p_variant_mappings jsonb,
  p_response_snapshot jsonb,
  p_actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.channel_listings%rowtype;
  v_attempt private.channel_listing_attempts%rowtype;
begin
  if p_listing_id is null or p_attempt_id is null or p_actor_id is null or
     p_external_listing_id !~ '^gid://shopify/Product/[0-9]+$' or
     p_variant_mappings is null or jsonb_typeof(p_variant_mappings) <> 'array' or
     p_response_snapshot is null or jsonb_typeof(p_response_snapshot) <> 'object' then
    raise exception 'listing_completion_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.internal_users
    where user_id = p_actor_id and active
  ) then
    raise exception 'listing_actor_forbidden' using errcode = '42501';
  end if;

  select * into v_listing from public.channel_listings
  where id = p_listing_id for update;
  select * into v_attempt from private.channel_listing_attempts
  where id = p_attempt_id and channel_listing_id = p_listing_id for update;
  if v_listing.id is null or v_attempt.id is null or v_attempt.status <> 'started' then
    raise exception 'listing_attempt_not_found' using errcode = '22023';
  end if;

  if jsonb_array_length(p_variant_mappings) < 1 or
     jsonb_array_length(p_variant_mappings) <>
       jsonb_array_length(v_attempt.request_snapshot->'variants') or
     exists (
       select 1
       from jsonb_to_recordset(p_variant_mappings) as mapping(
         product_variant_id uuid, external_variant_id text
       )
       where mapping.product_variant_id is null or
             mapping.external_variant_id !~ '^gid://shopify/ProductVariant/[0-9]+$' or
             not exists (
               select 1
               from jsonb_array_elements(v_attempt.request_snapshot->'variants') as source
               where (source->>'internalProductVariantId')::uuid = mapping.product_variant_id
             )
     ) or (
       select count(*) <> count(distinct mapping.product_variant_id) or
              count(*) <> count(distinct mapping.external_variant_id)
       from jsonb_to_recordset(p_variant_mappings) as mapping(
         product_variant_id uuid, external_variant_id text
       )
     ) then
    raise exception 'listing_variant_mapping_invalid' using errcode = '22023';
  end if;

  delete from public.channel_listing_variants
  where channel_listing_id = p_listing_id;
  insert into public.channel_listing_variants(
    channel_listing_id, product_id, product_variant_id, external_variant_id
  )
  select p_listing_id, v_listing.product_id,
    mapping.product_variant_id, mapping.external_variant_id
  from jsonb_to_recordset(p_variant_mappings) as mapping(
    product_variant_id uuid, external_variant_id text
  );

  update public.channel_listings set
    external_listing_id = p_external_listing_id,
    status = 'draft',
    last_error_code = null,
    synced_at = now(),
    updated_by = p_actor_id
  where id = p_listing_id;
  update private.channel_listing_attempts set
    status = 'succeeded',
    response_snapshot = p_response_snapshot,
    completed_at = now()
  where id = p_attempt_id;
  return p_listing_id;
end;
$$;

create or replace function public.fail_shopify_draft_listing(
  p_listing_id uuid,
  p_attempt_id uuid,
  p_error_code text,
  p_response_snapshot jsonb,
  p_actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_listing_id is null or p_attempt_id is null or p_actor_id is null or
     p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,80}$' or
     (p_response_snapshot is not null and jsonb_typeof(p_response_snapshot) <> 'object') then
    raise exception 'listing_failure_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.internal_users
    where user_id = p_actor_id and active
  ) then
    raise exception 'listing_actor_forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from private.channel_listing_attempts
    where id = p_attempt_id and channel_listing_id = p_listing_id and status = 'started'
  ) then
    raise exception 'listing_attempt_not_found' using errcode = '22023';
  end if;

  update public.channel_listings set
    status = 'failed',
    last_error_code = p_error_code,
    updated_by = p_actor_id
  where id = p_listing_id;
  update private.channel_listing_attempts set
    status = 'failed',
    response_snapshot = p_response_snapshot,
    error_code = p_error_code,
    completed_at = now()
  where id = p_attempt_id;
  return p_listing_id;
end;
$$;

revoke all on function public.begin_shopify_draft_listing(uuid,text,uuid)
  from public, anon, authenticated;
revoke all on function public.complete_shopify_draft_listing(uuid,uuid,text,jsonb,jsonb,uuid)
  from public, anon, authenticated;
revoke all on function public.fail_shopify_draft_listing(uuid,uuid,text,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.begin_shopify_draft_listing(uuid,text,uuid) to service_role;
grant execute on function public.complete_shopify_draft_listing(uuid,uuid,text,jsonb,jsonb,uuid)
  to service_role;
grant execute on function public.fail_shopify_draft_listing(uuid,uuid,text,jsonb,uuid)
  to service_role;

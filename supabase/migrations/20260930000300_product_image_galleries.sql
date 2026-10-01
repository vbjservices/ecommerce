-- Retain normalized supplier image galleries for imported and discovered products.
-- Raw provider payloads stay private; browser roles only read validated HTTPS URLs.
create or replace function private.normalize_image_urls(p_urls text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(candidate.url order by candidate.first_ordinal), '{}'::text[])
  from (
    select cleaned.url, min(cleaned.ordinality) as first_ordinal
    from (
      select btrim(item.url) as url, item.ordinality
      from unnest(coalesce(p_urls, '{}'::text[])) with ordinality as item(url, ordinality)
    ) as cleaned
    where cleaned.url <> '' and length(cleaned.url) <= 2048 and cleaned.url ~ '^https://'
    group by cleaned.url
    order by min(cleaned.ordinality)
    limit 50
  ) as candidate
$$;

create or replace function private.image_urls_are_safe(p_urls text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(coalesce(p_urls, '{}'::text[])) <= 50 and not exists (
    select 1
    from unnest(coalesce(p_urls, '{}'::text[])) as item(url)
    where item.url <> btrim(item.url) or item.url = '' or
          length(item.url) > 2048 or item.url !~ '^https://'
  )
$$;

alter table public.products
  add column if not exists image_urls text[] not null default '{}';

alter table public.discovery_candidates
  add column if not exists image_urls text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_image_urls_safe'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_image_urls_safe
      check (private.image_urls_are_safe(image_urls));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'discovery_candidates_image_urls_safe'
      and conrelid = 'public.discovery_candidates'::regclass
  ) then
    alter table public.discovery_candidates
      add constraint discovery_candidates_image_urls_safe
      check (private.image_urls_are_safe(image_urls));
  end if;
end;
$$;

create or replace function private.keep_primary_image_in_gallery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.image_url is not null then
    new.image_urls := private.normalize_image_urls(array[new.image_url] || new.image_urls);
  else
    new.image_urls := private.normalize_image_urls(new.image_urls);
  end if;
  return new;
end;
$$;

drop trigger if exists keep_primary_product_image on public.products;
create trigger keep_primary_product_image
before insert or update of image_url, image_urls on public.products
for each row execute function private.keep_primary_image_in_gallery();

drop trigger if exists keep_primary_discovery_image on public.discovery_candidates;
create trigger keep_primary_discovery_image
before insert or update of image_url, image_urls on public.discovery_candidates
for each row execute function private.keep_primary_image_in_gallery();

update public.products
set image_urls = array[image_url]
where image_url is not null;

update public.discovery_candidates
set image_urls = array[image_url]
where image_url is not null;

create or replace function private.apply_supplier_snapshot_images(
  p_supplier_product_id uuid,
  p_raw_payload jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gallery jsonb;
  v_gallery_urls text[] := '{}'::text[];
  v_images text[];
begin
  v_gallery := p_raw_payload #> '{product,data,productImageSet}';
  if jsonb_typeof(v_gallery) = 'array' then
    select coalesce(array_agg(item.value order by item.ordinality), '{}'::text[])
    into v_gallery_urls
    from jsonb_array_elements_text(v_gallery) with ordinality as item(value, ordinality);
  end if;
  v_images := private.normalize_image_urls(
    array[p_raw_payload #>> '{product,data,bigImage}'] || v_gallery_urls
  );
  if cardinality(v_images) = 0 then return; end if;
  update public.products as product
  set image_url = coalesce(product.image_url, v_images[1]),
      image_urls = v_images
  from public.supplier_products as supplier_product
  where supplier_product.id = p_supplier_product_id
    and product.id = supplier_product.product_id;
end;
$$;

create or replace function private.sync_supplier_snapshot_images()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.apply_supplier_snapshot_images(new.supplier_product_id, new.raw_payload);
  return new;
end;
$$;

drop trigger if exists sync_supplier_snapshot_images on private.supplier_snapshots;
create trigger sync_supplier_snapshot_images
after insert on private.supplier_snapshots
for each row execute function private.sync_supplier_snapshot_images();

do $$
declare v_snapshot record;
begin
  for v_snapshot in
    select distinct on (snapshot.supplier_product_id)
      snapshot.supplier_product_id, snapshot.raw_payload
    from private.supplier_snapshots as snapshot
    order by snapshot.supplier_product_id, snapshot.retrieved_at desc
  loop
    perform private.apply_supplier_snapshot_images(
      v_snapshot.supplier_product_id,
      v_snapshot.raw_payload
    );
  end loop;
end;
$$;

create or replace function private.apply_discovery_observation_images(
  p_candidate_id uuid,
  p_snapshot jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gallery jsonb;
  v_gallery_urls text[] := '{}'::text[];
  v_images text[];
begin
  v_gallery := p_snapshot->'imageUrls';
  if jsonb_typeof(v_gallery) = 'array' then
    select coalesce(array_agg(item.value order by item.ordinality), '{}'::text[])
    into v_gallery_urls
    from jsonb_array_elements_text(v_gallery) with ordinality as item(value, ordinality);
  end if;
  v_images := private.normalize_image_urls(
    array[p_snapshot->>'imageUrl'] || v_gallery_urls
  );
  if cardinality(v_images) = 0 then return; end if;
  update public.discovery_candidates
  set image_url = coalesce(image_url, v_images[1]),
      image_urls = v_images
  where id = p_candidate_id;
end;
$$;

create or replace function private.sync_discovery_observation_images()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.apply_discovery_observation_images(new.candidate_id, new.normalized_snapshot);
  return new;
end;
$$;

drop trigger if exists sync_discovery_observation_images on public.supplier_product_observations;
create trigger sync_discovery_observation_images
after insert on public.supplier_product_observations
for each row execute function private.sync_discovery_observation_images();

do $$
declare v_observation record;
begin
  for v_observation in
    select distinct on (observation.candidate_id)
      observation.candidate_id, observation.normalized_snapshot
    from public.supplier_product_observations as observation
    order by observation.candidate_id, observation.observed_at desc
  loop
    perform private.apply_discovery_observation_images(
      v_observation.candidate_id,
      v_observation.normalized_snapshot
    );
  end loop;
end;
$$;

revoke all on function private.normalize_image_urls(text[]) from public, anon, authenticated;
revoke all on function private.image_urls_are_safe(text[]) from public, anon, authenticated;
grant execute on function private.image_urls_are_safe(text[]) to service_role;
revoke all on function private.keep_primary_image_in_gallery() from public, anon, authenticated;
revoke all on function private.apply_supplier_snapshot_images(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.sync_supplier_snapshot_images() from public, anon, authenticated;
revoke all on function private.apply_discovery_observation_images(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.sync_discovery_observation_images() from public, anon, authenticated;

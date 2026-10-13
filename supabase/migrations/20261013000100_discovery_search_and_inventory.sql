-- Faceted discovery search plus timestamped pre-import inventory checks.
create table public.discovery_inventory_checks (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  candidate_id uuid not null references public.discovery_candidates(id) on delete cascade,
  external_variant_id text not null check (btrim(external_variant_id) <> ''),
  variant_name text,
  total_inventory integer check (total_inventory >= 0),
  warehouses jsonb not null default '[]' check (jsonb_typeof(warehouses) = 'array'),
  checked_at timestamptz not null,
  source text not null check (btrim(source) <> ''),
  created_at timestamptz not null default now()
);

create index discovery_inventory_checks_latest_idx
  on public.discovery_inventory_checks(candidate_id, checked_at desc);

alter table public.discovery_inventory_checks enable row level security;
revoke all on public.discovery_inventory_checks from public, anon, authenticated;
grant select on public.discovery_inventory_checks to authenticated;
grant select, insert on public.discovery_inventory_checks to service_role;
create policy internal_read on public.discovery_inventory_checks
  for select to authenticated using ((select public.is_internal_user()));

-- Add stable, browser-safe facets to the existing catalog. These are deliberately
-- derived from normalized discovery data; supplier HTML/raw payloads remain private.
create or replace view public.discovery_catalog
with (security_invoker = true)
as
with latest_candidates as (
  select distinct on (candidate.supplier_id, candidate.external_product_id)
    candidate.*
  from public.discovery_candidates candidate
  order by candidate.supplier_id, candidate.external_product_id,
    candidate.created_at desc, candidate.rank asc
), sighting_totals as (
  select
    candidate.supplier_id,
    candidate.external_product_id,
    min(candidate.created_at) as first_seen_at,
    max(candidate.created_at) as last_seen_at,
    count(*)::integer as seen_count,
    array_agg(distinct run.category_key order by run.category_key) as category_keys
  from public.discovery_candidates candidate
  join public.discovery_runs run on run.id = candidate.run_id
  group by candidate.supplier_id, candidate.external_product_id
), catalog as (
  select
    candidate.id,
    candidate.run_id,
    candidate.supplier_id,
    candidate.external_product_id,
    candidate.rank,
    candidate.title,
    candidate.image_url,
    candidate.image_urls,
    candidate.source_url,
    candidate.eligibility_status,
    candidate.relevance_level,
    candidate.score,
    candidate.confidence,
    candidate.coverage,
    candidate.assessment,
    candidate.created_at,
    supplier.name as supplier_name,
    run.original_query,
    run.profile_id,
    run.category_key,
    sightings.category_keys,
    run.completed_at,
    sightings.first_seen_at,
    sightings.last_seen_at,
    sightings.seen_count,
    coalesce(occurrences.strategies, array[]::text[]) as strategies,
    observation.supplier_cost_min,
    observation.supplier_cost_max,
    observation.currency,
    observation.listing_count,
    observation.inventory,
    observation.verified_inventory,
    observation.delivery_days_min,
    observation.delivery_days_max,
    lower(concat_ws(' ', candidate.title, run.original_query, run.profile_id,
      run.category_key, array_to_string(sightings.category_keys, ' '))) as facet_text
  from latest_candidates candidate
  join public.suppliers supplier on supplier.id = candidate.supplier_id
  join public.discovery_runs run on run.id = candidate.run_id
  join sighting_totals sightings
    on sightings.supplier_id = candidate.supplier_id
   and sightings.external_product_id = candidate.external_product_id
  left join lateral (
    select array_agg(distinct occurrence.strategy order by occurrence.strategy) as strategies
    from public.discovery_occurrences occurrence
    where occurrence.candidate_id = candidate.id
  ) occurrences on true
  left join lateral (
    select item.supplier_cost_min, item.supplier_cost_max, item.currency,
      item.listing_count, item.inventory, item.verified_inventory,
      item.delivery_days_min, item.delivery_days_max
    from public.supplier_product_observations item
    where item.candidate_id = candidate.id
    order by item.observed_at desc
    limit 1
  ) observation on true
  where not exists (
    select 1 from public.supplier_products imported
    where imported.supplier_id = candidate.supplier_id
      and imported.external_product_id = candidate.external_product_id
  )
)
select
  catalog.id, catalog.run_id, catalog.supplier_id, catalog.external_product_id,
  catalog.rank, catalog.title, catalog.image_url, catalog.image_urls,
  catalog.source_url, catalog.eligibility_status, catalog.relevance_level,
  catalog.score, catalog.confidence, catalog.coverage, catalog.assessment,
  catalog.created_at, catalog.supplier_name, catalog.original_query,
  catalog.profile_id, catalog.category_key, catalog.category_keys,
  catalog.completed_at, catalog.first_seen_at, catalog.last_seen_at,
  catalog.seen_count, catalog.strategies, catalog.supplier_cost_min,
  catalog.supplier_cost_max, catalog.currency, catalog.listing_count,
  catalog.inventory, catalog.verified_inventory, catalog.delivery_days_min,
  catalog.delivery_days_max,
  case
    when catalog.facet_text ~ '(pet|pets|cat|dog|puppy|kitten)' then 'pets'
    when catalog.facet_text ~ '(home|kitchen|household|storage)' then 'home-kitchen'
    when catalog.facet_text ~ '(beauty|skin|hair|makeup|cosmetic)' then 'beauty'
    when catalog.facet_text ~ '(baby|babies|kids|child|children)' then 'baby-kids'
    when catalog.facet_text ~ '(fitness|sport|gym|workout|yoga)' then 'fitness-sports'
    when catalog.facet_text ~ '(electronic|gadget|phone|computer|usb)' then 'electronics'
    when catalog.facet_text ~ '(fashion|jewelry|jewellery|clothing|apparel)' then 'fashion'
    when catalog.facet_text ~ '(garden|gardening|patio)' then 'garden'
    when catalog.facet_text ~ '(car|automotive|vehicle)' then 'automotive'
    when catalog.facet_text ~ '(office|desk|stationery)' then 'office'
    else 'other'
  end as niche_key,
  array_remove(array[
    case when catalog.facet_text ~ '(outdoor|outside|travel|portable|camping|hiking|walking|patio)' then 'outdoor' end,
    case when catalog.facet_text ~ '(indoor|inside|home|house|bed|feeder|feeding|groom|toy)' then 'indoor' end
  ], null)::text[] as use_case_keys
from catalog;

revoke all on public.discovery_catalog from public, anon;
grant select on public.discovery_catalog to authenticated, service_role;

comment on table public.discovery_inventory_checks is
  'Timestamped, normalized CJ variant and warehouse inventory checks made before import.';

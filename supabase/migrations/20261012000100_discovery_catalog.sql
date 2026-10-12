-- A stable, browser-safe catalog over immutable discovery evidence.
-- Keep every run for provenance while presenting one latest row per supplier product.
alter table public.discovery_runs
  add column if not exists category_key text default 'generic';

update public.discovery_runs
set category_key = profile_id
where category_key is null;

alter table public.discovery_runs
  alter column category_key set default 'generic',
  alter column category_key set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'discovery_runs_category_key_check'
      and conrelid = 'public.discovery_runs'::regclass
  ) then
    alter table public.discovery_runs
      add constraint discovery_runs_category_key_check
      check (category_key ~ '^[a-z0-9][a-z0-9-]{0,99}$');
  end if;
end;
$$;

create index if not exists discovery_runs_category_idx
  on public.discovery_runs(category_key, completed_at desc);

-- Preserve the original transaction and add the category label after it returns.
-- The conditional rename makes SQL Editor retries harmless.
do $$
begin
  if to_regprocedure('public.persist_discovery_run_v1(text,text,jsonb)') is null then
    alter function public.persist_discovery_run(text, text, jsonb)
      rename to persist_discovery_run_v1;
  end if;
end;
$$;

drop function if exists public.persist_discovery_run(text, text, jsonb);
create function public.persist_discovery_run(
  p_supplier_code text,
  p_supplier_name text,
  p_run jsonb
) returns table (
  run_id uuid,
  candidate_count integer,
  observation_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved record;
  v_category_key text;
begin
  v_category_key := coalesce(nullif(p_run->>'category_key', ''), p_run->>'profile_id');
  if v_category_key is null or v_category_key !~ '^[a-z0-9][a-z0-9-]{0,99}$' then
    raise exception 'Invalid discovery category key' using errcode = '22023';
  end if;
  select * into strict v_saved
  from public.persist_discovery_run_v1(p_supplier_code, p_supplier_name, p_run);
  update public.discovery_runs
  set category_key = v_category_key
  where id = v_saved.run_id;
  return query select
    v_saved.run_id,
    v_saved.candidate_count,
    v_saved.observation_count;
end;
$$;

revoke all on function public.persist_discovery_run_v1(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.persist_discovery_run(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_discovery_run(text, text, jsonb)
  to service_role;

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
)
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
  observation.delivery_days_max
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
  select
    item.supplier_cost_min,
    item.supplier_cost_max,
    item.currency,
    item.listing_count,
    item.inventory,
    item.verified_inventory,
    item.delivery_days_min,
    item.delivery_days_max
  from public.supplier_product_observations item
  where item.candidate_id = candidate.id
  order by item.observed_at desc
  limit 1
) observation on true
where not exists (
  select 1
  from public.supplier_products imported
  where imported.supplier_id = candidate.supplier_id
    and imported.external_product_id = candidate.external_product_id
);

revoke all on public.discovery_catalog from public, anon;
grant select on public.discovery_catalog to authenticated, service_role;

comment on view public.discovery_catalog is
  'Latest unimported discovery candidate per supplier product with cross-run sighting metadata.';

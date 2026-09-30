-- Durable, read-safe discovery evidence. Broad discovery does not create internal products.
create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  profile_id text not null check (btrim(profile_id) <> ''),
  original_query text not null check (btrim(original_query) <> '' and length(original_query) <= 200),
  status text not null check (status in ('completed', 'completed_with_warnings', 'failed')),
  configuration_version text not null check (btrim(configuration_version) <> ''),
  scoring_version text not null check (btrim(scoring_version) <> ''),
  started_at timestamptz not null,
  completed_at timestamptz not null,
  cache_expires_at timestamptz not null,
  budget jsonb not null check (jsonb_typeof(budget) = 'object'),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array'),
  created_at timestamptz not null default now(),
  check (completed_at >= started_at),
  check (cache_expires_at >= completed_at)
);
create index discovery_runs_started_idx on public.discovery_runs(supplier_id, profile_id, original_query, started_at desc);
create index discovery_runs_cache_idx on public.discovery_runs(cache_expires_at) where status <> 'failed';

create table public.discovery_queries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs(id) on delete cascade,
  ordinal integer not null check (ordinal > 0),
  query text not null check (btrim(query) <> '' and length(query) <= 200),
  source text not null check (source in ('original', 'rule_based', 'synonym', 'category', 'local_model')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  reason text not null check (btrim(reason) <> ''),
  unique (run_id, ordinal),
  unique (run_id, query)
);

create table public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  external_product_id text not null check (btrim(external_product_id) <> '' and length(external_product_id) <= 200),
  rank integer not null check (rank > 0),
  title text not null check (btrim(title) <> ''),
  image_url text,
  source_url text,
  eligibility_status text not null check (eligibility_status in ('pass', 'review', 'fail')),
  relevance_level text not null check (relevance_level in ('exact', 'strong', 'related', 'weak', 'irrelevant')),
  score numeric(6,2) not null check (score between 0 and 100),
  confidence numeric(6,2) not null check (confidence between 0 and 100),
  coverage numeric(6,2) not null check (coverage between 0 and 100),
  assessment jsonb not null check (jsonb_typeof(assessment) = 'object'),
  created_at timestamptz not null default now(),
  unique (run_id, supplier_id, external_product_id),
  unique (run_id, rank),
  check (image_url is null or image_url ~ '^https://'),
  check (source_url is null or source_url ~ '^https://')
);
create index discovery_candidates_run_score_idx on public.discovery_candidates(run_id, eligibility_status, score desc);

create table public.discovery_occurrences (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.discovery_candidates(id) on delete cascade,
  strategy text not null check (strategy in (
    'original_query', 'expanded_query', 'token_query', 'listing_activity',
    'inventory', 'trending', 'new_products'
  )),
  query text not null check (btrim(query) <> '' and length(query) <= 200),
  query_source text not null check (query_source in ('original', 'rule_based', 'synonym', 'category', 'local_model')),
  page integer not null check (page > 0),
  rank integer not null check (rank > 0),
  sort_by text not null check (sort_by in ('relevance', 'listings', 'cost', 'newest', 'inventory')),
  filters jsonb not null check (jsonb_typeof(filters) = 'object'),
  source text not null check (btrim(source) <> ''),
  retrieved_at timestamptz not null
);
create index discovery_occurrences_candidate_idx on public.discovery_occurrences(candidate_id, retrieved_at desc);

create table public.supplier_product_observations (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.discovery_candidates(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  external_product_id text not null check (btrim(external_product_id) <> '' and length(external_product_id) <= 200),
  observed_at timestamptz not null,
  source text not null check (btrim(source) <> ''),
  supplier_cost_min numeric(18,6) check (supplier_cost_min >= 0),
  supplier_cost_max numeric(18,6) check (supplier_cost_max >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  listing_count integer check (listing_count >= 0),
  inventory integer check (inventory >= 0),
  verified_inventory integer check (verified_inventory >= 0),
  unverified_inventory integer check (unverified_inventory >= 0),
  delivery_days_min integer check (delivery_days_min >= 0),
  delivery_days_max integer check (delivery_days_max >= 0),
  sale_status text check (sale_status in ('on_sale', 'not_on_sale')),
  visible boolean,
  normalized_snapshot jsonb not null check (jsonb_typeof(normalized_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  check ((supplier_cost_min is null and supplier_cost_max is null and currency is null) or
         (supplier_cost_min is not null and supplier_cost_max is not null and currency is not null)),
  check (supplier_cost_min is null or supplier_cost_max >= supplier_cost_min),
  check (delivery_days_min is null or delivery_days_max >= delivery_days_min)
);
create index supplier_product_observations_history_idx on public.supplier_product_observations(
  supplier_id, external_product_id, observed_at desc
);

create table private.discovery_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs(id),
  strategy text not null,
  query text not null,
  page integer not null check (page > 0),
  source text not null check (btrim(source) <> ''),
  retrieved_at timestamptz not null,
  raw_payload jsonb not null check (jsonb_typeof(raw_payload) = 'object'),
  created_at timestamptz not null default now()
);
create index discovery_snapshots_run_idx on private.discovery_snapshots(run_id, retrieved_at);
alter table private.discovery_snapshots enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'discovery_runs', 'discovery_queries', 'discovery_candidates',
    'discovery_occurrences', 'supplier_product_observations'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant select on public.%I to service_role', table_name);
    execute format('create policy internal_read on public.%I for select to authenticated using ((select public.is_internal_user()))', table_name);
  end loop;
end;
$$;

revoke all on private.discovery_snapshots from public, anon, authenticated;
grant select, insert on private.discovery_snapshots to service_role;

-- One transaction persists a completed application result and its private raw source pages.
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
  v_supplier_id uuid;
  v_run_id uuid;
  v_candidate_id uuid;
  v_query record;
  v_candidate jsonb;
  v_occurrence jsonb;
  v_page jsonb;
  v_observation jsonb;
  v_candidate_count integer := 0;
  v_observation_count integer := 0;
  v_ordinal integer;
begin
  if p_supplier_code is null or btrim(p_supplier_code) = '' or length(p_supplier_code) > 100 or
     p_supplier_name is null or btrim(p_supplier_name) = '' or
     p_run is null or jsonb_typeof(p_run) <> 'object' or
     jsonb_typeof(p_run->'queries') <> 'array' or
     jsonb_typeof(p_run->'candidates') <> 'array' or
     jsonb_typeof(p_run->'source_pages') <> 'array' or
     jsonb_array_length(p_run->'queries') > 100 or
     jsonb_array_length(p_run->'candidates') > 1000 or
     jsonb_array_length(p_run->'source_pages') > 200 then
    raise exception 'Invalid discovery run payload' using errcode = '22023';
  end if;

  insert into public.suppliers(code, name)
  values (btrim(p_supplier_code), btrim(p_supplier_name))
  on conflict (code) do update set name = excluded.name
  returning id into v_supplier_id;

  insert into public.discovery_runs(
    supplier_id, profile_id, original_query, status, configuration_version, scoring_version,
    started_at, completed_at, cache_expires_at, budget, metrics, warnings
  ) values (
    v_supplier_id, p_run->>'profile_id', p_run->>'original_query', p_run->>'status',
    p_run->>'configuration_version', p_run->>'scoring_version',
    (p_run->>'started_at')::timestamptz, (p_run->>'completed_at')::timestamptz,
    (p_run->>'cache_expires_at')::timestamptz,
    p_run->'budget', p_run->'metrics', p_run->'warnings'
  ) returning id into v_run_id;

  for v_query in
    select value, ordinality from jsonb_array_elements(p_run->'queries') with ordinality
  loop
    insert into public.discovery_queries(run_id, ordinal, query, source, confidence, reason)
    values (
      v_run_id, v_query.ordinality, v_query.value->>'query', v_query.value->>'source',
      (v_query.value->>'confidence')::numeric, v_query.value->>'reason'
    );
  end loop;

  v_ordinal := 0;
  for v_candidate in select value from jsonb_array_elements(p_run->'candidates')
  loop
    v_ordinal := v_ordinal + 1;
    if jsonb_typeof(v_candidate->'assessment') <> 'object' or
       jsonb_typeof(v_candidate->'occurrences') <> 'array' or
       jsonb_typeof(v_candidate->'observation') <> 'object' or
       jsonb_array_length(v_candidate->'occurrences') > 500 then
      raise exception 'Invalid discovery candidate payload' using errcode = '22023';
    end if;
    insert into public.discovery_candidates(
      run_id, supplier_id, external_product_id, rank, title, image_url, source_url,
      eligibility_status, relevance_level, score, confidence, coverage, assessment
    ) values (
      v_run_id, v_supplier_id, v_candidate->>'external_product_id', v_ordinal,
      v_candidate->>'title', nullif(v_candidate->>'image_url', ''), nullif(v_candidate->>'source_url', ''),
      v_candidate->>'eligibility_status', v_candidate->>'relevance_level',
      (v_candidate->>'score')::numeric, (v_candidate->>'confidence')::numeric,
      (v_candidate->>'coverage')::numeric, v_candidate->'assessment'
    ) returning id into v_candidate_id;
    v_candidate_count := v_candidate_count + 1;

    for v_occurrence in select value from jsonb_array_elements(v_candidate->'occurrences')
    loop
      insert into public.discovery_occurrences(
        candidate_id, strategy, query, query_source, page, rank, sort_by,
        filters, source, retrieved_at
      ) values (
        v_candidate_id, v_occurrence->>'strategy', v_occurrence->>'query',
        v_occurrence->>'query_source', (v_occurrence->>'page')::integer,
        (v_occurrence->>'rank')::integer, v_occurrence->>'sort_by',
        v_occurrence->'filters', v_occurrence->>'source',
        (v_occurrence->>'retrieved_at')::timestamptz
      );
    end loop;

    v_observation := v_candidate->'observation';
    insert into public.supplier_product_observations(
      candidate_id, supplier_id, external_product_id, observed_at, source,
      supplier_cost_min, supplier_cost_max, currency, listing_count, inventory,
      verified_inventory, unverified_inventory, delivery_days_min, delivery_days_max,
      sale_status, visible, normalized_snapshot
    ) values (
      v_candidate_id, v_supplier_id, v_candidate->>'external_product_id',
      (v_observation->>'observed_at')::timestamptz, v_observation->>'source',
      nullif(v_observation->>'supplier_cost_min', '')::numeric,
      nullif(v_observation->>'supplier_cost_max', '')::numeric,
      nullif(v_observation->>'currency', ''),
      nullif(v_observation->>'listing_count', '')::integer,
      nullif(v_observation->>'inventory', '')::integer,
      nullif(v_observation->>'verified_inventory', '')::integer,
      nullif(v_observation->>'unverified_inventory', '')::integer,
      nullif(v_observation->>'delivery_days_min', '')::integer,
      nullif(v_observation->>'delivery_days_max', '')::integer,
      nullif(v_observation->>'sale_status', ''),
      case when v_observation ? 'visible' and v_observation->'visible' <> 'null'::jsonb
        then (v_observation->>'visible')::boolean else null end,
      v_observation->'normalized_snapshot'
    );
    v_observation_count := v_observation_count + 1;
  end loop;

  for v_page in select value from jsonb_array_elements(p_run->'source_pages')
  loop
    insert into private.discovery_snapshots(
      run_id, strategy, query, page, source, retrieved_at, raw_payload
    ) values (
      v_run_id, v_page->>'strategy', v_page->>'query', (v_page->>'page')::integer,
      v_page->>'source', (v_page->>'retrieved_at')::timestamptz, v_page->'raw_payload'
    );
  end loop;

  return query select v_run_id, v_candidate_count, v_observation_count;
end;
$$;

revoke all on function public.persist_discovery_run(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.persist_discovery_run(text, text, jsonb) to service_role;

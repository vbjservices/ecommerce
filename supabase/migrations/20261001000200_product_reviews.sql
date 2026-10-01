-- Human merchandising review remains separate from supplier observations and channel publication.
create table if not exists public.product_reviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.product_candidates(id) on delete cascade,
  title text not null check (btrim(title) <> '' and length(title) <= 255),
  description text,
  retail_currency text not null default 'EUR' check (retail_currency ~ '^[A-Z]{3}$'),
  cost_currency text not null check (cost_currency ~ '^[A-Z]{3}$'),
  cost_to_retail_fx_rate numeric(18,8) check (cost_to_retail_fx_rate > 0),
  cost_reserve_percent numeric(6,3) not null default 0
    check (cost_reserve_percent >= 0 and cost_reserve_percent < 100),
  target_market_codes text[] not null default '{}'
    check (cardinality(target_market_codes) <= 50),
  notes text,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (description is null or length(description) <= 10000),
  check (notes is null or length(notes) <= 5000)
);

create table if not exists public.product_review_variants (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.product_reviews(id) on delete cascade,
  supplier_variant_id uuid not null references public.supplier_variants(id),
  selected boolean not null default false,
  retail_price numeric(18,6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, supplier_variant_id),
  check (retail_price is null or retail_price > 0),
  check (not selected or retail_price is not null)
);

create table if not exists public.product_review_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.product_candidates(id) on delete cascade,
  review_id uuid not null references public.product_reviews(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  event_type text not null check (event_type in ('saved', 'approved', 'rejected')),
  note text,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  check (note is null or length(note) <= 5000)
);

create index if not exists product_review_variants_review_idx
  on public.product_review_variants(review_id);
create index if not exists product_review_events_candidate_idx
  on public.product_review_events(candidate_id, created_at desc);

alter table public.product_reviews enable row level security;
alter table public.product_review_variants enable row level security;
alter table public.product_review_events enable row level security;

revoke all on public.product_reviews from public, anon, authenticated;
revoke all on public.product_review_variants from public, anon, authenticated;
revoke all on public.product_review_events from public, anon, authenticated;
grant select on public.product_reviews, public.product_review_variants, public.product_review_events
  to authenticated;
grant all on public.product_reviews, public.product_review_variants to service_role;
grant select, insert on public.product_review_events to service_role;

drop policy if exists internal_read on public.product_reviews;
create policy internal_read on public.product_reviews
  for select to authenticated using ((select public.is_internal_user()));
drop policy if exists internal_read on public.product_review_variants;
create policy internal_read on public.product_review_variants
  for select to authenticated using ((select public.is_internal_user()));
drop policy if exists internal_read on public.product_review_events;
create policy internal_read on public.product_review_events
  for select to authenticated using ((select public.is_internal_user()));

drop trigger if exists set_updated_at on public.product_reviews;
create trigger set_updated_at before update on public.product_reviews
for each row execute function private.set_updated_at();
drop trigger if exists set_updated_at on public.product_review_variants;
create trigger set_updated_at before update on public.product_review_variants
for each row execute function private.set_updated_at();

create or replace function public.review_product_candidate(
  p_candidate_id uuid,
  p_action text,
  p_title text,
  p_description text,
  p_retail_currency text,
  p_cost_currency text,
  p_cost_to_retail_fx_rate numeric,
  p_cost_reserve_percent numeric,
  p_target_market_codes text[],
  p_notes text,
  p_variants jsonb,
  p_actor_id uuid
) returns table(review_id uuid, candidate_status public.candidate_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.product_candidates%rowtype;
  v_review_id uuid;
  v_target_codes text[];
  v_snapshot jsonb;
begin
  if p_candidate_id is null or p_actor_id is null or p_action is null or
     p_action not in ('save', 'approve', 'reject') or
     p_title is null or btrim(p_title) = '' or length(btrim(p_title)) > 255 or
     p_retail_currency is null or p_retail_currency !~ '^[A-Z]{3}$' or
     p_cost_currency is null or p_cost_currency !~ '^[A-Z]{3}$' or
     p_cost_reserve_percent is null or p_cost_reserve_percent < 0 or p_cost_reserve_percent >= 100 or
     (p_cost_to_retail_fx_rate is not null and p_cost_to_retail_fx_rate <= 0) or
     p_target_market_codes is null or cardinality(p_target_market_codes) > 50 or
     p_variants is null or jsonb_typeof(p_variants) <> 'array' or
     jsonb_array_length(p_variants) > 200 or
     (p_description is not null and length(p_description) > 10000) or
     (p_notes is not null and length(p_notes) > 5000) then
    raise exception 'review_validation_failed' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.internal_users
    where user_id = p_actor_id and active
  ) then
    raise exception 'review_actor_forbidden' using errcode = '42501';
  end if;

  select * into v_candidate
  from public.product_candidates
  where id = p_candidate_id
  for update;
  if not found or v_candidate.status = 'archived' then
    raise exception 'review_candidate_not_found' using errcode = '22023';
  end if;

  select coalesce(array_agg(code order by code), '{}') into v_target_codes
  from (
    select distinct upper(btrim(code)) as code
    from unnest(p_target_market_codes) as code
    where upper(btrim(code)) ~ '^[A-Z]{2}$'
  ) normalized;
  if cardinality(v_target_codes) <> cardinality(p_target_market_codes) then
    raise exception 'review_validation_failed' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_variants) as variant(
      supplier_variant_id uuid, selected boolean, retail_price numeric
    )
    where variant.supplier_variant_id is null or variant.selected is null or
          (variant.retail_price is not null and variant.retail_price <= 0) or
          (variant.selected and variant.retail_price is null)
  ) or (
    select count(*) <> count(distinct variant.supplier_variant_id)
    from jsonb_to_recordset(p_variants) as variant(supplier_variant_id uuid)
  ) then
    raise exception 'review_validation_failed' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_variants) as input(supplier_variant_id uuid)
    left join public.supplier_variants as variant
      on variant.id = input.supplier_variant_id
     and variant.supplier_product_id = v_candidate.supplier_product_id
    where variant.id is null
  ) then
    raise exception 'review_variant_mismatch' using errcode = '22023';
  end if;

  if p_action = 'approve' then
    if cardinality(v_target_codes) = 0 or not exists (
      select 1 from jsonb_to_recordset(p_variants) as variant(
        supplier_variant_id uuid, selected boolean, retail_price numeric
      ) where variant.selected
    ) then
      raise exception 'review_incomplete' using errcode = '22023';
    end if;
    if p_cost_currency <> p_retail_currency and p_cost_to_retail_fx_rate is null then
      raise exception 'review_fx_rate_required' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_to_recordset(p_variants) as input(
        supplier_variant_id uuid, selected boolean, retail_price numeric
      )
      join public.supplier_variants as variant on variant.id = input.supplier_variant_id
      where input.selected and (
        variant.cost is null or variant.currency is null or variant.currency <> p_cost_currency
      )
    ) then
      raise exception 'review_cost_missing' using errcode = '22023';
    end if;
    if exists (
      select 1 from unnest(v_target_codes) as destination(code)
      where not exists (
        select 1
        from public.supplier_shipping_quotes as quote
        join public.supplier_variants as variant on variant.id = quote.supplier_variant_id
        where variant.supplier_product_id = v_candidate.supplier_product_id
          and quote.destination_country_code = destination.code
          and quote.quantity = 1 and quote.available
          and quote.cost is not null and quote.currency = p_cost_currency
      )
    ) then
      raise exception 'review_shipping_evidence_missing' using errcode = '22023';
    end if;
  end if;
  if p_action = 'reject' and (p_notes is null or btrim(p_notes) = '') then
    raise exception 'review_rejection_note_required' using errcode = '22023';
  end if;

  insert into public.product_reviews(
    candidate_id,title,description,retail_currency,cost_currency,
    cost_to_retail_fx_rate,cost_reserve_percent,target_market_codes,notes,
    created_by,updated_by
  ) values (
    p_candidate_id,btrim(p_title),nullif(btrim(p_description),''),p_retail_currency,p_cost_currency,
    p_cost_to_retail_fx_rate,p_cost_reserve_percent,v_target_codes,nullif(btrim(p_notes),''),
    p_actor_id,p_actor_id
  )
  on conflict (candidate_id) do update set
    title = excluded.title,
    description = excluded.description,
    retail_currency = excluded.retail_currency,
    cost_currency = excluded.cost_currency,
    cost_to_retail_fx_rate = excluded.cost_to_retail_fx_rate,
    cost_reserve_percent = excluded.cost_reserve_percent,
    target_market_codes = excluded.target_market_codes,
    notes = excluded.notes,
    updated_by = excluded.updated_by
  returning id into v_review_id;

  delete from public.product_review_variants as existing
  where existing.review_id = v_review_id;
  insert into public.product_review_variants(
    review_id,supplier_variant_id,selected,retail_price
  )
  select v_review_id,variant.supplier_variant_id,variant.selected,variant.retail_price
  from jsonb_to_recordset(p_variants) as variant(
    supplier_variant_id uuid, selected boolean, retail_price numeric
  );

  update public.product_candidates set
    status = case p_action
      when 'approve' then 'approved'::public.candidate_status
      when 'reject' then 'rejected'::public.candidate_status
      else 'ready_for_review'::public.candidate_status
    end,
    reviewed_at = case when p_action in ('approve','reject') then now() else null end,
    reviewed_by = case when p_action in ('approve','reject') then p_actor_id else null end
  where id = p_candidate_id;

  v_snapshot := jsonb_build_object(
    'title',btrim(p_title),
    'description',nullif(btrim(p_description),''),
    'retailCurrency',p_retail_currency,
    'costCurrency',p_cost_currency,
    'costToRetailFxRate',p_cost_to_retail_fx_rate,
    'costReservePercent',p_cost_reserve_percent,
    'targetMarketCodes',to_jsonb(v_target_codes),
    'variants',p_variants
  );
  insert into public.product_review_events(
    candidate_id,review_id,actor_id,event_type,note,snapshot
  ) values (
    p_candidate_id,v_review_id,p_actor_id,
    case p_action
      when 'save' then 'saved'
      when 'approve' then 'approved'
      else 'rejected'
    end,
    nullif(btrim(p_notes),''),v_snapshot
  );

  return query select v_review_id,
    case p_action
      when 'approve' then 'approved'::public.candidate_status
      when 'reject' then 'rejected'::public.candidate_status
      else 'ready_for_review'::public.candidate_status
    end;
end;
$$;

revoke all on function public.review_product_candidate(
  uuid,text,text,text,text,text,numeric,numeric,text[],text,jsonb,uuid
) from public, anon, authenticated;
grant execute on function public.review_product_candidate(
  uuid,text,text,text,text,text,numeric,numeric,text[],text,jsonb,uuid
) to service_role;

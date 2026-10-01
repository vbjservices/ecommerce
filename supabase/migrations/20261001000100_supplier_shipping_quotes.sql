-- Current normalized shipping estimates for one supplier variant and destination.
-- Raw provider responses remain append-only in the private schema.
create table if not exists public.supplier_shipping_quotes (
  id uuid primary key default gen_random_uuid(),
  supplier_variant_id uuid not null references public.supplier_variants(id) on delete cascade,
  destination_country_code text not null check (destination_country_code ~ '^[A-Z]{2}$'),
  origin_country_code text not null check (origin_country_code ~ '^[A-Z]{2}$'),
  quantity integer not null check (quantity > 0 and quantity <= 1000),
  available boolean not null,
  shipping_method text,
  cost numeric(18,6),
  currency text,
  delivery_days_min integer,
  delivery_days_max integer,
  source text not null check (btrim(source) <> ''),
  quoted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_variant_id, destination_country_code),
  check (
    (available and shipping_method is not null and btrim(shipping_method) <> '' and
      cost is not null and cost >= 0 and currency ~ '^[A-Z]{3}$') or
    (not available and shipping_method is null and cost is null and currency is null and
      delivery_days_min is null and delivery_days_max is null)
  ),
  check (
    (delivery_days_min is null and delivery_days_max is null) or
    (delivery_days_min >= 0 and delivery_days_max >= delivery_days_min)
  )
);
create index if not exists supplier_shipping_quotes_variant_idx
  on public.supplier_shipping_quotes(supplier_variant_id, quoted_at desc);

create table if not exists private.supplier_shipping_snapshots (
  id uuid primary key default gen_random_uuid(),
  supplier_variant_id uuid not null references public.supplier_variants(id),
  source text not null check (btrim(source) <> ''),
  quoted_at timestamptz not null,
  raw_payload jsonb not null check (jsonb_typeof(raw_payload) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists supplier_shipping_snapshots_history_idx
  on private.supplier_shipping_snapshots(supplier_variant_id, quoted_at desc);

alter table public.supplier_shipping_quotes enable row level security;
alter table private.supplier_shipping_snapshots enable row level security;
revoke all on public.supplier_shipping_quotes from public, anon, authenticated;
grant select on public.supplier_shipping_quotes to authenticated;
grant all on public.supplier_shipping_quotes to service_role;
drop policy if exists internal_read on public.supplier_shipping_quotes;
create policy internal_read on public.supplier_shipping_quotes
  for select to authenticated using ((select public.is_internal_user()));
revoke all on private.supplier_shipping_snapshots from public, anon, authenticated;
grant select, insert on private.supplier_shipping_snapshots to service_role;

drop trigger if exists set_updated_at on public.supplier_shipping_quotes;
create trigger set_updated_at
before update on public.supplier_shipping_quotes
for each row execute function private.set_updated_at();

create or replace function public.upsert_supplier_shipping_quotes(
  p_supplier_variant_id uuid,
  p_quoted_at timestamptz,
  p_source text,
  p_quotes jsonb,
  p_raw_payload jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote record;
begin
  if p_supplier_variant_id is null or p_quoted_at is null or
     p_source is null or btrim(p_source) = '' or
     p_quotes is null or jsonb_typeof(p_quotes) <> 'array' or
     jsonb_array_length(p_quotes) = 0 or jsonb_array_length(p_quotes) > 50 or
     p_raw_payload is null or jsonb_typeof(p_raw_payload) <> 'object' then
    raise exception 'Invalid shipping quote payload' using errcode = '22023';
  end if;
  if not exists (select 1 from public.supplier_variants where id = p_supplier_variant_id) then
    raise exception 'Supplier variant not found' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_quotes) as quote(
      destination_country_code text, origin_country_code text, quantity integer,
      available boolean, shipping_method text, cost numeric, currency text,
      delivery_days_min integer, delivery_days_max integer
    )
    where quote.destination_country_code !~ '^[A-Z]{2}$' or
          quote.origin_country_code !~ '^[A-Z]{2}$' or
          quote.quantity is null or quote.quantity <= 0 or quote.quantity > 1000 or
          quote.available is null or
          (quote.available and (
            quote.shipping_method is null or btrim(quote.shipping_method) = '' or
            quote.cost is null or quote.cost < 0 or quote.currency !~ '^[A-Z]{3}$'
          )) or
          (not quote.available and (
            quote.shipping_method is not null or quote.cost is not null or quote.currency is not null or
            quote.delivery_days_min is not null or quote.delivery_days_max is not null
          )) or
          ((quote.delivery_days_min is null) <> (quote.delivery_days_max is null)) or
          quote.delivery_days_min < 0 or quote.delivery_days_max < quote.delivery_days_min
  ) then
    raise exception 'Invalid normalized shipping quote' using errcode = '22023';
  end if;
  if (
    select count(*) <> count(distinct quote.destination_country_code)
    from jsonb_to_recordset(p_quotes) as quote(destination_country_code text)
  ) then
    raise exception 'Duplicate shipping destination' using errcode = '22023';
  end if;

  for v_quote in
    select *
    from jsonb_to_recordset(p_quotes) as quote(
      destination_country_code text, origin_country_code text, quantity integer,
      available boolean, shipping_method text, cost numeric, currency text,
      delivery_days_min integer, delivery_days_max integer
    )
  loop
    insert into public.supplier_shipping_quotes(
      supplier_variant_id, destination_country_code, origin_country_code,
      quantity, available, shipping_method, cost, currency,
      delivery_days_min, delivery_days_max, source, quoted_at
    ) values (
      p_supplier_variant_id, v_quote.destination_country_code, v_quote.origin_country_code,
      v_quote.quantity, v_quote.available, v_quote.shipping_method, v_quote.cost,
      v_quote.currency, v_quote.delivery_days_min, v_quote.delivery_days_max,
      btrim(p_source), p_quoted_at
    )
    on conflict (supplier_variant_id, destination_country_code) do update set
      origin_country_code = excluded.origin_country_code,
      quantity = excluded.quantity,
      available = excluded.available,
      shipping_method = excluded.shipping_method,
      cost = excluded.cost,
      currency = excluded.currency,
      delivery_days_min = excluded.delivery_days_min,
      delivery_days_max = excluded.delivery_days_max,
      source = excluded.source,
      quoted_at = excluded.quoted_at;
  end loop;

  insert into private.supplier_shipping_snapshots(
    supplier_variant_id, source, quoted_at, raw_payload
  ) values (p_supplier_variant_id, btrim(p_source), p_quoted_at, p_raw_payload);

  return jsonb_array_length(p_quotes);
end;
$$;

revoke all on function public.upsert_supplier_shipping_quotes(
  uuid, timestamptz, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.upsert_supplier_shipping_quotes(
  uuid, timestamptz, text, jsonb, jsonb
) to service_role;

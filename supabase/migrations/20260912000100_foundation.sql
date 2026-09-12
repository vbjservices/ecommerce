-- Supabase owns persistent state. No provider credentials belong in these tables.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- Restrict future objects as well; each future migration must grant deliberately.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

create table private.internal_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table private.internal_users enable row level security;

-- No arguments: a caller can check only their own membership, never another user.
create function public.is_internal_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.internal_users
    where user_id = (select auth.uid()) and active
  );
$$;
revoke all on function public.is_internal_user() from public, anon, authenticated;
grant execute on function public.is_internal_user() to authenticated, service_role;

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.set_updated_at() from public, anon, authenticated;

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sales_channels (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (btrim(provider) <> ''),
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  title text not null check (btrim(title) <> ''),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  sku text,
  options jsonb not null default '{}' check (jsonb_typeof(options) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, product_id)
);
create index product_variants_product_idx on public.product_variants(product_id);

create table public.supplier_products (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  product_id uuid not null references public.products(id),
  external_product_id text not null check (btrim(external_product_id) <> ''),
  source_url text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique (supplier_id, external_product_id),
  unique (id, product_id),
  check (last_seen_at >= first_seen_at)
);
create index supplier_products_product_idx on public.supplier_products(product_id);

create table public.supplier_variants (
  id uuid primary key default gen_random_uuid(),
  supplier_product_id uuid not null,
  product_id uuid not null,
  product_variant_id uuid not null,
  external_variant_id text not null check (btrim(external_variant_id) <> ''),
  cost numeric(18,6) check (cost >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  stock integer check (stock >= 0),
  source text not null check (btrim(source) <> ''),
  retrieved_at timestamptz not null,
  foreign key (supplier_product_id, product_id) references public.supplier_products(id, product_id),
  foreign key (product_variant_id, product_id) references public.product_variants(id, product_id),
  unique (supplier_product_id, external_variant_id),
  unique (supplier_product_id, product_variant_id),
  check ((cost is null and currency is null) or (cost is not null and currency is not null))
);
create index supplier_variants_variant_idx on public.supplier_variants(product_variant_id, product_id);

create type public.candidate_status as enum (
  'discovered', 'ingesting', 'ready_for_analysis', 'analyzing',
  'ready_for_review', 'approved', 'rejected', 'failed', 'archived'
);
create table public.product_candidates (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  supplier_product_id uuid not null unique,
  status public.candidate_status not null default 'discovered',
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (supplier_product_id, product_id) references public.supplier_products(id, product_id),
  check ((reviewed_at is null) = (reviewed_by is null)),
  check (status not in ('approved', 'rejected') or reviewed_by is not null)
);
create index product_candidates_product_idx on public.product_candidates(product_id);
create index product_candidates_reviewed_by_idx on public.product_candidates(reviewed_by);
create index product_candidates_created_idx on public.product_candidates(created_at desc);

-- Append observations in the future ingestion transaction. Never expose raw data to UI.
create table private.supplier_snapshots (
  id uuid primary key default gen_random_uuid(),
  supplier_product_id uuid not null references public.supplier_products(id),
  source text not null check (btrim(source) <> ''),
  retrieved_at timestamptz not null,
  raw_payload jsonb not null,
  created_at timestamptz not null default now()
);
create index supplier_snapshots_history_idx on private.supplier_snapshots(supplier_product_id, retrieved_at desc);
alter table private.supplier_snapshots enable row level security;

-- No browser INSERT/UPDATE/DELETE grants or policies, including for internal users.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'suppliers', 'sales_channels', 'products', 'product_variants',
    'supplier_products', 'supplier_variants', 'product_candidates'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
    execute format('create policy internal_read on public.%I for select to authenticated using ((select public.is_internal_user()))', table_name);
  end loop;
  foreach table_name in array array[
    'suppliers', 'sales_channels', 'products', 'product_variants', 'product_candidates'
  ] loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()', table_name);
  end loop;
end;
$$;

revoke all on all tables in schema private from public, anon, authenticated;
grant all on private.internal_users to service_role;
grant select, insert on private.supplier_snapshots to service_role;

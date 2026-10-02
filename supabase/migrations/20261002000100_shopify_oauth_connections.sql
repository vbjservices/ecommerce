-- OAuth connection state and encrypted Shopify store credentials.
-- Access tokens are encrypted by the Edge Function before they reach PostgreSQL.
alter table public.sales_channels
  add column if not exists connection_status text not null default 'disconnected',
  add column if not exists connected_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales_channels'::regclass
      and conname = 'sales_channels_connection_status_check'
  ) then
    alter table public.sales_channels add constraint sales_channels_connection_status_check
      check (connection_status in ('connected', 'disconnected', 'error'));
  end if;
end;
$$;

create table if not exists private.shopify_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  actor_id uuid not null references auth.users(id),
  shop_domain text not null
    check (shop_domain ~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table if not exists private.sales_channel_credentials (
  sales_channel_id uuid primary key references public.sales_channels(id) on delete cascade,
  access_token_ciphertext text not null check (btrim(access_token_ciphertext) <> ''),
  access_token_iv text not null check (access_token_iv ~ '^[A-Za-z0-9_-]{16}$'),
  granted_scopes text[] not null default '{}',
  connected_by uuid not null references auth.users(id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shopify_oauth_states_expiry_idx
  on private.shopify_oauth_states(expires_at);

alter table private.shopify_oauth_states enable row level security;
alter table private.sales_channel_credentials enable row level security;

revoke all on private.shopify_oauth_states from public, anon, authenticated;
revoke all on private.sales_channel_credentials from public, anon, authenticated;
grant all on private.shopify_oauth_states to service_role;
grant all on private.sales_channel_credentials to service_role;

drop trigger if exists set_updated_at on private.sales_channel_credentials;
create trigger set_updated_at before update on private.sales_channel_credentials
for each row execute function private.set_updated_at();

create or replace function public.create_shopify_oauth_state(
  p_state_hash text,
  p_shop_domain text,
  p_actor_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := lower(btrim(coalesce(p_shop_domain, '')));
begin
  if p_state_hash !~ '^[0-9a-f]{64}$' or
     v_domain !~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$' or
     p_actor_id is null then
    raise exception 'shopify_oauth_state_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.internal_users
    where user_id = p_actor_id and active
  ) then
    raise exception 'shopify_oauth_actor_forbidden' using errcode = '42501';
  end if;

  delete from private.shopify_oauth_states
  where expires_at < now() or consumed_at < now() - interval '1 hour';
  insert into private.shopify_oauth_states(
    state_hash, actor_id, shop_domain, expires_at
  ) values (
    p_state_hash, p_actor_id, v_domain, now() + interval '10 minutes'
  );
end;
$$;

create or replace function public.consume_shopify_oauth_state(
  p_state_hash text,
  p_shop_domain text
) returns table(actor_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := lower(btrim(coalesce(p_shop_domain, '')));
begin
  if p_state_hash !~ '^[0-9a-f]{64}$' or
     v_domain !~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$' then
    raise exception 'shopify_oauth_state_invalid' using errcode = '22023';
  end if;
  return query
  update private.shopify_oauth_states as oauth_state set
    consumed_at = now()
  where oauth_state.state_hash = p_state_hash
    and oauth_state.shop_domain = v_domain
    and oauth_state.consumed_at is null
    and oauth_state.expires_at > now()
  returning oauth_state.actor_id;
end;
$$;

create or replace function public.connect_shopify_channel(
  p_shop_domain text,
  p_access_token_ciphertext text,
  p_access_token_iv text,
  p_granted_scopes text[],
  p_actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := lower(btrim(coalesce(p_shop_domain, '')));
  v_channel_id uuid;
begin
  if v_domain !~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$' or
     p_access_token_ciphertext is null or btrim(p_access_token_ciphertext) = '' or
     length(p_access_token_ciphertext) > 4096 or
     p_access_token_iv !~ '^[A-Za-z0-9_-]{16}$' or
     p_granted_scopes is null or not ('write_products' = any(p_granted_scopes)) or
     p_actor_id is null then
    raise exception 'shopify_connection_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.internal_users
    where user_id = p_actor_id and active
  ) then
    raise exception 'shopify_connection_actor_forbidden' using errcode = '42501';
  end if;

  insert into public.sales_channels(
    provider, name, external_account_id, connection_status, connected_at
  ) values (
    'shopify', 'Shopify - ' || v_domain, v_domain, 'connected', now()
  )
  on conflict (provider, external_account_id) do update set
    name = excluded.name,
    connection_status = 'connected',
    connected_at = excluded.connected_at,
    updated_at = now()
  returning id into v_channel_id;

  insert into private.sales_channel_credentials(
    sales_channel_id, access_token_ciphertext, access_token_iv,
    granted_scopes, connected_by, connected_at
  ) values (
    v_channel_id, p_access_token_ciphertext, p_access_token_iv,
    p_granted_scopes, p_actor_id, now()
  )
  on conflict (sales_channel_id) do update set
    access_token_ciphertext = excluded.access_token_ciphertext,
    access_token_iv = excluded.access_token_iv,
    granted_scopes = excluded.granted_scopes,
    connected_by = excluded.connected_by,
    connected_at = excluded.connected_at;

  return v_channel_id;
end;
$$;

create or replace function public.get_shopify_connection(
  p_sales_channel_id uuid,
  p_actor_id uuid
) returns table(
  sales_channel_id uuid,
  shop_domain text,
  access_token_ciphertext text,
  access_token_iv text,
  granted_scopes text[]
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_sales_channel_id is null or p_actor_id is null or not exists (
    select 1 from private.internal_users
    where user_id = p_actor_id and active
  ) then
    raise exception 'shopify_connection_forbidden' using errcode = '42501';
  end if;
  return query
  select channel.id, channel.external_account_id,
    credential.access_token_ciphertext, credential.access_token_iv,
    credential.granted_scopes
  from public.sales_channels as channel
  join private.sales_channel_credentials as credential
    on credential.sales_channel_id = channel.id
  where channel.id = p_sales_channel_id
    and channel.provider = 'shopify'
    and channel.connection_status = 'connected';
end;
$$;

revoke all on function public.create_shopify_oauth_state(text,text,uuid)
  from public, anon, authenticated;
revoke all on function public.consume_shopify_oauth_state(text,text)
  from public, anon, authenticated;
revoke all on function public.connect_shopify_channel(text,text,text,text[],uuid)
  from public, anon, authenticated;
revoke all on function public.get_shopify_connection(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.create_shopify_oauth_state(text,text,uuid) to service_role;
grant execute on function public.consume_shopify_oauth_state(text,text) to service_role;
grant execute on function public.connect_shopify_channel(text,text,text,text[],uuid) to service_role;
grant execute on function public.get_shopify_connection(uuid,uuid) to service_role;

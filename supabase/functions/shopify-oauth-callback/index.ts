import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  encryptShopifyToken,
  hashOauthState,
  normalizeShopDomain,
  verifyShopifyHmac,
} from '../_shared/shopify-oauth.ts'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null
}

function string(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function dashboardRedirect(result: string) {
  const dashboard = (Deno.env.get('SHOPIFY_DASHBOARD_URL') ?? 'https://vbjservices.github.io/ecommerce/').trim()
  const safeDashboard = /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/iu.test(dashboard)
    ? dashboard : 'https://vbjservices.github.io/ecommerce/'
  const destination = new URL(safeDashboard)
  destination.searchParams.set('shopify', result)
  return new Response(null, {
    status: 303,
    headers: {
      Location: destination.href,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

export default {
  async fetch(req: Request) {
    if (req.method !== 'GET') return dashboardRedirect('unsupported_request')
    const clientId = (Deno.env.get('SHOPIFY_CLIENT_ID') ?? '').trim()
    const clientSecret = (Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '').trim()
    const encryptionKey = (Deno.env.get('SHOPIFY_TOKEN_ENCRYPTION_KEY') ?? '').trim()
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim()
    const serviceRoleKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()
    if (!clientId || !clientSecret || !encryptionKey || !supabaseUrl || !serviceRoleKey) {
      return dashboardRedirect('not_configured')
    }

    const url = new URL(req.url)
    const shop = normalizeShopDomain(url.searchParams.get('shop'))
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const timestamp = Number(url.searchParams.get('timestamp'))
    if (!shop || !code || !state || !Number.isInteger(timestamp) ||
        Math.abs(Date.now() / 1_000 - timestamp) > 600 ||
        !(await verifyShopifyHmac(url.searchParams, clientSecret))) {
      return dashboardRedirect('approval_unverified')
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const consumed = await admin.rpc('consume_shopify_oauth_state', {
      p_state_hash: await hashOauthState(state),
      p_shop_domain: shop,
    })
    const stateRow = Array.isArray(consumed.data) ? object(consumed.data[0]) : null
    const actorId = string(stateRow?.actor_id)
    if (consumed.error || !actorId) {
      return dashboardRedirect('request_expired')
    }

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, expiring: 0 }),
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null)
    const tokenBody = tokenResponse ? object(await tokenResponse.json().catch(() => null)) : null
    const token = string(tokenBody?.access_token)
    const scope = string(tokenBody?.scope)
    const scopes = scope?.split(',').map((value) => value.trim()).filter(Boolean) ?? []
    if (!tokenResponse?.ok || !token || !scopes.includes('write_products')) {
      return dashboardRedirect('product_access_missing')
    }

    let encrypted: { ciphertext: string; iv: string }
    try {
      encrypted = await encryptShopifyToken(token, encryptionKey, shop)
    } catch {
      return dashboardRedirect('token_storage_invalid')
    }
    const connected = await admin.rpc('connect_shopify_channel', {
      p_shop_domain: shop,
      p_access_token_ciphertext: encrypted.ciphertext,
      p_access_token_iv: encrypted.iv,
      p_granted_scopes: scopes,
      p_actor_id: actorId,
    })
    if (connected.error) {
      return dashboardRedirect('connection_save_failed')
    }
    return dashboardRedirect('connected')
  },
}

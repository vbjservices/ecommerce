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

function page(title: string, detail: string, ok: boolean, status = 200) {
  const dashboard = (Deno.env.get('SHOPIFY_DASHBOARD_URL') ?? 'https://vbjservices.github.io/ecommerce/').trim()
  const safeDashboard = /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/iu.test(dashboard)
    ? dashboard : 'https://vbjservices.github.io/ecommerce/'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f3f6f7;color:#172d32;font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:12vh auto;padding:36px;background:white;border:1px solid #dbe4e6;border-radius:12px}p{color:#53666b}a{display:inline-block;margin-top:12px;padding:11px 16px;border-radius:6px;background:#126355;color:white;text-decoration:none;font-weight:650}.status{color:${ok ? '#126355' : '#8c2638'};font-weight:700}</style></head><body><main><div class="status">${ok ? 'Connected' : 'Connection failed'}</div><h1>${title}</h1><p>${detail}</p><a href="${safeDashboard}">Return to product workspace</a></main></body></html>`
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
    },
  })
}

export default {
  async fetch(req: Request) {
    if (req.method !== 'GET') return page('Unsupported request', 'Return to the dashboard and start again.', false, 405)
    const clientId = (Deno.env.get('SHOPIFY_CLIENT_ID') ?? '').trim()
    const clientSecret = (Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '').trim()
    const encryptionKey = (Deno.env.get('SHOPIFY_TOKEN_ENCRYPTION_KEY') ?? '').trim()
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim()
    const serviceRoleKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()
    if (!clientId || !clientSecret || !encryptionKey || !supabaseUrl || !serviceRoleKey) {
      return page('Shopify is not configured', 'The server secrets are incomplete.', false, 503)
    }

    const url = new URL(req.url)
    const shop = normalizeShopDomain(url.searchParams.get('shop'))
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const timestamp = Number(url.searchParams.get('timestamp'))
    if (!shop || !code || !state || !Number.isInteger(timestamp) ||
        Math.abs(Date.now() / 1_000 - timestamp) > 600 ||
        !(await verifyShopifyHmac(url.searchParams, clientSecret))) {
      return page('Shopify approval could not be verified', 'Return to the dashboard and start the connection again.', false, 400)
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
      return page('This connection request expired', 'Return to the dashboard and start a new connection.', false, 400)
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
      return page('Shopify did not grant product access', 'Confirm the app requests write_products, then start again.', false, 400)
    }

    let encrypted: { ciphertext: string; iv: string }
    try {
      encrypted = await encryptShopifyToken(token, encryptionKey, shop)
    } catch {
      return page('Shopify token storage is not configured', 'Replace the token encryption key with a valid 32-byte key.', false, 503)
    }
    const connected = await admin.rpc('connect_shopify_channel', {
      p_shop_domain: shop,
      p_access_token_ciphertext: encrypted.ciphertext,
      p_access_token_iv: encrypted.iv,
      p_granted_scopes: scopes,
      p_actor_id: actorId,
    })
    if (connected.error) {
      return page('Shopify connection could not be saved', 'Return to the dashboard and try again.', false, 503)
    }
    return page('Petvia is connected to Shopify', 'The dashboard can now create unpublished product drafts.', true)
  },
}

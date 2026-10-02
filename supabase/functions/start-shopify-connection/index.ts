import { withSupabase } from 'npm:@supabase/server@^1'
import {
  hashOauthState,
  normalizeShopDomain,
  randomOauthState,
} from '../_shared/shopify-oauth.ts'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 })
    }
    const body = await req.json().catch(() => null) as { shopDomain?: unknown } | null
    const shop = normalizeShopDomain(body?.shopDomain)
    const actorId = ctx.userClaims?.id
    if (!shop || !actorId || !uuidPattern.test(actorId)) {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const membership = await ctx.supabase.rpc('is_internal_user')
    if (membership.error || membership.data !== true) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }

    const clientId = (Deno.env.get('SHOPIFY_CLIENT_ID') ?? '').trim()
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim()
    if (!clientId || !supabaseUrl) {
      return Response.json({ error: 'shopify_not_configured' }, { status: 503 })
    }
    let redirectUri: string
    try {
      redirectUri = new URL('/functions/v1/shopify-oauth-callback', supabaseUrl).href
    } catch {
      return Response.json({ error: 'shopify_not_configured' }, { status: 503 })
    }

    const state = randomOauthState()
    const saved = await ctx.supabaseAdmin.rpc('create_shopify_oauth_state', {
      p_state_hash: await hashOauthState(state),
      p_shop_domain: shop,
      p_actor_id: actorId,
    })
    if (saved.error) {
      return Response.json({ error: 'shopify_connection_persistence_failed' }, { status: 503 })
    }
    const authorizationUrl = new URL(`https://${shop}/admin/oauth/authorize`)
    authorizationUrl.searchParams.set('client_id', clientId)
    authorizationUrl.searchParams.set('scope', 'write_products')
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    authorizationUrl.searchParams.set('state', state)
    return Response.json({ authorizationUrl: authorizationUrl.href })
  }),
}

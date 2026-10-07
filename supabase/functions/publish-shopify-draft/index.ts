import { withSupabase } from 'npm:@supabase/server@^1'
import {
  prepareShopifyDraftInput,
  shopifyOptionSignature,
  type DraftSourcePayload,
} from '../_shared/shopify-draft.ts'
import { decryptShopifyToken, normalizeShopDomain } from '../_shared/shopify-oauth.ts'

const shopifyApiVersion = '2026-07'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const storePattern = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/
const productGidPattern = /^gid:\/\/shopify\/Product\/\d+$/
const variantGidPattern = /^gid:\/\/shopify\/ProductVariant\/\d+$/

type JsonObject = Record<string, unknown>

class PublishError extends Error {
  constructor(public readonly code: string, public readonly snapshot: JsonObject = {}) {
    super(code)
    this.name = 'PublishError'
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function string(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sourcePayload(value: unknown): DraftSourcePayload | null {
  const payload = object(value)
  if (!payload || !uuidPattern.test(string(payload.candidateId) ?? '') ||
      !uuidPattern.test(string(payload.productId) ?? '') ||
      !string(payload.title) || !/^[A-Z]{3}$/.test(string(payload.retailCurrency) ?? '') ||
      !Array.isArray(payload.imageUrls) || !Array.isArray(payload.variants) ||
      payload.variants.length < 1 || payload.variants.length > 200) return null
  const variants = payload.variants.map((value) => {
    const variant = object(value)
    const productVariantId = string(variant?.internalProductVariantId)
    const externalVariantId = string(variant?.supplierExternalVariantId)
    const options = object(variant?.options)
    const existingExternalVariantId = string(variant?.existingExternalVariantId)
    const price = typeof variant?.retailPrice === 'number' || typeof variant?.retailPrice === 'string'
      ? variant.retailPrice : null
    if (!productVariantId || !uuidPattern.test(productVariantId) || !externalVariantId ||
        !options || price === null || !/^\d{1,12}(?:\.\d{1,6})?$/.test(String(price)) ||
        (existingExternalVariantId !== null && !variantGidPattern.test(existingExternalVariantId))) return null
    return {
      internalProductVariantId: productVariantId,
      supplierExternalVariantId: externalVariantId,
      existingExternalVariantId,
      sku: string(variant?.sku),
      options,
      retailPrice: price,
    }
  })
  if (variants.some((variant) => variant === null) ||
      new Set(variants.map((variant) => variant!.internalProductVariantId)).size !== variants.length) return null
  return {
    candidateId: String(payload.candidateId),
    productId: String(payload.productId),
    title: String(payload.title),
    description: typeof payload.description === 'string' ? payload.description : null,
    retailCurrency: String(payload.retailCurrency),
    imageUrls: payload.imageUrls.filter((url): url is string => typeof url === 'string'),
    variants: variants as DraftSourcePayload['variants'],
  }
}

const syncDraftMutation = `#graphql
mutation SyncProductDraft($input: ProductSetInput!, $identifier: ProductSetIdentifiers!) {
  productSet(synchronous: true, input: $input, identifier: $identifier) {
    product {
      id
      handle
      status
      variants(first: 250) {
        nodes {
          id
          selectedOptions { name value }
        }
      }
    }
    userErrors { code field message }
  }
}`

async function syncDraft(
  store: string,
  token: string,
  input: ReturnType<typeof prepareShopifyDraftInput>,
  sourceVariants: DraftSourcePayload['variants'],
  externalListingId: string | null,
) {
  const identifier = externalListingId ? { id: externalListingId } : { handle: input.handle }
  const response = await fetch(`https://${store}/admin/api/${shopifyApiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    // productSet treats options and variants as a complete product state. Keep
    // productOptions on updates so newly selected option values can be created.
    body: JSON.stringify({ query: syncDraftMutation, variables: { input, identifier } }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)
  const raw = response ? object(await response.json().catch(() => null)) : null
  const graphErrors = Array.isArray(raw?.errors) ? raw.errors : []
  const data = object(raw?.data)
  const result = object(data?.productSet)
  const userErrors = Array.isArray(result?.userErrors) ? result.userErrors : []
  const snapshot = {
    httpStatus: response?.status ?? null,
    graphErrors,
    userErrors,
    product: object(result?.product),
  }
  if (!response?.ok || graphErrors.length || userErrors.length) {
    throw new PublishError('shopify_product_rejected', snapshot)
  }
  const product = object(result?.product)
  const productId = string(product?.id)
  const status = string(product?.status)
  const variantsConnection = object(product?.variants)
  const nodes = Array.isArray(variantsConnection?.nodes) ? variantsConnection.nodes : []
  if (!productId || !productGidPattern.test(productId) || status !== 'DRAFT') {
    throw new PublishError('shopify_response_invalid', snapshot)
  }
  const expectedMappings = new Map(input.variants.map((variant, index) => [
    shopifyOptionSignature(variant.optionValues),
    sourceVariants[index]!.internalProductVariantId,
  ]))
  const mappings = nodes.map((value) => {
    const variant = object(value)
    const selectedOptions = Array.isArray(variant?.selectedOptions)
      ? variant.selectedOptions.map((option) => {
          const item = object(option)
          return { optionName: string(item?.name) ?? '', value: string(item?.value) ?? '' }
        })
      : []
    const productVariantId = expectedMappings.get(shopifyOptionSignature(selectedOptions)) ?? null
    const externalVariantId = string(variant?.id)
    if (!productVariantId || !uuidPattern.test(productVariantId) ||
        !externalVariantId || !variantGidPattern.test(externalVariantId)) return null
    return { product_variant_id: productVariantId, external_variant_id: externalVariantId }
  })
  if (mappings.some((mapping) => mapping === null)) {
    throw new PublishError('shopify_variant_mapping_missing', snapshot)
  }
  return { productId, mappings, snapshot }
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 })
    }
    const input = object(await req.json().catch(() => null))
    const candidateId = string(input?.candidateId)
    const salesChannelId = string(input?.salesChannelId)
    const actorId = ctx.userClaims?.id
    if (!candidateId || !uuidPattern.test(candidateId) ||
        !salesChannelId || !uuidPattern.test(salesChannelId) ||
        !actorId || !uuidPattern.test(actorId)) {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const membership = await ctx.supabase.rpc('is_internal_user')
    if (membership.error || membership.data !== true) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }

    const encryptionKey = (Deno.env.get('SHOPIFY_TOKEN_ENCRYPTION_KEY') ?? '').trim()
    if (!encryptionKey) {
      return Response.json({ error: 'shopify_not_configured' }, { status: 503 })
    }
    const connection = await ctx.supabaseAdmin.rpc('get_shopify_connection', {
      p_sales_channel_id: salesChannelId,
      p_actor_id: actorId,
    })
    const connectionRow = Array.isArray(connection.data) ? object(connection.data[0]) : null
    const store = normalizeShopDomain(connectionRow?.shop_domain)
    const ciphertext = string(connectionRow?.access_token_ciphertext)
    const iv = string(connectionRow?.access_token_iv)
    if (connection.error || !store || !storePattern.test(store) || !ciphertext || !iv) {
      return Response.json({ error: 'shopify_not_connected' }, { status: 409 })
    }

    let token: string
    try {
      token = await decryptShopifyToken(ciphertext, iv, encryptionKey, store)
    } catch {
      return Response.json({ error: 'shopify_token_unavailable' }, { status: 503 })
    }

    const begun = await ctx.supabaseAdmin.rpc('begin_shopify_draft_listing', {
      p_candidate_id: candidateId,
      p_store_domain: store,
      p_actor_id: actorId,
    })
    if (begun.error) {
      const raw = begun.error.message ?? ''
      const code = [
        'listing_candidate_not_approved', 'listing_review_missing',
        'listing_review_incomplete', 'listing_in_progress',
      ].find((value) => raw.includes(value)) ?? 'listing_persistence_failed'
      return Response.json({ error: code }, { status: code === 'listing_persistence_failed' ? 503 : 409 })
    }
    const row = Array.isArray(begun.data) ? object(begun.data[0]) : null
    const listingId = string(row?.listing_id)
    const attemptId = string(row?.attempt_id)
    const handle = string(row?.external_handle)
    const externalListingId = string(row?.external_listing_id)
    const payload = sourcePayload(row?.source_payload)
    if (!listingId || !attemptId || !handle || !payload) {
      return Response.json({ error: 'listing_persistence_failed' }, { status: 503 })
    }

    try {
      const productInput = prepareShopifyDraftInput(payload, handle)
      const synced = await syncDraft(store, token, productInput, payload.variants, externalListingId)
      const completed = await ctx.supabaseAdmin.rpc('complete_shopify_draft_listing', {
        p_listing_id: listingId,
        p_attempt_id: attemptId,
        p_external_listing_id: synced.productId,
        p_variant_mappings: synced.mappings,
        p_response_snapshot: synced.snapshot,
        p_actor_id: actorId,
      })
      if (completed.error) {
        console.error('publish-shopify-draft reconciliation failed', { listingId })
        return Response.json({ error: 'listing_reconciliation_failed' }, { status: 503 })
      }
      return Response.json({
        saved: true,
        listingId,
        externalListingId: synced.productId,
        status: 'draft',
      })
    } catch (error) {
      const publishError = error instanceof PublishError
        ? error : new PublishError('shopify_unavailable')
      const failed = await ctx.supabaseAdmin.rpc('fail_shopify_draft_listing', {
        p_listing_id: listingId,
        p_attempt_id: attemptId,
        p_error_code: publishError.code,
        p_response_snapshot: publishError.snapshot,
        p_actor_id: actorId,
      })
      if (failed.error) console.error('publish-shopify-draft failure persistence failed', { listingId })
      console.error('publish-shopify-draft failed', { code: publishError.code, listingId })
      return Response.json({ error: publishError.code }, { status: 503 })
    }
  }),
}

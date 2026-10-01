import { withSupabase } from 'npm:@supabase/server@^1'

const cjBaseUrl = 'https://developers.cjdropshipping.com/api2.0/v1'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const productIdPattern = /^[A-Za-z0-9-]{1,200}$/
const destinations = ['NL', 'BE', 'DE', 'FR', 'ES', 'IT'] as const
let cachedAccessToken: string | null = null
let cachedAccessTokenExpiresAt = 0

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function string(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function successEnvelope(value: unknown) {
  const envelope = object(value)
  if (!envelope || (envelope.result !== true && envelope.success !== true)) return null
  return envelope
}

async function providerRequest(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`${cjBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      'CJ-Access-Token': token,
      ...init?.headers,
    },
    signal: AbortSignal.timeout(12_000),
  })
  const raw = await response.json().catch(() => null)
  const envelope = successEnvelope(raw)
  if (!response.ok || !envelope) throw new Error('provider_unavailable')
  return envelope
}

async function accessToken(apiKey: string) {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) return cachedAccessToken
  const response = await fetch(`${cjBaseUrl}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
    signal: AbortSignal.timeout(12_000),
  })
  const envelope = successEnvelope(await response.json().catch(() => null))
  const data = object(envelope?.data)
  const token = string(data?.accessToken)
  if (!response.ok || !token) throw new Error('provider_authentication')
  const expiry = Date.parse(string(data?.accessTokenExpiryDate) ?? '')
  cachedAccessToken = token
  cachedAccessTokenExpiresAt = Number.isFinite(expiry) ? expiry - 60_000 : Date.now()
  return cachedAccessToken
}

function relation(value: unknown) {
  return Array.isArray(value) ? object(value[0]) : object(value)
}

function deliveryDays(value: unknown) {
  const match = string(value)?.match(/^(\d+)(?:\s*-\s*(\d+))?$/)
  if (!match) return { min: null, max: null }
  const min = Number(match[1])
  const max = Number(match[2] ?? match[1])
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && max >= min
    ? { min, max }
    : { min: null, max: null }
}

function chooseOrigin(inventoryEnvelope: JsonObject, externalVariantId: string) {
  const data = object(inventoryEnvelope.data)
  const variants = Array.isArray(data?.variantInventories) ? data.variantInventories : []
  const selected = variants.map(object).find((variant) => string(variant?.vid) === externalVariantId)
  const rows = Array.isArray(selected?.inventory) ? selected.inventory.map(object) : []
  const stockedCountries = rows
    .filter((row) => (number(row?.totalInventory) ?? 0) > 0)
    .map((row) => string(row?.countryCode)?.toUpperCase() ?? null)
    .filter((code): code is string => code !== null && /^[A-Z]{2}$/.test(code))
  return stockedCountries.includes('CN') ? 'CN' : stockedCountries[0] ?? 'CN'
}

function normalizeQuote(destination: string, origin: string, envelope: JsonObject) {
  const options = Array.isArray(envelope.data) ? envelope.data.map(object) : []
  const normalized = options.flatMap((option) => {
    const cost = number(option?.totalPostageFee) ?? number(option?.logisticPrice)
    const method = string(option?.logisticName)
    if (cost === null || cost < 0 || !method) return []
    return [{ cost, method, ...deliveryDays(option?.logisticAging) }]
  }).sort((left, right) => left.cost - right.cost)
  const cheapest = normalized[0]
  return cheapest ? {
    destination_country_code: destination,
    origin_country_code: origin,
    quantity: 1,
    available: true,
    shipping_method: cheapest.method,
    cost: String(cheapest.cost),
    currency: 'USD',
    delivery_days_min: cheapest.min,
    delivery_days_max: cheapest.max,
  } : {
    destination_country_code: destination,
    origin_country_code: origin,
    quantity: 1,
    available: false,
    shipping_method: null,
    cost: null,
    currency: null,
    delivery_days_min: null,
    delivery_days_max: null,
  }
}

function publicError(error: unknown) {
  const code = error instanceof Error ? error.message : 'quote_failed'
  return new Set([
    'provider_authentication', 'provider_unavailable', 'invalid_provider_payload',
    'persistence_failed',
  ]).has(code) ? code : 'quote_failed'
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 1_100))

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 })
    }
    const input = object(await req.json().catch(() => null))
    const candidateId = string(input?.candidateId)
    if (!candidateId || !uuidPattern.test(candidateId)) {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const membership = await ctx.supabase.rpc('is_internal_user')
    if (membership.error || membership.data !== true) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    const candidate = await ctx.supabase
      .from('product_candidates')
      .select(`supplier_products!inner(
        external_product_id,suppliers!inner(code),
        supplier_variants(id,external_variant_id,cost,stock)
      )`)
      .eq('id', candidateId)
      .maybeSingle()
    const supplierProduct = relation(object(candidate.data)?.supplier_products)
    const supplier = relation(supplierProduct?.suppliers)
    const externalProductId = string(supplierProduct?.external_product_id)
    const variants = Array.isArray(supplierProduct?.supplier_variants)
      ? supplierProduct.supplier_variants.map(object).filter((value): value is JsonObject => value !== null)
      : []
    if (candidate.error || string(supplier?.code) !== 'cj' || !externalProductId ||
        !productIdPattern.test(externalProductId) || variants.length === 0) {
      return Response.json({ error: 'candidate_not_found' }, { status: 404 })
    }
    const selected = variants.sort((left, right) => {
      const leftStock = number(left.stock)
      const rightStock = number(right.stock)
      const leftInStock = (leftStock ?? 0) > 0
      const rightInStock = (rightStock ?? 0) > 0
      if (leftInStock !== rightInStock) return leftInStock ? -1 : 1
      return (number(left.cost) ?? Number.MAX_VALUE) - (number(right.cost) ?? Number.MAX_VALUE)
    })[0]!
    const supplierVariantId = string(selected.id)
    const externalVariantId = string(selected.external_variant_id)
    if (!supplierVariantId || !uuidPattern.test(supplierVariantId) ||
        !externalVariantId || !productIdPattern.test(externalVariantId)) {
      return Response.json({ error: 'invalid_provider_payload' }, { status: 503 })
    }
    const apiKey = Deno.env.get('CJ_API_KEY')?.trim()
    if (!apiKey) return Response.json({ error: 'integration_not_configured' }, { status: 503 })

    try {
      const token = await accessToken(apiKey)
      await wait()
      const inventory = await providerRequest(
        `/product/stock/getInventoryByPid?pid=${encodeURIComponent(externalProductId)}`, token,
      )
      const origin = chooseOrigin(inventory, externalVariantId)
      const rawDestinations: Record<string, JsonObject> = {}
      const quotes = []
      for (const destination of destinations) {
        await wait()
        const envelope = await providerRequest('/logistic/freightCalculate', token, {
          method: 'POST',
          body: JSON.stringify({
            startCountryCode: origin,
            endCountryCode: destination,
            products: [{ quantity: 1, vid: externalVariantId }],
          }),
        })
        rawDestinations[destination] = envelope
        quotes.push(normalizeQuote(destination, origin, envelope))
      }
      const quotedAt = new Date().toISOString()
      const saved = await ctx.supabaseAdmin.rpc('upsert_supplier_shipping_quotes', {
        p_supplier_variant_id: supplierVariantId,
        p_quoted_at: quotedAt,
        p_source: 'cj-api-v2:logistic/freightCalculate',
        p_quotes: quotes,
        p_raw_payload: { inventory, destinations: rawDestinations },
      })
      if (saved.error || saved.data !== quotes.length) throw new Error('persistence_failed')
      return Response.json({
        checked: true,
        availableDestinations: quotes.filter((quote) => quote.available).length,
        destinations: quotes.length,
        quotedAt,
      })
    } catch (error) {
      const code = publicError(error)
      console.error('quote-cj-shipping failed', { code, candidateId })
      return Response.json({ error: code }, { status: 503 })
    }
  }),
}

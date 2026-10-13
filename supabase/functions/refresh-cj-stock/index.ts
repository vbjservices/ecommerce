import { withSupabase } from 'npm:@supabase/server@^1'

const cjBaseUrl = 'https://developers.cjdropshipping.com/api2.0/v1'
const productIdPattern = /^[A-Za-z0-9-]{1,200}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function successEnvelope(value: unknown) {
  const envelope = object(value)
  if (!envelope || (envelope.result !== true && envelope.success !== true)) return null
  return envelope
}

async function providerRequest(path: string, token: string) {
  const response = await fetch(`${cjBaseUrl}${path}`, {
    headers: { 'CJ-Access-Token': token },
    signal: AbortSignal.timeout(12_000),
  })
  const envelope = successEnvelope(await response.json().catch(() => null))
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
  return token
}

function publicError(error: unknown) {
  const code = error instanceof Error ? error.message : 'stock_check_failed'
  return new Set([
    'provider_authentication', 'provider_unavailable', 'provider_rate_limited',
    'invalid_provider_payload', 'persistence_failed',
  ]).has(code) ? code : 'stock_check_failed'
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 1_100))

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 })
    }
    const input = object(await req.json().catch(() => null))
    const discoveryCandidateId = string(input?.discoveryCandidateId)
    if (!discoveryCandidateId || !uuidPattern.test(discoveryCandidateId)) {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const membership = await ctx.supabase.rpc('is_internal_user')
    if (membership.error || membership.data !== true) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    const candidate = await ctx.supabase
      .from('discovery_candidates')
      .select('external_product_id,suppliers!inner(code)')
      .eq('id', discoveryCandidateId)
      .maybeSingle()
    const candidateData = object(candidate.data)
    const supplierValue = candidateData?.suppliers
    const supplier = Array.isArray(supplierValue) ? object(supplierValue[0]) : object(supplierValue)
    const externalProductId = string(candidateData?.external_product_id)
    if (candidate.error || !externalProductId || !productIdPattern.test(externalProductId) ||
        string(supplier?.code) !== 'cj') {
      return Response.json({ error: 'candidate_not_found' }, { status: 404 })
    }
    const apiKey = Deno.env.get('CJ_API_KEY')?.trim()
    if (!apiKey) return Response.json({ error: 'integration_not_configured' }, { status: 503 })

    try {
      const token = await accessToken(apiKey)
      await wait()
      const variantsEnvelope = await providerRequest(
        `/product/variant/query?pid=${encodeURIComponent(externalProductId)}`, token,
      )
      await wait()
      const stockEnvelope = await providerRequest(
        `/product/stock/getInventoryByPid?pid=${encodeURIComponent(externalProductId)}`, token,
      )
      const variants = Array.isArray(variantsEnvelope.data)
        ? variantsEnvelope.data.map(object).filter((item): item is JsonObject => item !== null)
        : []
      const stockData = object(stockEnvelope.data)
      const stockEntries = Array.isArray(stockData?.variantInventories)
        ? stockData.variantInventories.map(object).filter((item): item is JsonObject => item !== null)
        : []
      if (!variants.length) throw new Error('invalid_provider_payload')
      const names = new Map(variants.map((variant) => {
        const id = string(variant.vid)
        return [id, string(variant.variantKey) ?? string(variant.variantSku)] as const
      }).filter((entry): entry is [string, string | null] => entry[0] !== null))
      const checkedAt = new Date().toISOString()
      const batchId = crypto.randomUUID()
      const rows = stockEntries.map((entry) => {
        const externalVariantId = string(entry.vid)
        if (!externalVariantId || !productIdPattern.test(externalVariantId)) {
          throw new Error('invalid_provider_payload')
        }
        const warehouses = (Array.isArray(entry.inventory) ? entry.inventory : []).flatMap((raw) => {
          const item = object(raw)
          const inventory = number(item?.totalInventory)
          if (inventory === null) return []
          return [{ country_code: string(item?.countryCode), inventory }]
        })
        return {
          batch_id: batchId,
          candidate_id: discoveryCandidateId,
          external_variant_id: externalVariantId,
          variant_name: names.get(externalVariantId) ?? null,
          total_inventory: warehouses.length
            ? warehouses.reduce((total, warehouse) => total + warehouse.inventory, 0)
            : null,
          warehouses,
          checked_at: checkedAt,
          source: 'cj-api-v2:product/stock/getInventoryByPid',
        }
      })
      if (!rows.length) throw new Error('invalid_provider_payload')
      const saved = await ctx.supabaseAdmin.from('discovery_inventory_checks').insert(rows)
      if (saved.error) throw new Error('persistence_failed')
      return Response.json({
        checked: true,
        variantCount: rows.length,
        totalInventory: rows.reduce((total, row) => total + (row.total_inventory ?? 0), 0),
        checkedAt,
      })
    } catch (error) {
      const code = publicError(error)
      console.error('refresh-cj-stock failed', { code, discoveryCandidateId })
      return Response.json({ error: code }, { status: 503 })
    }
  }),
}

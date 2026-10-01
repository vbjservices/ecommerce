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
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

function cleanText(html: string | null) {
  if (!html) return null
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

function imageUrls(product: JsonObject) {
  const values = [string(product.bigImage)]
  if (Array.isArray(product.productImageSet)) {
    values.push(...product.productImageSet.map(string))
  }
  const urls: string[] = []
  for (const value of values) {
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' && !urls.includes(url.href)) urls.push(url.href)
    } catch { /* Invalid supplier media is ignored. */ }
  }
  return urls.slice(0, 50)
}

function sourceUrl(title: string, productId: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `https://cjdropshipping.com/product/${slug}-p-${productId}.html`
}

function variantOptions(names: string[], rawKey: string | null) {
  if (!rawKey) return {}
  const values = rawKey.split('-').map((value) => value.trim())
  if (names.length === values.length && new Set(names).size === names.length) {
    return Object.fromEntries(names.map((name, index) => [name, values[index]]))
  }
  return { Variant: rawKey }
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 1_100))

function publicError(error: unknown) {
  const code = error instanceof Error ? error.message : 'import_failed'
  return new Set([
    'provider_authentication', 'provider_unavailable', 'invalid_provider_payload',
    'persistence_failed',
  ]).has(code) ? code : 'import_failed'
}

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
      .select('external_product_id,suppliers!inner(code,name)')
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
      const productEnvelope = await providerRequest(
        `/product/query?pid=${encodeURIComponent(externalProductId)}`, token,
      )
      await wait()
      const variantsEnvelope = await providerRequest(
        `/product/variant/query?pid=${encodeURIComponent(externalProductId)}`, token,
      )
      await wait()
      const stockEnvelope = await providerRequest(
        `/product/stock/getInventoryByPid?pid=${encodeURIComponent(externalProductId)}`, token,
      )

      const product = object(productEnvelope.data)
      const variants = Array.isArray(variantsEnvelope.data) ? variantsEnvelope.data.map(object) : []
      const stock = object(stockEnvelope.data)
      const title = string(product?.productNameEn)
      if (!product || string(product.pid) !== externalProductId || !title ||
          variants.length === 0 || variants.some((variant) => !variant)) {
        throw new Error('invalid_provider_payload')
      }
      const stockByVariant = new Map<string, number | null>()
      const inventories = Array.isArray(stock?.variantInventories) ? stock.variantInventories : []
      for (const rawEntry of inventories) {
        const entry = object(rawEntry)
        const variantId = string(entry?.vid)
        if (!variantId) continue
        const rows = Array.isArray(entry?.inventory) ? entry.inventory : []
        const known = rows.map((row) => number(object(row)?.totalInventory))
          .filter((value): value is number => value !== null && value >= 0)
        stockByVariant.set(variantId, known.length ? known.reduce((sum, value) => sum + value, 0) : null)
      }
      const optionNames = Array.isArray(product.productKeyEnSet)
        ? product.productKeyEnSet.map(string).filter((value): value is string => value !== null)
        : []
      const normalizedVariants = variants.map((variant) => {
        const id = string(variant!.vid)
        const parentId = string(variant!.pid)
        const cost = string(variant!.variantSellPrice) ??
          (number(variant!.variantSellPrice) === null ? null : String(number(variant!.variantSellPrice)))
        if (!id || parentId !== externalProductId || !cost || !/^\d+(?:\.\d+)?$/.test(cost)) {
          throw new Error('invalid_provider_payload')
        }
        return {
          external_variant_id: id,
          sku: string(variant!.variantSku),
          options: variantOptions(optionNames, string(variant!.variantKey)),
          cost,
          currency: 'USD',
          stock: stockByVariant.get(id) ?? null,
        }
      })
      if (new Set(normalizedVariants.map((variant) => variant.external_variant_id)).size !==
          normalizedVariants.length) throw new Error('invalid_provider_payload')
      const images = imageUrls(product)
      const retrievedAt = new Date().toISOString()
      const saved = await ctx.supabaseAdmin.rpc('ingest_supplier_product', {
        p_supplier_code: 'cj',
        p_supplier_name: string(supplier?.name) ?? 'CJdropshipping',
        p_external_product_id: externalProductId,
        p_title: title,
        p_description: cleanText(string(product.description)),
        p_image_url: images[0] ?? null,
        p_source_url: sourceUrl(title, externalProductId),
        p_retrieved_at: retrievedAt,
        p_source: 'cj-api-v2',
        p_variants: normalizedVariants,
        p_raw_payload: {
          product: productEnvelope,
          variants: variantsEnvelope,
          stock: stockEnvelope,
        },
      })
      const row = Array.isArray(saved.data) ? object(saved.data[0]) : null
      if (saved.error || !row) throw new Error('persistence_failed')
      return Response.json({
        imported: true,
        created: row.created === true,
        candidateId: string(row.candidate_id),
        variantCount: number(row.variant_count),
      })
    } catch (error) {
      const code = publicError(error)
      console.error('import-cj-product failed', { code, discoveryCandidateId })
      return Response.json({ error: code }, { status: 503 })
    }
  }),
}

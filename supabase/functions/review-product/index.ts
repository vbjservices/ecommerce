import { withSupabase } from 'npm:@supabase/server@^1'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const moneyPattern = /^\d{1,12}(?:\.\d{1,6})?$/
const ratePattern = /^\d{1,6}(?:\.\d{1,8})?$/
const percentPattern = /^\d{1,2}(?:\.\d{1,3})?$/

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function text(value: unknown, maxLength: number, required = false) {
  if (value === null || value === undefined) return required ? null : ''
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if ((required && !normalized) || normalized.length > maxLength) return null
  return normalized
}

function decimal(value: unknown, pattern: RegExp, nullable = false) {
  if ((value === null || value === '') && nullable) return null
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string' ? value.trim() : ''
  return pattern.test(normalized) ? normalized : undefined
}

function publicError(error: unknown) {
  const message = object(error)?.message
  const raw = typeof message === 'string'
    ? message
    : error instanceof Error ? error.message : ''
  return [
    'review_validation_failed', 'review_actor_forbidden', 'review_candidate_not_found',
    'review_variant_mismatch', 'review_incomplete', 'review_fx_rate_required',
    'review_cost_missing', 'review_shipping_evidence_missing',
    'review_rejection_note_required',
  ].find((code) => raw.includes(code)) ?? 'persistence_failed'
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 })
    }
    const input = object(await req.json().catch(() => null))
    const candidateId = text(input?.candidateId, 36, true)
    const action = text(input?.action, 16, true)
    const title = text(input?.title, 255, true)
    const description = text(input?.description, 10_000)
    const notes = text(input?.notes, 5_000)
    const retailCurrency = text(input?.retailCurrency, 3, true)?.toUpperCase() ?? null
    const costCurrency = text(input?.costCurrency, 3, true)?.toUpperCase() ?? null
    const fxRate = decimal(input?.costToRetailFxRate, ratePattern, true)
    const reservePercent = decimal(input?.costReservePercent, percentPattern)
    const marketValues = Array.isArray(input?.targetMarketCodes) ? input.targetMarketCodes : null
    const variantValues = Array.isArray(input?.variants) ? input.variants : null
    if (!candidateId || !uuidPattern.test(candidateId) ||
        !action || !['save', 'approve', 'reject'].includes(action) || !title ||
        description === null || notes === null ||
        !retailCurrency || !/^[A-Z]{3}$/.test(retailCurrency) ||
        !costCurrency || !/^[A-Z]{3}$/.test(costCurrency) ||
        fxRate === undefined || reservePercent === undefined ||
        !marketValues || marketValues.length > 50 || !variantValues || variantValues.length > 200) {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const targetMarketCodes = marketValues.map((value) =>
      typeof value === 'string' ? value.trim().toUpperCase() : '')
    if (targetMarketCodes.some((code) => !/^[A-Z]{2}$/.test(code)) ||
        new Set(targetMarketCodes).size !== targetMarketCodes.length) {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const variants = variantValues.map((value) => {
      const variant = object(value)
      const supplierVariantId = text(variant?.supplierVariantId, 36, true)
      const retailPrice = decimal(variant?.retailPrice, moneyPattern, true)
      if (!supplierVariantId || !uuidPattern.test(supplierVariantId) ||
          typeof variant?.selected !== 'boolean' || retailPrice === undefined ||
          (variant.selected && retailPrice === null)) return null
      return {
        supplier_variant_id: supplierVariantId,
        selected: variant.selected,
        retail_price: retailPrice,
      }
    })
    if (variants.some((variant) => variant === null) ||
        new Set(variants.map((variant) => variant!.supplier_variant_id)).size !== variants.length) {
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    }
    const actorId = ctx.userClaims?.id
    if (!actorId || !uuidPattern.test(actorId)) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    const membership = await ctx.supabase.rpc('is_internal_user')
    if (membership.error || membership.data !== true) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    const result = await ctx.supabaseAdmin.rpc('review_product_candidate', {
      p_candidate_id: candidateId,
      p_action: action,
      p_title: title,
      p_description: description || null,
      p_retail_currency: retailCurrency,
      p_cost_currency: costCurrency,
      p_cost_to_retail_fx_rate: fxRate,
      p_cost_reserve_percent: reservePercent,
      p_target_market_codes: targetMarketCodes,
      p_notes: notes || null,
      p_variants: variants,
      p_actor_id: actorId,
    })
    if (result.error) {
      const code = publicError(result.error)
      console.error('review-product failed', { code, candidateId, action })
      return Response.json({ error: code }, {
        status: code === 'persistence_failed' ? 503 : 409,
      })
    }
    const row = Array.isArray(result.data) ? object(result.data[0]) : null
    return Response.json({
      saved: true,
      reviewId: typeof row?.review_id === 'string' ? row.review_id : null,
      candidateStatus: typeof row?.candidate_status === 'string' ? row.candidate_status : null,
    })
  }),
}

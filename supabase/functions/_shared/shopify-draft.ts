type JsonObject = Record<string, unknown>

export interface DraftSourceVariant {
  internalProductVariantId: string
  supplierExternalVariantId: string
  existingExternalVariantId?: string | null
  sku: string | null
  options: JsonObject
  retailPrice: string | number
}

export interface DraftSourcePayload {
  candidateId: string
  productId: string
  title: string
  description: string | null
  retailCurrency: string
  imageUrls: string[]
  variants: DraftSourceVariant[]
}

function safeString(value: unknown, fallback = '') {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function limited(value: string, max: number) {
  if (value.length <= max) return value
  return value.slice(0, Math.max(1, max - 1)).trimEnd() + '…'
}

function htmlDescription(value: string | null) {
  if (!value) return ''
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .split(/\r?\n/)
    .map((line) => line || '<br>')
    .join('<br>')
}

function cleanOptions(options: JsonObject) {
  return Object.entries(options)
    .map(([name, value]) => [limited(name.trim(), 255), limited(safeString(value, 'Default'), 255)] as const)
    .filter(([name]) => name.length > 0)
}

function variantPlan(variants: DraftSourceVariant[]) {
  const optionNames: string[] = []
  const seenNames = new Set<string>()
  for (const variant of variants) {
    for (const [name] of cleanOptions(variant.options)) {
      const key = name.toLocaleLowerCase('en-US')
      if (!seenNames.has(key)) {
        seenNames.add(key)
        optionNames.push(name)
      }
    }
  }

  if (optionNames.length > 0 && optionNames.length <= 3) {
    const combinations = variants.map((variant) => {
      const byName = new Map(cleanOptions(variant.options).map(([name, value]) => [
        name.toLocaleLowerCase('en-US'), value,
      ]))
      return optionNames.map((name) => byName.get(name.toLocaleLowerCase('en-US')) ?? 'Default')
    })
    const keys = combinations.map((values) => values.map((value) => value.toLocaleLowerCase('en-US')).join('\u0000'))
    if (new Set(keys).size === variants.length) {
      return { optionNames, combinations }
    }
  }

  const used = new Set<string>()
  const combinations = variants.map((variant, index) => {
    const base = cleanOptions(variant.options).map(([name, value]) => `${name}: ${value}`).join(' / ') ||
      variant.sku || variant.supplierExternalVariantId || `Variant ${index + 1}`
    let value = limited(base, 240)
    const key = value.toLocaleLowerCase('en-US')
    if (used.has(key)) value = limited(`${value} (${variant.supplierExternalVariantId.slice(-8)})`, 255)
    used.add(value.toLocaleLowerCase('en-US'))
    return [value]
  })
  return { optionNames: ['Variant'], combinations }
}

function imageExtension(value: string) {
  try {
    const match = new URL(value).pathname.toLowerCase().match(/\.(jpe?g|png|gif|webp|avif)$/)
    return match ? `.${match[1] === 'jpeg' ? 'jpg' : match[1]}` : '.jpg'
  } catch {
    return '.jpg'
  }
}

export function shopifyOptionSignature(values: Array<{ optionName?: string; name?: string; value?: string }>) {
  const pairs: Array<[string, string]> = values.map((option) => [
    safeString(option.optionName).toLocaleLowerCase('en-US'),
    safeString(option.name || option.value).toLocaleLowerCase('en-US'),
  ])
  return pairs.sort((left, right) => left[0].localeCompare(right[0]))
    .map((pair) => pair.join('\u0000')).join('\u0001')
}

export function prepareShopifyDraftInput(payload: DraftSourcePayload, handle: string) {
  const plan = variantPlan(payload.variants)
  const productOptions = plan.optionNames.map((name, optionIndex) => ({
    name,
    position: optionIndex + 1,
    values: [...new Set(plan.combinations.map((combination) => combination[optionIndex]!))]
      .map((value) => ({ name: value })),
  }))
  const variants = payload.variants.map((variant, index) => ({
    ...(variant.existingExternalVariantId ? { id: variant.existingExternalVariantId } : {}),
    optionValues: plan.optionNames.map((optionName, optionIndex) => ({
      optionName,
      name: plan.combinations[index]![optionIndex]!,
    })),
    price: String(variant.retailPrice),
    sku: variant.sku || undefined,
    inventoryPolicy: 'DENY',
    taxable: true,
  }))
  const imageUrls = [...new Set(payload.imageUrls)].filter((value) => {
    try { return new URL(value).protocol === 'https:' } catch { return false }
  }).slice(0, 20)
  const filenameStem = payload.productId.replaceAll('-', '')
  const files = imageUrls.map((originalSource, index) => ({
    originalSource,
    alt: limited(`${payload.title} - image ${index + 1}`, 255),
    filename: `ecommerce-${filenameStem}-${String(index + 1).padStart(2, '0')}${imageExtension(originalSource)}`,
    contentType: 'IMAGE',
    duplicateResolutionMode: 'REPLACE',
  }))
  return {
    title: payload.title,
    descriptionHtml: htmlDescription(payload.description),
    handle,
    status: 'DRAFT',
    productOptions,
    variants,
    files,
  }
}

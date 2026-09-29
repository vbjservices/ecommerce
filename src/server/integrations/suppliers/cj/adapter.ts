import '../../../only';
import { z } from 'zod';
import { IntegrationError } from '../../../../application/ports/integration-error';
import type { SupplierAdapter, SupplierSnapshot } from '../../../../application/ports/supplier-adapter';
import type { Json } from '../../../../domain/shared';
import { CjClient } from './client';

const identifier = /^[A-Za-z0-9-]{1,200}$/;
const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const productData = z.object({
  pid: z.string().min(1),
  productNameEn: z.string().nullish(),
  description: z.string().nullish(),
  productKeyEnSet: z.array(z.string()).nullish(),
}).passthrough();

const variantData = z.object({
  vid: z.string().min(1),
  pid: z.string().min(1),
  variantSku: z.string().nullish(),
  variantKey: z.string().nullish(),
  variantSellPrice: z.union([z.number().nonnegative(), z.string()]),
}).passthrough();

const stockData = z.object({
  variantInventories: z.array(z.object({
    vid: z.string().min(1),
    inventory: z.array(z.object({
      totalInventory: z.number().int().nonnegative().nullish(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

function cleanText(html: string | null | undefined) {
  if (!html) return null;
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
    .trim();
  return text || null;
}

function productUrl(title: string, pid: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://cjdropshipping.com/product/${slug}-p-${pid}.html`;
}

function variantOptions(names: string[], key: string | null | undefined) {
  if (!key?.trim()) return {};
  const values = key.split('-').map((value) => value.trim());
  const normalizedNames = names.map((name) => name.trim()).filter(Boolean);
  if (normalizedNames.length === values.length && new Set(normalizedNames).size === normalizedNames.length) {
    return Object.fromEntries(normalizedNames.map((name, index) => [name, values[index]!])) as Record<string, string>;
  }
  return { Variant: key.trim() };
}

function costAmount(value: string | number) {
  const amount = typeof value === 'number' ? String(value) : value.trim();
  if (!decimal.test(amount)) throw new IntegrationError('invalid_payload', 'cj');
  return amount;
}

export class CjSupplierAdapter implements SupplierAdapter {
  readonly provider = 'cj';
  readonly providerName = 'CJdropshipping';
  readonly catalog = { getProduct: (externalProductId: string) => this.getProduct(externalProductId) };

  constructor(private readonly client: CjClient) {}

  private async getProduct(externalProductId: string): Promise<SupplierSnapshot> {
    if (!identifier.test(externalProductId)) {
      throw new IntegrationError('invalid_payload', this.provider);
    }
    const encoded = encodeURIComponent(externalProductId);
    const [productResponse, variantsResponse, stockResponse] = await Promise.all([
      this.client.get(`/product/query?pid=${encoded}`),
      this.client.get(`/product/variant/query?pid=${encoded}`),
      this.client.get(`/product/stock/getInventoryByPid?pid=${encoded}`),
    ]);
    const product = productData.safeParse(productResponse.data);
    const variants = z.array(variantData).safeParse(variantsResponse.data);
    const stock = stockData.safeParse(stockResponse.data);
    if (!product.success || !variants.success || !stock.success ||
        product.data.pid !== externalProductId || variants.data.length === 0) {
      throw new IntegrationError('invalid_payload', this.provider);
    }
    if (variants.data.some((variant) => variant.pid !== externalProductId) ||
        new Set(variants.data.map((variant) => variant.vid)).size !== variants.data.length) {
      throw new IntegrationError('invalid_payload', this.provider);
    }
    const title = product.data.productNameEn?.trim();
    if (!title) throw new IntegrationError('invalid_payload', this.provider);
    const retrievedAt = new Date().toISOString();
    const inventoryByVariant = new Map(
      stock.data.variantInventories.map((entry) => {
        const known = entry.inventory
          .map((inventory) => inventory.totalInventory)
          .filter((value): value is number => value !== null && value !== undefined);
        return [entry.vid, known.length ? known.reduce((sum, value) => sum + value, 0) : null] as const;
      }),
    );
    const optionNames = product.data.productKeyEnSet ?? [];
    return {
      source: 'cj-api-v2',
      retrievedAt,
      rawPayload: {
        product: productResponse as unknown as Json,
        variants: variantsResponse as unknown as Json,
        stock: stockResponse as unknown as Json,
      },
      product: {
        externalProductId,
        title,
        description: cleanText(product.data.description),
        sourceUrl: productUrl(title, externalProductId),
        variants: variants.data.map((variant) => ({
          externalVariantId: variant.vid,
          sku: variant.variantSku?.trim() || null,
          options: variantOptions(optionNames, variant.variantKey),
          cost: {
            value: { amount: costAmount(variant.variantSellPrice), currency: 'USD' },
            source: 'cj-api-v2:product/variant/query',
            retrievedAt,
          },
          stock: {
            value: inventoryByVariant.get(variant.vid) ?? null,
            source: 'cj-api-v2:product/stock/getInventoryByPid',
            retrievedAt,
          },
        })),
      },
    };
  }
}

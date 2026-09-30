import '../../../only';
import { z } from 'zod';
import { IntegrationError } from '../../../../application/ports/integration-error';
import type {
  SupplierAdapter,
  SupplierDiscoveryInput,
  SupplierDiscoverySnapshot,
  SupplierSnapshot,
} from '../../../../application/ports/supplier-adapter';
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

const discoveryProduct = z.object({
  id: z.string().min(1),
  nameEn: z.string().min(1),
  sku: z.string().nullish(),
  bigImage: z.string().nullish(),
  sellPrice: z.string().nullish(),
  nowPrice: z.string().nullish(),
  discountPrice: z.string().nullish(),
  listedNum: z.number().int().nonnegative().nullish(),
  threeCategoryName: z.string().nullish(),
  categoryId: z.string().nullish(),
  addMarkStatus: z.number().int().nullish(),
  isVideo: z.number().int().nullish(),
  createAt: z.number().finite().nullish(),
  warehouseInventoryNum: z.number().int().nonnegative().nullish(),
  totalVerifiedInventory: z.number().int().nonnegative().nullish(),
  customization: z.number().int().nullish(),
  deliveryCycle: z.string().nullish(),
}).passthrough();

const discoveryData = z.object({
  pageNumber: z.number().int().positive(),
  totalRecords: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  content: z.array(z.object({
    productList: z.array(discoveryProduct),
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

function priceRange(value: string | null | undefined) {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  return {
    minAmount: match[1]!,
    maxAmount: match[2] ?? match[1]!,
    currency: 'USD',
  };
}

function deliveryDays(value: string | null | undefined) {
  if (!value) return null;
  const match = value.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && max >= min
    ? { min, max }
    : null;
}

function decimalFilter(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!decimal.test(normalized)) throw new IntegrationError('invalid_payload', 'cj');
  return normalized;
}

export class CjSupplierAdapter implements SupplierAdapter {
  readonly provider = 'cj';
  readonly providerName = 'CJdropshipping';
  readonly catalog = { getProduct: (externalProductId: string) => this.getProduct(externalProductId) };
  readonly discovery = { search: (input: SupplierDiscoveryInput) => this.search(input) };

  constructor(private readonly client: CjClient) {}

  private async search(input: SupplierDiscoveryInput): Promise<SupplierDiscoverySnapshot> {
    const query = input.query.trim();
    const page = input.cursor === undefined ? 1 : Number(input.cursor);
    const limit = input.limit ?? 50;
    if (!query || query.length > 200 || !Number.isSafeInteger(page) || page < 1 || page > 1_000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new IntegrationError('invalid_payload', this.provider);
    }
    const country = input.filters?.warehouseCountry;
    if (country !== undefined && !/^[A-Z]{2}$/.test(country)) {
      throw new IntegrationError('invalid_payload', this.provider);
    }
    const minCost = decimalFilter(input.filters?.minCost);
    const maxCost = decimalFilter(input.filters?.maxCost);
    const minInventory = input.filters?.minInventory;
    if (minInventory !== undefined && (!Number.isSafeInteger(minInventory) || minInventory < 0)) {
      throw new IntegrationError('invalid_payload', this.provider);
    }
    const orderBy = {
      relevance: '0', listings: '1', cost: '2', newest: '3', inventory: '4',
    }[input.sortBy ?? 'relevance'];
    const params = new URLSearchParams({
      keyWord: query,
      page: String(page),
      size: String(limit),
      sort: input.sortDirection ?? 'desc',
      orderBy,
    });
    params.append('features', 'enable_category');
    if (input.filters?.categoryId) params.set('categoryId', input.filters.categoryId);
    if (country) params.set('countryCode', country);
    if (minCost) params.set('startSellPrice', minCost);
    if (maxCost) params.set('endSellPrice', maxCost);
    if (minInventory !== undefined) params.set('startWarehouseInventory', String(minInventory));
    if (input.filters?.verifiedOnly) params.set('verifiedWarehouse', '1');

    const response = await this.client.get(`/product/listV2?${params}`);
    const parsed = discoveryData.safeParse(response.data);
    if (!parsed.success) throw new IntegrationError('invalid_payload', this.provider);
    const retrievedAt = new Date().toISOString();
    const products = parsed.data.content.flatMap((group) => group.productList).map((product) => ({
      externalProductId: product.id,
      title: product.nameEn.trim(),
      supplierSku: product.sku?.trim() || null,
      imageUrl: product.bigImage?.trim() || null,
      sourceUrl: productUrl(product.nameEn, product.id),
      category: product.threeCategoryName?.trim() || product.categoryId?.trim() || null,
      costRange: priceRange(product.discountPrice ?? product.nowPrice ?? product.sellPrice),
      listedCount: product.listedNum ?? null,
      inventory: product.warehouseInventoryNum ?? null,
      verifiedInventory: product.totalVerifiedInventory ?? null,
      createdAt: product.createAt === null || product.createAt === undefined
        ? null
        : new Date(product.createAt).toISOString(),
      deliveryDays: deliveryDays(product.deliveryCycle),
      hasVideo: product.isVideo === null || product.isVideo === undefined
        ? null : product.isVideo === 1,
      freeShipping: product.addMarkStatus === null || product.addMarkStatus === undefined
        ? null : product.addMarkStatus === 1,
      customizable: product.customization === null || product.customization === undefined
        ? null : product.customization === 1,
    }));
    return {
      products,
      nextCursor: parsed.data.pageNumber < parsed.data.totalPages
        ? String(parsed.data.pageNumber + 1)
        : null,
      totalResults: parsed.data.totalRecords,
      source: 'cj-api-v2:product/listV2',
      retrievedAt,
      rawPayload: response as unknown as Json,
    };
  }

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

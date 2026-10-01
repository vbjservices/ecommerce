const moneyScale = 1_000_000n;
const rateScale = 100_000_000n;
const percentScale = 1_000n;

function parseScaled(value: string | number, decimals: number) {
  const normalized = String(value).trim();
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  const fraction = (match[2] ?? '').padEnd(decimals, '0');
  return BigInt(match[1]!) * (10n ** BigInt(decimals)) + BigInt(fraction || '0');
}

function formatScaled(value: bigint, decimals: number) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function compareDecimalAmounts(left: string | number, right: string | number) {
  const leftValue = parseScaled(left, 6);
  const rightValue = parseScaled(right, 6);
  if (leftValue === null || rightValue === null) return null;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export interface ReviewEconomicsInput {
  supplierCost: string | number;
  shippingCost: string | number;
  retailPrice: string | number;
  costToRetailFxRate: string | number;
  costReservePercent: string | number;
}

export interface ReviewEconomics {
  landedCost: string;
  grossProfit: string;
  contributionProfit: string;
  grossMarginBasisPoints: number;
  contributionMarginBasisPoints: number;
  suggestedRetailPrice: string;
}

/** Exact fixed-point arithmetic for display estimates; decimal strings remain the data boundary. */
export function estimateReviewEconomics(input: ReviewEconomicsInput): ReviewEconomics | null {
  const supplier = parseScaled(input.supplierCost, 6);
  const shipping = parseScaled(input.shippingCost, 6);
  const retail = parseScaled(input.retailPrice, 6);
  const fx = parseScaled(input.costToRetailFxRate, 8);
  const reservePercent = parseScaled(input.costReservePercent, 3);
  if (supplier === null || shipping === null || retail === null || fx === null ||
      reservePercent === null || retail <= 0n || fx <= 0n || reservePercent >= 100n * percentScale) {
    return null;
  }
  const landed = ((supplier + shipping) * fx + rateScale / 2n) / rateScale;
  const reserve = (retail * reservePercent + (100n * percentScale) / 2n) /
    (100n * percentScale);
  const gross = retail - landed;
  const contribution = gross - reserve;
  const grossBasisPoints = Number((gross * 10_000n) / retail);
  const contributionBasisPoints = Number((contribution * 10_000n) / retail);
  const target = landed * 3n > landed + 10n * moneyScale
    ? landed * 3n
    : landed + 10n * moneyScale;
  const roundedWhole = (target + 10_000n + moneyScale - 1n) / moneyScale;
  const suggested = roundedWhole * moneyScale - 10_000n;
  return {
    landedCost: formatScaled(landed, 6),
    grossProfit: formatScaled(gross, 6),
    contributionProfit: formatScaled(contribution, 6),
    grossMarginBasisPoints: grossBasisPoints,
    contributionMarginBasisPoints: contributionBasisPoints,
    suggestedRetailPrice: formatScaled(suggested, 6),
  };
}

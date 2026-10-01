import type { Timestamp } from './shared';

export const shippingScopes = [
  'not_checked', 'worldwide', 'regional', 'limited_destinations', 'unavailable',
] as const;
export type ShippingScope = typeof shippingScopes[number];

export interface ShippingAvailability {
  scope: ShippingScope;
  regions: string[];
  checkedAt: Timestamp | null;
  source: string | null;
}

// The first commercial market. Availability still requires destination-specific quotes.
export const INITIAL_SHIPPING_MARKET = {
  id: 'europe',
  label: 'Europe',
  destinations: [
    { code: 'NL', label: 'Netherlands' },
    { code: 'BE', label: 'Belgium' },
    { code: 'DE', label: 'Germany' },
    { code: 'FR', label: 'France' },
    { code: 'ES', label: 'Spain' },
    { code: 'IT', label: 'Italy' },
  ],
} as const;

export const NOT_CHECKED_SHIPPING: ShippingAvailability = {
  scope: 'not_checked',
  regions: [],
  checkedAt: null,
  source: null,
};

export function shippingAvailabilityLabel(availability: ShippingAvailability) {
  if (availability.scope === 'not_checked') return 'Not checked';
  if (availability.scope === 'worldwide') return 'Worldwide';
  if (availability.scope === 'unavailable') return 'Unavailable';
  const regions = availability.regions.length ? `: ${availability.regions.join(', ')}` : '';
  return availability.scope === 'regional' ? `Regional${regions}` : `Limited${regions}`;
}

export function shippingMarketStatusLabel(
  availability: ShippingAvailability,
  market = INITIAL_SHIPPING_MARKET,
) {
  return `${market.label} · ${shippingAvailabilityLabel(availability)}`;
}

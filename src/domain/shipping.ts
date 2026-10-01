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

// Availability still requires a destination-specific quote for every catalog country.
export const INITIAL_SHIPPING_MARKET = {
  id: 'worldwide',
  label: 'Worldwide',
  totalDestinations: 249,
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

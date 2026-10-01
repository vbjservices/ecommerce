import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SHIPPING_MARKET,
  NOT_CHECKED_SHIPPING,
  shippingAvailabilityLabel,
  shippingMarketStatusLabel,
} from '../src/domain/shipping';

test('shipping labels distinguish unknown, worldwide, regional, limited, and unavailable states', () => {
  assert.equal(shippingAvailabilityLabel(NOT_CHECKED_SHIPPING), 'Not checked');
  assert.equal(shippingAvailabilityLabel({
    scope: 'worldwide', regions: [], checkedAt: '2026-09-30T12:00:00Z', source: 'quote-test',
  }), 'Worldwide');
  assert.equal(shippingAvailabilityLabel({
    scope: 'regional', regions: ['EU'], checkedAt: '2026-09-30T12:00:00Z', source: 'quote-test',
  }), 'Regional: EU');
  assert.equal(shippingAvailabilityLabel({
    scope: 'limited_destinations', regions: ['NL', 'BE'], checkedAt: '2026-09-30T12:00:00Z', source: 'quote-test',
  }), 'Limited: NL, BE');
  assert.equal(shippingAvailabilityLabel({
    scope: 'unavailable', regions: [], checkedAt: '2026-09-30T12:00:00Z', source: 'quote-test',
  }), 'Unavailable');
});

test('Europe is the explicit initial shipping market', () => {
  assert.equal(INITIAL_SHIPPING_MARKET.id, 'europe');
  assert.equal(shippingMarketStatusLabel(NOT_CHECKED_SHIPPING), 'Europe · Not checked');
});

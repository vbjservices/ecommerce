import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDecimalAmounts, estimateReviewEconomics } from '../src/domain/reviews';

test('review economics use exact decimal inputs for landed and contribution estimates', () => {
  assert.deepEqual(estimateReviewEconomics({
    supplierCost: '3.00',
    shippingCost: '4.00',
    retailPrice: '20.00',
    costToRetailFxRate: '0.90',
    costReservePercent: '10',
  }), {
    landedCost: '6.3',
    grossProfit: '13.7',
    contributionProfit: '11.7',
    grossMarginBasisPoints: 6850,
    contributionMarginBasisPoints: 5850,
    suggestedRetailPrice: '18.99',
  });
  assert.equal(compareDecimalAmounts('10.000001', '10.000000'), 1);
  assert.equal(compareDecimalAmounts('invalid', '10'), null);
});

test('review economics reject missing, nonpositive, and excessive percentage inputs', () => {
  assert.equal(estimateReviewEconomics({
    supplierCost: '3', shippingCost: '4', retailPrice: '0',
    costToRetailFxRate: '0.9', costReservePercent: '10',
  }), null);
  assert.equal(estimateReviewEconomics({
    supplierCost: '3', shippingCost: '4', retailPrice: '20',
    costToRetailFxRate: '0.9', costReservePercent: '100',
  }), null);
});

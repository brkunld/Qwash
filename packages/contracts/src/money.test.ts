import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assertKurus, costForDuration, formatKurus } from './money.ts';

test('costForDuration: sure x birim fiyat', () => {
  assert.equal(costForDuration(120, 50), 6000);
  assert.equal(costForDuration(0, 150), 0);
});

test('costForDuration: kesirli veya negatif girdi reddedilir', () => {
  assert.throws(() => costForDuration(1.5, 50), RangeError);
  assert.throws(() => costForDuration(10, 0.5), RangeError);
  assert.throws(() => costForDuration(-1, 50), RangeError);
});

test('assertKurus: kesirli deger reddedilir', () => {
  assert.throws(() => assertKurus(10.01), RangeError);
});

test('formatKurus: gosterim', () => {
  assert.equal(formatKurus(assertKurus(12345)), '123,45 ₺');
  assert.equal(formatKurus(assertKurus(5)), '0,05 ₺');
  assert.equal(formatKurus(assertKurus(-250)), '-2,50 ₺');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ibanChecksumValid, TrIbanSchema } from './account.ts';

test('gecerli TR IBAN bosluklu da kabul edilir', () => {
  assert.equal(
    TrIbanSchema.parse('tr33 0006 1005 1978 6457 8413 26'),
    'TR330006100519786457841326',
  );
});

test('checksum hatali veya TR olmayan IBAN reddedilir', () => {
  assert.equal(ibanChecksumValid('TR330006100519786457841327'), false);
  assert.equal(TrIbanSchema.safeParse('TR330006100519786457841327').success, false);
  assert.equal(TrIbanSchema.safeParse('DE89370400440532013000').success, false);
  assert.equal(TrIbanSchema.safeParse('TR12345').success, false);
});

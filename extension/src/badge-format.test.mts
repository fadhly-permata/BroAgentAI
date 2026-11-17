import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBadgeCount } from './badge-format.ts';

test('small counts are shown as is', () => {
  assert.equal(formatBadgeCount(0), '0');
  assert.equal(formatBadgeCount(7), '7');
  assert.equal(formatBadgeCount(999), '999');
});

test('thousands compact to k without rounding up', () => {
  assert.equal(formatBadgeCount(1000), '1k');
  assert.equal(formatBadgeCount(1250), '1.2k');
  assert.equal(formatBadgeCount(1999), '1.9k');
  assert.equal(formatBadgeCount(2000), '2k');
  assert.equal(formatBadgeCount(12_345), '12k');
  assert.equal(formatBadgeCount(999_999), '999k');
  assert.equal(formatBadgeCount(5_000_000), '1M+');
});

test('capped counts get a plus only when it still fits in 4 characters', () => {
  assert.equal(formatBadgeCount(500, true), '500+');
  assert.equal(formatBadgeCount(2000, true), '2k+');
  assert.equal(formatBadgeCount(1250, true), '1.2k');
});

test('never longer than 4 characters', () => {
  for (const n of [0, 9, 99, 999, 1000, 1049, 9999, 10_000, 99_999, 100_000, 999_999, 10 ** 9]) {
    for (const capped of [false, true]) assert.ok(formatBadgeCount(n, capped).length <= 4, `${n} ${capped}`);
  }
});

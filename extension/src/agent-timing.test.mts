import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOOL_TIMEOUT_MS, retryBackoffMs, sendDelayMs, toolTimeoutMs } from './agent-timing.ts';

test('tool timeout follows a long shell timeout instead of cutting it off', () => {
  assert.equal(toolTimeoutMs({}), DEFAULT_TOOL_TIMEOUT_MS);
  assert.equal(toolTimeoutMs({ timeoutMs: 5000 }), DEFAULT_TOOL_TIMEOUT_MS);
  assert.equal(toolTimeoutMs({ timeoutMs: 300_000 }), 330_000);
  assert.equal(toolTimeoutMs({ timeoutMs: 99 * 60_000 }), 630_000, 'capped at the bridge maximum');
  assert.equal(toolTimeoutMs({ timeoutMs: '300000' }), DEFAULT_TOOL_TIMEOUT_MS);
  assert.equal(toolTimeoutMs({ timeoutMs: -1 }), DEFAULT_TOOL_TIMEOUT_MS);
});

test('send delay accepts seconds, clamps, and treats junk as no delay', () => {
  assert.equal(sendDelayMs('3'), 3000);
  assert.equal(sendDelayMs(' 1.5 '), 1500);
  assert.equal(sendDelayMs(0), 0);
  assert.equal(sendDelayMs(''), 0);
  assert.equal(sendDelayMs('abc'), 0);
  assert.equal(sendDelayMs(-4), 0);
  assert.equal(sendDelayMs(9999), 300_000);
});

test('retry backoff grows and never undercuts the configured delay', () => {
  assert.equal(retryBackoffMs(1, 0), 5000);
  assert.equal(retryBackoffMs(2, 0), 10_000);
  assert.equal(retryBackoffMs(1, 12_000), 12_000);
  assert.equal(retryBackoffMs(3, 12_000), 36_000);
});

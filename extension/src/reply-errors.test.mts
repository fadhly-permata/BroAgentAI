import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorRetryDelay, isErrorReply, MAX_ERROR_RETRIES } from './reply-errors.ts';

const failure = ['^Something went wrong generating (that|this|the) response'];

test('a site failure text is an error reply', () => {
  assert.equal(isErrorReply('Something went wrong generating that response. Please try again.', failure), true);
  assert.equal(isErrorReply('  something went wrong generating the response  ', failure), true);
});

test('real answers are not error replies', () => {
  assert.equal(isErrorReply('READY', failure), false);
  assert.equal(isErrorReply('```json\n{"command":"fs.listTree","params":{}}\n```', failure), false);
  // Only short replies count: a long answer may quote the error while explaining it.
  const long = 'Something went wrong generating that response. ' + 'x'.repeat(600);
  assert.equal(isErrorReply(long, failure), false);
});

test('no patterns, or a broken one, never match', () => {
  assert.equal(isErrorReply('Something went wrong', undefined), false);
  assert.equal(isErrorReply('Something went wrong', []), false);
  assert.equal(isErrorReply('Something went wrong', ['(unclosed']), false);
});

test('retry delays grow and stop after the limit', () => {
  assert.equal(MAX_ERROR_RETRIES, 2);
  assert.equal(errorRetryDelay(1), 3000);
  assert.equal(errorRetryDelay(2), 8000);
  assert.equal(errorRetryDelay(3), null);
  assert.equal(errorRetryDelay(0), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedMessageKey, MESSAGE_KEY_LIMIT } from '../providers/message-key.ts';
import { ReplyTracker } from './reply-tracker.ts';

const snap = (text: string, key: number | null = null, count = 1) => ({ count, key, text });

test('a new reply is reported once, after its text stayed stable', () => {
  const tracker = new ReplyTracker(1000);
  assert.equal(tracker.observe(snap('hi', 2), false, 0), null);
  assert.equal(tracker.observe(snap('hi', 2), false, 500), null);
  assert.deepEqual(tracker.observe(snap('hi', 2), false, 1000), snap('hi', 2));
  tracker.delivered(snap('hi', 2));
  assert.equal(tracker.observe(snap('hi', 2), false, 5000), null);
  assert.equal(tracker.observe(snap('hi', 2), false, 9000), null);
});

test('stability is measured in time, so sparse observations (throttled tab) still report', () => {
  const tracker = new ReplyTracker(1000);
  assert.equal(tracker.observe(snap('done', 4), false, 0), null);
  assert.deepEqual(tracker.observe(snap('done', 4), false, 60_000), snap('done', 4));
});

test('streaming text restarts the stability window', () => {
  const tracker = new ReplyTracker(1000);
  tracker.observe(snap('par', 2), false, 0);
  assert.equal(tracker.observe(snap('partial', 2), false, 900), null);
  assert.equal(tracker.observe(snap('partial', 2), false, 1500), null);
  assert.deepEqual(tracker.observe(snap('partial', 2), false, 1900), snap('partial', 2));
});

test('nothing is reported while the page says it is generating', () => {
  const tracker = new ReplyTracker(1000);
  tracker.observe(snap('x', 2), false, 0);
  assert.equal(tracker.observe(snap('x', 2), true, 2000), null);
  assert.equal(tracker.observe(snap('x', 2), false, 2100), null); // window starts over
  assert.deepEqual(tracker.observe(snap('x', 2), false, 3100), snap('x', 2));
});

test('replies present at reset and older keys scrolling back are ignored', () => {
  const tracker = new ReplyTracker(1000);
  tracker.reset(snap('old', 10));
  tracker.observe(snap('old', 10), false, 0);
  assert.equal(tracker.observe(snap('old', 10), false, 5000), null);
  tracker.observe(snap('older', 6), false, 6000);
  assert.equal(tracker.observe(snap('older', 6), false, 9000), null);
});

test('a failed delivery is offered again; an in-flight one is not doubled', () => {
  const tracker = new ReplyTracker(1000);
  tracker.observe(snap('cmd', 2), false, 0);
  assert.ok(tracker.observe(snap('cmd', 2), false, 1000));
  assert.equal(tracker.observe(snap('cmd', 2), false, 1100), null, 'in flight');
  tracker.failed();
  assert.deepEqual(tracker.observe(snap('cmd', 2), false, 1200), snap('cmd', 2));
});

test('without an ordering key a changed count or text is new', () => {
  const tracker = new ReplyTracker(0);
  tracker.reset(snap('a', null, 3));
  tracker.observe(snap('a', null, 3), false, 0);
  assert.equal(tracker.observe(snap('a', null, 3), false, 10), null);
  tracker.observe(snap('b', null, 4), false, 20);
  assert.deepEqual(tracker.observe(snap('b', null, 4), false, 30), snap('b', null, 4));
});

test('an empty reply is never reported', () => {
  const tracker = new ReplyTracker(0);
  tracker.observe(snap('  ', 2), false, 0);
  assert.equal(tracker.observe(snap('  ', 2), false, 10), null);
});

test('derived message keys are stable, bounded and sensitive to attributes and text', () => {
  const key = boundedMessageKey('data-message-id=m1|hello');
  assert.equal(key, boundedMessageKey('data-message-id=m1|hello'));
  assert.notEqual(key, boundedMessageKey('data-message-id=m2|hello'));
  assert.notEqual(key, boundedMessageKey('data-message-id=m1|goodbye'));
  assert.ok(key >= 1 && key < MESSAGE_KEY_LIMIT, String(key));
});

test('a hashed key identifies a message: an older one scrolling back is not new', () => {
  const tracker = new ReplyTracker(0, { orderedKeys: false });
  tracker.reset(snap('old', 900_001));
  assert.equal(tracker.observe(snap('old', 900_001), false, 0), null);
  tracker.observe(snap('new', 12), false, 10);
  assert.deepEqual(tracker.observe(snap('new', 12), false, 20), snap('new', 12));
  tracker.delivered(snap('new', 12));
  assert.equal(tracker.observe(snap('old', 900_001), false, 30), null, 'higher hash does not mean newer');
  assert.equal(tracker.observe(snap('new', 12), false, 40), null);
  tracker.observe(snap('newer', 12, 2), false, 50);
  assert.deepEqual(tracker.observe(snap('newer', 12, 2), false, 60), snap('newer', 12, 2), 'streamed update to the current key');
});

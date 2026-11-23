import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareHostVersions, compareVersions, parseVersion } from './host-version.ts';

test('equal versions compare as equal', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions(' v0.1.0 ', '0.1'), 0);
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3+build.9'), 0);
});

test('older and newer versions compare in the right direction', () => {
  assert.equal(compareVersions('0.0.9', '0.1.0'), -1);
  assert.equal(compareVersions('0.1.0-dev', '0.1.0'), -1);
  assert.equal(compareVersions('0.1.0-beta.2', '0.1.0-beta.10'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('2.0', '1.9.9'), 1);
});

test('invalid and empty versions cannot be compared', () => {
  for (const value of ['', '   ', 'abc', '1.2.x', '1.2.3-', null, undefined, 123, {}]) {
    assert.equal(compareVersions(value, '0.1.0'), null, String(value));
    assert.equal(compareVersions('0.1.0', value), null, String(value));
  }
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { core: [1, 2, 3], pre: ['rc', '1'] });
});

test('host info comparison uses extension version and system.info hostVersion', () => {
  assert.deepEqual(compareHostVersions('0.1.0', { hostVersion: '0.1.0' }), {
    status: 'matching', extensionVersion: '0.1.0', hostVersion: '0.1.0', relation: 0,
  });
  assert.equal(compareHostVersions('0.1.1', { hostVersion: '0.1.0' }).status, 'mismatch');
  assert.equal(compareHostVersions('0.1.0', { hostVersion: '0.1.1' }).status, 'mismatch');
});

test('missing or invalid host info is unknown', () => {
  for (const info of [undefined, null, {}, { hostVersion: '' }, { hostVersion: 'unknown' }, { hostVersion: null }]) {
    const result = compareHostVersions('0.1.0', info);
    assert.equal(result.status, 'unknown');
    assert.equal(result.relation, null);
  }
  assert.equal(compareHostVersions('', { hostVersion: '0.1.0' }).status, 'unknown');
  assert.equal(compareHostVersions(undefined, { hostVersion: '0.1.0' }).status, 'unknown');
});

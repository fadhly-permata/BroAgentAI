import test from 'node:test';
import assert from 'node:assert/strict';
import { parentDir, baseName, targetDir, joinRel, toAbsolute, validateName, baseSelection } from './context-menu-paths.ts';

test('parentDir/baseName', () => {
  assert.equal(parentDir('a/b/c.ts'), 'a/b');
  assert.equal(parentDir('c.ts'), '.');
  assert.equal(parentDir('.'), '.');
  assert.equal(baseName('a/b/c.ts'), 'c.ts');
  assert.equal(baseName('.'), '');
});
test('targetDir', () => {
  assert.equal(targetDir('a/b.ts', false), 'a');
  assert.equal(targetDir('a', true), 'a');
  assert.equal(targetDir('.', true), '.');
});
test('joinRel', () => {
  assert.equal(joinRel('.', 'x.ts'), 'x.ts');
  assert.equal(joinRel('a', 'b\\c.ts'), 'a/b/c.ts');
});
test('toAbsolute', () => {
  assert.equal(toAbsolute('C:\\ws\\proj', 'src/a.ts'), 'C:\\ws\\proj\\src\\a.ts');
  assert.equal(toAbsolute('C:\\ws\\proj\\', '.'), 'C:\\ws\\proj');
  assert.equal(toAbsolute('/home/u/p', 'src/a.ts'), '/home/u/p/src/a.ts');
});
test('validateName', () => {
  assert.notEqual(validateName('  '), null);
  assert.notEqual(validateName('../x'), null);
  assert.notEqual(validateName('a/../x'), null);
  assert.notEqual(validateName('/abs'), null);
  assert.equal(validateName('a/b.ts'), null);
});
test('baseSelection', () => {
  assert.deepEqual(baseSelection('foo.test.ts'), [0, 8]);
  assert.deepEqual(baseSelection('.env'), [0, 4]);
  assert.deepEqual(baseSelection('dir'), [0, 3]);
});

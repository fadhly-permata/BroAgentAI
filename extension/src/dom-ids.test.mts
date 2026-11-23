// Every element the extension pages look up by id must exist somewhere: in a
// page's HTML or in a template string that renders it. A lookup of a removed
// element returns null, and the first `.textContent =` on it throws while the
// side panel initializes - the panel then never connects to the host and only
// shows "Host offline".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(srcDir).filter((f) => /\.(ts|html)$/.test(f) && !f.includes('.test.'));
const sources = new Map(files.map((f) => [f, readFileSync(join(srcDir, f), 'utf8')]));

const defined = new Set<string>();
for (const text of sources.values()) {
  for (const m of text.matchAll(/\bid=["'\\]*([A-Za-z][\w-]*)/g)) defined.add(m[1]);
  // Elements created in code: el.id = 'x'
  for (const m of text.matchAll(/\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g)) defined.add(m[1]);
}

test('every $(id) / getElementById(id) lookup has a matching element', () => {
  const missing: string[] = [];
  for (const [file, text] of sources) {
    if (!file.endsWith('.ts')) continue;
    const lookups = [
      ...text.matchAll(/\$\(\s*'([A-Za-z][\w-]*)'\s*\)/g),
      ...text.matchAll(/getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g),
    ];
    // sidepanel.ts's on(id, ...) helper skips a missing element with a warning, so it is not checked here.
    for (const m of lookups) if (!defined.has(m[1])) missing.push(`${file}: #${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('approval and shell safety strings exist in both locales', () => {
  const en = JSON.parse(readFileSync(join(srcDir, 'i18n/en.json'), 'utf8'));
  const id = JSON.parse(readFileSync(join(srcDir, 'i18n/id.json'), 'utf8'));
  const keys = [
    'shellTrustTitle', 'shellTrustDesc', 'shellChangeTitle', 'shellChangeDesc', 'shellConfirm', 'shellConfirmed',
    'approvalContextLabel', 'riskLabel', 'riskRead', 'riskWrite', 'riskHigh',
    'approvalShellSummary', 'approvalMcp', 'approvalNoPaths', 'approvalPaths', 'approvalTruncated',
    'askOnceShell', 'askOnceTool', 'waitingApproval', 'allow', 'deny',
  ];
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', `en:${key}`);
    assert.equal(typeof id[key], 'string', `id:${key}`);
  }
});

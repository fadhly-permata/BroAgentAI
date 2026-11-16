// Diagnose why the BroAgentAI MV3 extension does (not) load in Playwright.
// Run: node extension/e2e/diagnose-extension.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'e2e', 'shots');
fs.mkdirSync(out, { recursive: true });

const logs = [];
const ctx = await chromium.launchPersistentContext(path.join(root, 'e2e', '.pw-diagnose-profile'), {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--enable-logging=stderr',
    '--v=1',
  ],
});
ctx.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));

let worker = null;
for (const w of ctx.serviceWorkers()) worker = w;
if (!worker) {
  const deadline = Date.now() + 15000;
  while (!worker && Date.now() < deadline) {
    worker = await ctx.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null);
  }
}

const extId = worker ? worker.url().split('/')[2] : null;
console.log('EXT_ID       =', extId);
console.log('WORKER_URL   =', worker ? worker.url() : null);
console.log('WORKERS      =', ctx.serviceWorkers().map((w) => w.url()).join(', ') || '(none)');
console.log('BROWSER LOGS =');
for (const l of logs) console.log('  ' + l);

if (!extId) {
  console.log('\nFAIL: no extension id. The browser log above usually names the cause (manifest/background error).');
  await ctx.close();
  process.exit(2);
}

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE CONSOLE ERROR:', m.text()); });
try {
  await page.goto(`chrome-extension://${extId}/src/sidepanel.html`);
} catch (e) {
  console.log('GOTO FAILED:', e.message.split('\n')[0]);
}
await page.waitForTimeout(1000);
console.log('TITLE       =', await page.title().catch(() => '(error)'));
console.log('BODY_SNIP   =', (await page.locator('body').innerText().catch(() => '(empty)')).slice(0, 300).replace(/\n/g, ' | '));
await page.screenshot({ path: path.join(out, 'diagnose.png'), fullPage: true });
await ctx.close();
console.log('OK: extension loaded and side panel rendered (see e2e/shots/diagnose.png).');

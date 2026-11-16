// diag-tree.mjs - print what the side panel renders (header, tree, errors)
// against the REAL bridge with an isolated config dir.
// Usage: node extension/e2e/diag-tree.mjs [workspace-folder]
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealBridge, attachBridge } from './real-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const workspace = path.resolve(process.argv[2] ?? path.join(root, '..'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-diag-'));

const bridge = startRealBridge({ configDir });
const ctx = await chromium.launchPersistentContext(path.join(root, 'e2e', '.pw-profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  await attachBridge(ctx, bridge);
  await bridge.call('workspace.add', { path: workspace });
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker').catch(() => null);
  const extId = worker ? worker.url().split('/')[2] : null;
  console.log('EXT_ID=', extId);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`chrome-extension://${extId}/src/sidepanel.html`);
  await page.waitForTimeout(2500);
  console.log('---HOST---');
  console.log(await page.locator('#hostPill').innerText());
  console.log('---HEADER-WS---');
  console.log(await page.locator('#headerWs').innerText());
  console.log('---TREE---');
  console.log((await page.locator('#tree').innerText()).slice(0, 3000));
  console.log('---ERRORS---');
  console.log(JSON.stringify(errors, null, 2));
} finally {
  await ctx.close();
  bridge.stop();
  fs.rmSync(configDir, { recursive: true, force: true });
}

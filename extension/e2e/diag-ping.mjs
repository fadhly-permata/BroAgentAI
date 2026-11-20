// Diagnose: does the relay on a web chat page answer ba.ping?
// Run: node extension/e2e/diag-ping.mjs [url]
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const url = process.argv[2] || 'https://new.tusksearch.com/ai';

const ctx = await chromium.launchPersistentContext(path.join(root, 'e2e', '.pw-diag-ping-profile'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 15000 });

const page = await ctx.newPage();
page.on('console', (m) => console.log(`[page ${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(4000);

for (let i = 0; i < 3; i++) {
  worker = ctx.serviceWorkers()[0] ?? worker;
  const res = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.startsWith(target.split('?')[0].replace(/\/ai$/, '')));
    if (!tab) return { error: 'tab not found', tabs: tabs.map((t) => ({ id: t.id, url: t.url, status: t.status })) };
    const frames = await chrome.webNavigation?.getAllFrames?.({ tabId: tab.id }).catch(() => null);
    try {
      const ping = await chrome.tabs.sendMessage(tab.id, { type: 'ba.ping' });
      return { tab: { id: tab.id, url: tab.url, status: tab.status }, ping, frames: frames?.length };
    } catch (e) {
      return { tab: { id: tab.id, url: tab.url, status: tab.status }, error: String(e), frames: frames?.length };
    }
  }, url);
  console.log('PING', i, JSON.stringify(res));
  await page.waitForTimeout(1500);
}
await ctx.close();

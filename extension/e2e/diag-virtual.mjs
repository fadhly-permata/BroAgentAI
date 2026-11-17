// diag-virtual.mjs - does an old command get re-executed when the newest reply leaves the DOM?
// Usage: node extension/e2e/diag-virtual.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealBridge, attachBridge } from './real-bridge.mjs';
import { FAKE_CHAT_URL, routeFakeChat, say, lastAssistant } from './fake-chat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-virt-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, 'README.md'), '# Diag\n');
const bridge = startRealBridge({ configDir: path.join(tmp, 'config') });
const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const until = async (fn, timeout = 20000) => { const end = Date.now() + timeout; let v; for (;;) { try { v = await fn(); } catch { v = null; } if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); } };
try {
  await attachBridge(ctx, bridge);
  await routeFakeChat(ctx);
  await bridge.call('workspace.add', { path: ws });
  let worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const extId = worker.url().split('/')[2];
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/src/sidepanel.html`);
  const chat = await ctx.newPage();
  await chat.goto(FAKE_CHAT_URL);
  await page.bringToFront();
  await page.locator('.rail-btn[data-tab="agent"]').click();
  await page.locator('#modeSel').selectOption('auto-approve');
  await page.locator('#agentStart').click();
  await until(async () => /Sesi aktif/.test(await page.locator('#agentSession').innerText()));
  const finals = () => page.locator('#cmdLog [data-log-tool="assistant"]').count();
  await until(async () => (await finals()) >= 1);
  await say(chat, 'tolong baca readme lalu tulis catatan');
  console.log('finished:', await until(async () => /Selesai/.test(await lastAssistant(chat))));
  console.log('final answer handled by the panel:', await until(async () => (await finals()) >= 2));
  const rows = () => page.locator('#cmdLog [data-log-tool="fs.writeFile"][data-log-status="ok"]').count();
  const before = await rows();
  const dom = () => chat.evaluate(() => [...document.querySelectorAll('[data-virtual-list-item-key]')].map((w) => w.getAttribute('data-virtual-list-item-key') + ':' + (w.querySelector('.ds-assistant-message-main-content') ? 'A ' : 'U ') + w.innerText.replace(/\s+/g, ' ').slice(0, 40)));
  console.log('dom before:', JSON.stringify(await dom(), null, 1));
  console.log('left in dom:', await chat.evaluate(() => window.__scrollAwayNewest()));
  console.log('dom after :', JSON.stringify(await dom(), null, 1));
  await new Promise((r) => setTimeout(r, 9000));
  console.log('writes before/after:', before, await rows());
  console.log((await page.locator('#cmdLog').innerText()).split('\n').slice(-12).join('\n'));
} finally {
  await ctx.close();
  bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

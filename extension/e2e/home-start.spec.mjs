// home-start.spec.mjs - focused check of Home's Start Session: it switches to the Agent tab at
// once, the start shows there (status line, Stop button) and Home mirrors it; Stop cancels a
// start that is still waiting, and stops a running session from either tab.
// Uses the real bridge (for the workspace and the agent prompt) and the fake chat page.
// Run: npm run build -w @broagentai/extension && npm run e2e:home -w @broagentai/extension
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealBridge, attachBridge } from './real-bridge.mjs';
import { routeFakeChat } from './fake-chat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-home-'));
const configDir = path.join(tmp, 'config');
const ws = path.join(tmp, 'home-project');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, 'README.md'), '# Home\n');

const results = [];
function check(name, ok, detail = '') {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`);
}
async function until(fn, timeout = 6000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value; try { value = await fn(); } catch { value = null; }
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const bridge = startRealBridge({ configDir });
const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let failed = true;
try {
  await attachBridge(ctx, bridge);
  await routeFakeChat(ctx);
  const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${worker.url().split('/')[2]}/src/sidepanel.html`);

  const visible = (sel) => page.locator(sel).first().isVisible();
  const text = (sel) => page.locator(sel).first().innerText();
  const agentActive = async () => (await page.locator('#tab-agent.active').count()) === 1;
  const homeState = () => page.locator('#homeStart').getAttribute('data-state');
  const goHome = () => page.locator('.rail-btn[data-tab="home"]').click();

  await until(async () => /Host (ready|siap)/.test(await text('#hostPill')));
  await page.locator('#homeBody [data-act="open-folder"]').first().click();
  await page.locator('#wsPath').fill(ws);
  await page.locator('#modalOk').click();
  await until(async () => (await page.locator('.home-ws.active').count()) === 1);
  await page.locator('.prov-card[data-prov="deepseek"]').click();

  // 1. Start, then cancel while the chat page is still "loading".
  await page.locator('#homeStart').click();
  check('Start switches to the Agent tab at once', await agentActive());
  check('Agent tab shows Stop instead of Start while starting', await visible('#agentStop') && !(await visible('#agentStart')));
  check('Agent status line shows the start with a countdown',
    await until(async () => await visible('#agentStatus') && /Menunggu DeepSeek termuat - \d+s/.test(await text('#agentStatusText'))),
    await text('#agentStatusText').catch(() => '(hidden)'));
  check('agent pill says the session is starting', /Memulai sesi/.test(await text('#agentSession')));
  check('Home mirrors the start as Stop Session', (await homeState()) === 'starting' && /Hentikan Sesi/.test(await text('#homeStart')));
  await page.locator('#agentStop').click();
  check('Stop cancels a start that is still waiting',
    await until(async () => await visible('#agentStart') && !(await visible('#agentStatus'))));
  check('cancel is logged', /dibatalkan sebelum sesi tersambung/.test(await text('#cmdLog')));
  check('Home is back to Start after cancel', (await homeState()) === 'idle');
  const chatTabsAfterCancel = ctx.pages().filter((p) => p.url().startsWith('https://chat.deepseek.com')).length;
  await page.waitForTimeout(11_000); // the cancelled wait must not connect later
  check('cancelled start never connects', (await homeState()) === 'idle' && !/session\.start.*tools dikirim/s.test(await text('#cmdLog')));

  // 2. Start and let it connect.
  await page.bringToFront();
  await goHome();
  await page.locator('#homeStart').click();
  const chatTabs = () => ctx.pages().filter((p) => p.url().startsWith('https://chat.deepseek.com'));
  check('second Start opens another chat tab', await until(() => chatTabs().length === chatTabsAfterCancel + 1));
  // Playwright's route does not catch the first load of a tab the extension opened itself,
  // so load the fake chat into it again (inside the 10s wait) the way a real page would load.
  await chatTabs().at(-1).goto('https://chat.deepseek.com/');
  check('session connects after the wait',
    await until(async () => /Sesi aktif - DeepSeek/.test(await text('#agentSession')), 20_000), await text('#agentSession'));
  check('status line moves on to the AI reply', /Menunggu balasan AI|Selesai/.test(await text('#agentStatusText')), await text('#agentStatusText'));
  check('Home shows Stop Session for the running session', (await homeState()) === 'active');

  // 3. Stop from Home.
  await page.bringToFront();
  await goHome();
  await page.locator('#homeStart').click();
  check('Stop Session on Home stops the session', await until(async () => (await homeState()) === 'idle'));
  await page.locator('.rail-btn[data-tab="agent"]').click();
  check('Agent tab shows Start again', await visible('#agentStart') && /Belum ada sesi/.test(await text('#agentSession')));

  check('no page errors', errors.length === 0, errors.join('; '));
  failed = results.includes(false);
} finally {
  await ctx.close();
  bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

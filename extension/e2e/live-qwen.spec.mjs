// live-qwen.spec.mjs - opt-in end-to-end run of the agent loop against the LIVE chat.qwen.ai.
// Run: npm run e2e:live:qwen        (from the repo root; builds first)
//
// Unlike sidepanel.spec.mjs nothing is routed or faked on the chat side: the
// built extension talks to the real Qwen site and the real broagentai-bridge
// (only the native-messaging pipe is replaced, see real-bridge.mjs). The AI's
// answers are not scripted, so this is a smoke check, not part of `npm run e2e`.
//
// Login: the browser profile lives in e2e/.pw-qwen-profile (gitignored). On the
// first run the script opens chat.qwen.ai in a visible window and waits until
// you have logged in by hand; it never types credentials. Later runs reuse the
// session. Set QWEN_LOGIN_TIMEOUT_MS to wait longer than 10 minutes.
//
// Exit code 0 = Qwen read LICENSE and wrote qwen-check.txt byte-identical.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealBridge, attachBridge } from './real-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profileDir = path.join(root, 'e2e', '.pw-qwen-profile');
const shots = path.join(root, 'e2e', 'shots');
fs.mkdirSync(shots, { recursive: true });

const QWEN_URL = 'https://chat.qwen.ai/';
const COMPOSER = 'textarea.message-input-textarea'; // keep in sync with providers/qwen/provider.json
const LOGIN_TIMEOUT_MS = Number(process.env.QWEN_LOGIN_TIMEOUT_MS) || 10 * 60_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;
const TASK = 'Baca LICENSE, lalu tulis seluruh isinya persis apa adanya ke file qwen-check.txt.';

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.log('extension/dist is missing - run `npm run build` first (npm run e2e:live:qwen does).');
  process.exit(1);
}

// ---------------------------------------------------------------- fixtures
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-live-qwen-'));
const configDir = path.join(tmp, 'config');
const ws = path.join(tmp, 'qwen-live-ws');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
const LICENSE = `MIT License

Copyright (c) 2026 BroAgentAI live check

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
fs.writeFileSync(path.join(ws, 'LICENSE'), LICENSE);
const target = path.join(ws, 'qwen-check.txt');

// ---------------------------------------------------------------- harness
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
async function until(fn, timeout = 15000, interval = 250) {
  const deadline = Date.now() + timeout;
  let value;
  for (;;) {
    try { value = await fn(); } catch { value = null; }
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, interval));
  }
}
const text = (page, sel) => page.locator(sel).innerText().catch(() => '');
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

/** Logged in = the composer is there and the guest-only Log in / Sign up buttons are gone. */
async function loggedIn(chat) {
  if (!(await chat.locator(COMPOSER).first().isVisible().catch(() => false))) return false;
  const guestButtons = chat.locator('button, a, [role="button"]').filter({ hasText: /^\s*(Log in|Sign up)\s*$/i });
  for (const el of await guestButtons.all()) if (await el.isVisible().catch(() => false)) return false;
  return true;
}

const bridge = startRealBridge({ configDir });
const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: 'chromium', // branded Chrome ignores --load-extension
  headless: false,     // the first run needs a visible window for the manual login
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--disable-blink-features=AutomationControlled'],
});
let exitCode = 1;
let chat;
let panel;
try {
  await attachBridge(ctx, bridge);
  let worker = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extId = worker ? worker.url().split('/')[2] : null;
  check('extension service worker starts', !!extId);

  // ---- 1. Qwen tab, logged in (by hand on the first run)
  chat = ctx.pages()[0] ?? await ctx.newPage();
  await chat.goto(QWEN_URL, { waitUntil: 'domcontentloaded' });
  if (!(await until(() => loggedIn(chat), 20000, 500))) {
    console.log(`\n>>> Log in to Qwen in the opened browser window (waiting up to ${Math.round(LOGIN_TIMEOUT_MS / 60000)} min).`);
    console.log('>>> The script continues by itself once the chat page shows the composer without a "Log in" button.\n');
    await chat.bringToFront();
    const ok = await until(async () => {
      if (!chat.url().startsWith(QWEN_URL)) return false; // still on an auth page
      return loggedIn(chat);
    }, LOGIN_TIMEOUT_MS, 1000);
    check('user is logged in to Qwen', ok, 'login timed out');
    await chat.goto(QWEN_URL, { waitUntil: 'domcontentloaded' }); // fresh chat after the auth redirects
  }
  check('Qwen composer is ready (logged in)', await until(() => loggedIn(chat), 30000, 500));

  // ---- 2. side panel as a tab, real bridge, throwaway workspace
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel.html`);
  check('host is ready', await until(async () => /Host (ready|siap)/.test(await text(panel, '#hostPill'))), await text(panel, '#hostPill'));
  await panel.locator('#wsBtn').click();
  await panel.locator('#wsMenu [data-act="open-folder"]').click();
  await panel.locator('#wsPath').waitFor({ state: 'visible', timeout: 6000 });
  await panel.locator('#wsPath').fill(ws);
  await panel.locator('#modalOk').click();
  check('workspace is opened', await until(async () => /qwen-live-ws/.test(await text(panel, '#headerWs'))), await text(panel, '#headerWs'));

  // ---- 3. agent session in Auto Approve mode
  const logRow = (tool, status) => panel.locator(`#cmdLog [data-log-tool="${tool}"][data-log-status="${status}"]`);
  const idle = () => visible(panel, '#agentStatus[data-phase="idle"]');
  const failed = () => visible(panel, '#agentStatus[data-phase="failed"]');
  await panel.locator('.rail-btn[data-tab="agent"]').click();
  await panel.locator('#modeSel').selectOption('auto-approve');
  check('Qwen tab is detected', await until(async () => /Qwen/.test(await text(panel, '#detectedChat'))), await text(panel, '#detectedChat'));
  // From here on the chat tab stays in front: a hidden tab gets no animation
  // frames, and Qwen renders its replies (Monaco code blocks) with them.
  // Playwright still drives the panel tab in the background.
  await chat.bringToFront();
  await panel.locator('#agentStart').click();
  check('session starts', await until(async () => /Sesi aktif - Qwen/.test(await text(panel, '#agentSession'))), await text(panel, '#toast'));
  check('Qwen answers the operating prompt',
    await until(async () => (await logRow('assistant', 'info').count()) >= 1 && await idle(), REPLY_TIMEOUT_MS, 1000),
    await text(panel, '#cmdLog'));

  // ---- 4. the task, typed into Qwen as the user would
  await chat.locator(COMPOSER).first().fill(TASK);
  await chat.locator(COMPOSER).first().press('Enter');
  console.log('... task sent, waiting for Qwen to read and write');
  check('fs.readFile of LICENSE runs', await until(() => logRow('fs.readFile', 'ok').first().isVisible(), REPLY_TIMEOUT_MS, 1000), await text(panel, '#cmdLog'));
  check('fs.writeFile runs', await until(async () => (await logRow('fs.writeFile', 'ok').count()) >= 1 || await failed(), REPLY_TIMEOUT_MS, 1000)
    && (await logRow('fs.writeFile', 'ok').count()) >= 1, await text(panel, '#cmdLog'));
  check('Qwen gives its final reply', await until(async () => (await idle()) || (await failed()), REPLY_TIMEOUT_MS, 1000) && await idle(),
    await text(panel, '#agentStatus'));

  // ---- 5. the result on disk
  const written = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const expected = fs.readFileSync(path.join(ws, 'LICENSE'));
  check('qwen-check.txt is byte-identical to LICENSE', written !== null && written.equals(expected),
    written === null ? '(missing)' : `wrote ${written.length} bytes, expected ${expected.length}; first difference at byte ${[...expected].findIndex((b, i) => written[i] !== b)}`);

  await panel.locator('#agentStop').click();
  console.log(`\n${results.length}/${results.length} checks passed`);
  exitCode = 0;
} catch (error) {
  if (!/^check failed/.test(error?.message)) console.log('ABORTED: ' + (error?.stack || error));
  if (panel) console.log('ACTIVITY LOG\n' + (await text(panel, '#cmdLog')));
  console.log('BRIDGE STDERR (tail)\n' + bridge.state.stderr.slice(-1500));
  await panel?.screenshot({ path: path.join(shots, 'live-qwen-panel.png'), fullPage: true }).catch(() => {});
  await chat?.screenshot({ path: path.join(shots, 'live-qwen-chat.png') }).catch(() => {});
  console.log('Screenshots: e2e/shots/live-qwen-*.png');
} finally {
  await ctx.close().catch(() => {});
  bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);

// native-host.spec.mjs - e2e through the browser's REAL native-messaging pipe.
//
// sidepanel.spec.mjs replaces chrome.runtime.connectNative; this spec does not.
// It registers com.broagentai.host for the test Chromium with the project's own
// installer (scripts/native-host.mjs), so it covers: installer output, registry
// lookup, the launcher, allowed_origins vs the real extension id, and stdio
// framing as the browser speaks it. The registration points at a throwaway
// config dir and is removed again when the run ends.
// Run: npm run build && npm run e2e:native -w @broagentai/extension
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_CHAT_URL, routeFakeChat, say, lastAssistant } from './fake-chat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..');
const dist = path.join(root, 'dist');
const installer = path.join(repoRoot, 'scripts', 'native-host.mjs');
const shots = path.join(root, 'e2e', 'shots');
fs.mkdirSync(shots, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-native-'));
const workspace = path.join(tmp, 'native-project');
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello native host\n');
fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), 'export const viaNativeHost = true;\n');

const installerArgs = [
  '--browser', 'chromium',
  '--manifest-dir', path.join(tmp, 'manifest'),
  '--launcher', path.join(tmp, process.platform === 'win32' ? 'host.cmd' : 'host.sh'),
];
const runInstaller = (command, extra = []) =>
  execFileSync(process.execPath, [installer, command, ...installerArgs, ...extra], { encoding: 'utf8' });

const results = [];
const pageErrors = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`);
}
async function until(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  for (;;) {
    try { value = await fn(); } catch { value = null; }
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

let ctx;
let exitCode = 1;
try {
  console.log(runInstaller('install', [
    '--env', `BROAGENTAI_CONFIG_DIR=${path.join(tmp, 'config')}`,
    '--env', 'BROAGENTAI_DISABLE_DIALOG=1',
  ]).trim());

  ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { // fresh profile: no state leaks between runs
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extId = worker ? worker.url().split('/')[2] : null;
  check('extension service worker starts', !!extId);
  if (!extId) throw new Error('no extension id');

  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()); });
  await page.goto(`chrome-extension://${extId}/src/sidepanel.html`);
  const text = (sel) => page.locator(sel).innerText();

  check('host answers system.ping over real native messaging',
    await until(async () => /Host (ready|siap)/.test(await text('#hostPill'))), await text('#hostPill'));
  check('offline banner hidden', !(await page.locator('#banner').isVisible()));

  // Home is the default view; the file tree lives in Explorer.
  await page.locator('.rail-btn[data-tab="home"]').click();
  await page.locator('#homeOpenFolder').click();
  await page.locator('#wsPath').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#wsPath').fill(workspace);
  await page.locator('#modalOk').click();
  await page.locator('.rail-btn[data-tab="explorer"]').click();
  check('workspace.add works through the native host',
    await until(async () => /native-project/.test(await text('#headerWs'))), await text('#headerWs'));
  check('fs.listTree works through the native host',
    await until(() => page.locator('.ba-tree-file[data-path="hello.txt"]').isVisible()), await text('#tree'));

  // Files open in the editor tab (editor.html), which talks to the native host itself.
  const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.locator('.ba-tree-file[data-path="hello.txt"]').click()]);
  await tab.waitForLoadState('domcontentloaded');
  check('fs.readFileLines works through the native host',
    await until(async () => (await tab.evaluate(() => [...document.querySelectorAll('#edArea .cm-line')].map((l) => l.textContent).join(String.fromCharCode(10)))).replace(/\n$/, '') === 'hello native host'));
  await tab.locator('#edArea .cm-content').click();
  await tab.keyboard.press('Control+A');
  await tab.keyboard.insertText('saved through native host\n');
  await tab.locator('#btnSave').click();
  check('fs.writeFile works through the native host',
    await until(() => fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8') === 'saved through native host\n'));

  await page.locator('.rail-btn[data-tab="search"]').click();
  await page.locator('#searchInput').fill('viaNativeHost');
  check('fs.searchFiles works through the native host',
    await until(async () => /Ditemukan 1 match di 1 file/.test(await text('#searchInfo'))), await text('#searchInfo'));

  await page.locator('.rail-btn[data-tab="terminal"]').click();
  await until(async () => /native-project/.test(await text('#termStatus')), 15000);
  await page.locator('#termView').click();
  await page.keyboard.type(process.platform === 'win32' ? 'Write-Output "$(6*7)-native-pty"' : 'echo "$((6*7))-native-pty"');
  await page.keyboard.press('Enter');
  check('terminal events stream through the native host',
    await until(async () => /42-native-pty/.test(await page.evaluate(() => window.__broagentaiTermText?.() ?? '')), 15000),
    await text('#termStatus'));
  await page.locator('#termKill').click();
  await until(async () => /tertutup/.test(await text('#termStatus')), 10000);

  // Agent relay with the real native host executing the tools.
  await routeFakeChat(ctx);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Native readme\n');
  const chat = await ctx.newPage();
  await chat.goto(FAKE_CHAT_URL);
  await page.bringToFront();
  await page.locator('.rail-btn[data-tab="agent"]').click();
  await page.locator('#agentStart').click();
  await until(async () => /Sesi aktif/.test(await text('#agentSession')), 15000);
  await page.locator('#modeSel').selectOption('auto-approve');
  await say(chat, 'tolong baca readme lalu tulis catatan');
  check('agent loop reads and writes through the native host',
    await until(() => fs.existsSync(path.join(workspace, 'notes-from-ai.txt'))
      && fs.readFileSync(path.join(workspace, 'notes-from-ai.txt'), 'utf8').includes('# Native readme'), 20000),
    await text('#cmdLog'));
  check('agent loop returns the result to the chat',
    await until(async () => /Selesai/.test(await lastAssistant(chat)), 15000), await lastAssistant(chat));
  await page.locator('#agentStop').click();
  await chat.close();
  await page.bringToFront();

  check('host persisted its config in the isolated config dir',
    fs.existsSync(path.join(tmp, 'config', 'config.json')), fs.readdirSync(tmp).join(','));
  await page.screenshot({ path: path.join(shots, 'native-host.png'), fullPage: true });
  check('no page raised an error', pageErrors.length === 0, JSON.stringify(pageErrors, null, 2));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.log('ABORTED: ' + (error?.stack || error));
  console.log('PAGE ERRORS ' + JSON.stringify(pageErrors, null, 2));
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { runInstaller('uninstall'); } catch (error) { console.log('cleanup failed: ' + error.message); }
  // The host may hold the launcher for a moment after the browser exits.
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(exitCode);

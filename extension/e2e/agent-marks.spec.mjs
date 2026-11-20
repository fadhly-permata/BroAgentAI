// agent-marks.spec.mjs - focused check of how agent-typed messages look on the chat page:
// collapsed by default, click to expand / collapse, monospace font, state kept when a
// virtualized list re-creates the node. Needs no bridge; only the content script runs.
// Run: npm run build -w @broagentai/extension && npm run e2e:marks -w @broagentai/extension
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_CHAT_URL, routeFakeChat, say } from './fake-chat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-marks-'));

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

const TOOL_RESULT = '[BroAgentAI tool result] fs.readFile OK\n\n' + Array.from({ length: 6 }, (_, i) => `line ${i + 1} of the file`).join('\n');
const USER_TEXT = 'tolong baca readme';

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let failed = true;
try {
  await routeFakeChat(ctx);
  const chat = await ctx.newPage();
  const errors = [];
  chat.on('pageerror', (e) => errors.push(e.message));
  await chat.goto(FAKE_CHAT_URL);
  await say(chat, USER_TEXT);
  await say(chat, TOOL_RESULT);

  const agent = chat.locator('.user', { hasText: '[BroAgentAI tool result]' }).first();
  const own = chat.locator('.user', { hasText: USER_TEXT }).first();
  const height = (loc) => loc.evaluate((el) => el.getBoundingClientRect().height);
  const collapsed = (loc) => loc.evaluate((el) => el.hasAttribute('data-ba-collapsed'));
  const font = (loc) => loc.evaluate((el) => getComputedStyle(el).fontFamily);

  check('agent message is marked', await until(async () => (await agent.getAttribute('data-ba-agent')) === 'result'));
  check('agent message starts collapsed', await collapsed(agent));
  check('collapsed agent message is at most 60px tall (label strip + one line)', (await height(agent)) <= 60, String(await height(agent)));
  check("user's own message is not marked or collapsed", (await own.getAttribute('data-ba-agent')) === null && !(await collapsed(own)));
  check('agent message uses a monospace font', /Cascadia|Consolas|monospace/i.test(await font(agent)), await font(agent));
  check("user's own message keeps the page font", !/Cascadia|Consolas/i.test(await font(own)), await font(own));

  await agent.click({ position: { x: 20, y: 30 } });
  check('click expands a collapsed agent message', !(await collapsed(agent)) && (await height(agent)) > 60, String(await height(agent)));
  const h = await height(agent);
  await agent.click({ position: { x: 20, y: Math.min(h - 6, 70) } });
  check('click below the label strip leaves it expanded', !(await collapsed(agent)));
  await agent.click({ position: { x: 20, y: 8 } });
  check('click on the label strip collapses it again', await collapsed(agent));

  // Virtualized list: the node is dropped and re-created with the same text.
  await agent.click({ position: { x: 20, y: 30 } });
  await chat.evaluate(() => {
    const old = [...document.querySelectorAll('.user')].find((el) => el.textContent.startsWith('[BroAgentAI tool result]'));
    const copy = document.createElement('div');
    copy.className = 'user';
    copy.textContent = old.textContent;
    old.replaceWith(copy);
  });
  check('re-created node is marked again', await until(async () => (await agent.getAttribute('data-ba-agent')) === 'result'));
  check('re-created node keeps the expanded state', !(await collapsed(agent)));

  check('no page errors', errors.length === 0, errors.join('; '));
  const shots = path.join(root, 'e2e', 'shots');
  fs.mkdirSync(shots, { recursive: true });
  await chat.screenshot({ path: path.join(shots, 'chat-agent-expanded.png'), fullPage: true });
  await agent.click({ position: { x: 20, y: 8 } });
  await chat.mouse.move(600, 600);
  await chat.screenshot({ path: path.join(shots, 'chat-agent-collapsed.png'), fullPage: true });
  failed = results.includes(false);
} finally {
  await ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

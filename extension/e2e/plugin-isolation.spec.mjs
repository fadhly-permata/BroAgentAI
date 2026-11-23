import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'plugin-isolation');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-plugin-isolation-'));
const results = [];

function check(name, ok, detail = '') {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`);
}

async function until(fn, timeout = 6000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function fakePage(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><textarea></textarea><div class="reply"></div></body></html>`;
}

let failed = true;
let ctx;
try {
  ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`],
  });
  await ctx.route('https://chat-a.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fakePage('Fake chat A') }));
  await ctx.route('https://chat-b.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fakePage('Fake chat B') }));

  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const errors = [];
  a.on('pageerror', (e) => errors.push('A: ' + e.message));
  b.on('pageerror', (e) => errors.push('B: ' + e.message));
  await a.goto('https://chat-a.example.test/');
  await b.goto('https://chat-b.example.test/');

  check('plugin A runs only on domain A', await until(async () => (await a.locator('[data-ba-plugin-marker]').getAttribute('data-ba-plugin-marker')) === 'plugin-a'));
  check('plugin B runs only on domain B', await until(async () => (await b.locator('[data-ba-plugin-marker]').getAttribute('data-ba-plugin-marker')) === 'plugin-b'));
  check('plugin A CSS is applied on domain A', (await a.locator('[data-ba-plugin-marker]').evaluate((el) => getComputedStyle(el).color)) === 'rgb(0, 128, 0)');
  check('plugin B CSS is applied on domain B', (await b.locator('[data-ba-plugin-marker]').evaluate((el) => getComputedStyle(el).color)) === 'rgb(128, 0, 128)');
  check("plugin B never touches domain A", (await a.locator('[data-ba-plugin-marker="plugin-b"]').count()) === 0);
  check("plugin A never touches domain B", (await b.locator('[data-ba-plugin-marker="plugin-a"]').count()) === 0);

  await a.goto('https://chat-b.example.test/');
  check('navigating a tab to the other domain swaps the plugin', await until(async () => (await a.locator('[data-ba-plugin-marker]').getAttribute('data-ba-plugin-marker')) === 'plugin-b'));
  check('no page errors', errors.length === 0, errors.join('; '));

  const { planInstall, patternsOverlap } = await import(new URL('../src/plugins/conflicts.ts', import.meta.url).href);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(fixture, name), 'utf8'));
  const pluginA = read('plugin-a.json');
  const pluginB = read('plugin-b.json');
  const installed = [
    { manifest: pluginA, source: 'builtin', enabled: true },
    { manifest: pluginB, source: 'user', enabled: true },
  ];
  check('distinct domains do not overlap', !patternsOverlap(pluginA.matches[0], pluginB.matches[0]));
  const conflicting = { ...pluginA, id: 'plugin-c', matches: [pluginA.matches[0], pluginB.matches[0]] };
  const plan = planInstall(conflicting, installed);
  check('domain conflict is detected for an overlapping import', plan.kind !== 'idClash' && plan.domainConflicts.some((c) => c.id === 'plugin-b'), JSON.stringify(plan));
  const clash = planInstall({ ...pluginB, id: pluginA.id }, installed);
  check('same id on other domains is an id clash, not an update', clash.kind === 'idClash');
  failed = results.includes(false);
} finally {
  await ctx?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

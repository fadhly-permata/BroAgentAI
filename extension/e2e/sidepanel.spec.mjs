// sidepanel.spec.mjs - end-to-end run of the built extension against the REAL bridge.
// Run: npm run build && npm run e2e -w @broagentai/extension
// Exit code 0 = every check passed and no page raised an error.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealBridge, attachBridge } from './real-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const shots = path.join(root, 'e2e', 'shots');
fs.mkdirSync(shots, { recursive: true });

// ---------------------------------------------------------------- fixtures
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broagentai-e2e-'));
const configDir = path.join(tmp, 'config');
const wsA = path.join(tmp, 'alpha-project');
const wsB = path.join(tmp, 'beta-project');
const write = (base, rel, content) => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const SIDEPANEL_SRC = '// alpha sidepanel\nexport const answer = 42;\n';
write(wsA, 'README.md', '# Alpha\nneedle one\nneedle two\nNothing here\n');
write(wsA, 'src/sidepanel.ts', SIDEPANEL_SRC);
write(wsA, 'src/deep/util.ts', 'export const util = "needle three";\n');
write(wsA, 'node_modules/pkg/index.js', 'module.exports = "needle ignored";\n');
write(wsA, 'image.bin', Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01, 0x02]));
write(wsB, 'beta-only.txt', 'beta file\n');
fs.mkdirSync(configDir, { recursive: true });

// ---------------------------------------------------------------- harness
const results = [];
const pageErrors = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`);
}
/** Poll `fn` until it returns a truthy value; returns it (or the last falsy value). */
async function until(fn, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let value;
  for (;;) {
    try { value = await fn(); } catch { value = null; }
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${label} console.error: ${m.text()}`); });
}
const text = (page, sel) => page.locator(sel).innerText();
const visible = (page, sel) => page.locator(sel).first().isVisible();
const toastHas = (page, re) => until(async () => re.test(await text(page, '#toast')) && await visible(page, '#toast'));

const bridge = startRealBridge({ configDir });
const ctx = await chromium.launchPersistentContext(path.join(root, 'e2e', '.pw-profile'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let exitCode = 1;
try {
  await attachBridge(ctx, bridge);
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extId = worker ? worker.url().split('/')[2] : null;
  check('extension service worker starts', !!extId);
  if (!extId) throw new Error('no extension id');
  const panelUrl = `chrome-extension://${extId}/src/sidepanel.html`;

  const page = await ctx.newPage();
  watch(page, 'panel');
  page.on('dialog', (d) => d.accept());
  await page.goto(panelUrl);

  // ---- 1. boot + host handshake
  check('title is BroAgentAI', (await page.title()) === 'BroAgentAI');
  check('host pill shows ready after real system.ping',
    await until(async () => /Host ready/.test(await text(page, '#hostPill'))), await text(page, '#hostPill'));
  check('offline banner hidden when host is up', !(await visible(page, '#banner')));
  check('tree asks for a workspace when none exists',
    await until(async () => /Pilih workspace/.test(await text(page, '#tree'))), await text(page, '#tree'));

  // ---- 2. rail tabs
  for (const tab of ['explorer', 'search', 'scm', 'agent', 'settings']) {
    await page.locator(`.rail-btn[data-tab="${tab}"]`).click();
    check(`tab ${tab} activates`, (await page.locator(`#tab-${tab}.active`).count()) === 1);
    await page.screenshot({ path: path.join(shots, `tab-${tab}.png`), fullPage: true });
  }
  await page.locator('.rail-btn[data-tab="explorer"]').click();

  // ---- 3. add workspace through the UI (native dialog disabled -> manual path)
  async function addWorkspaceViaUi(dir) {
    await page.locator('#wsBtn').click();
    await page.locator('#wsMenu [data-act="open-folder"]').click();
    await page.locator('#wsPath').waitFor({ state: 'visible', timeout: 6000 });
    await page.locator('#wsPath').fill(dir);
    await page.locator('#modalOk').click();
  }
  await addWorkspaceViaUi(wsA);
  check('header shows the added workspace',
    await until(async () => /alpha-project/.test(await text(page, '#headerWs'))), await text(page, '#headerWs'));
  const fileRow = (rel) => page.locator(`.ba-tree-file[data-path="${rel}"]`);
  const dirRow = (rel) => page.locator(`.ba-tree-dir[data-path="${rel}"]`);
  check('tree lists real root files', await until(() => fileRow('README.md').isVisible()), await text(page, '#tree'));
  check('tree lists real root folders', await dirRow('src').isVisible());
  check('ignored folder node_modules is not listed', (await page.locator('[data-path="node_modules"]').count()) === 0);
  check('first-run checklist marks workspace done', (await text(page, '#ckWs')) === 'x');

  // ---- 4. expand / collapse / re-expand
  await dirRow('src').click();
  check('expanding a folder loads its children', await until(() => fileRow('src/sidepanel.ts').isVisible()));
  await dirRow('src').click();
  check('collapsing a folder hides its children', await until(async () => (await fileRow('src/sidepanel.ts').count()) === 0));
  await dirRow('src').click();
  await until(() => fileRow('src/sidepanel.ts').isVisible());
  check('re-expanding does not duplicate rows', (await fileRow('src/sidepanel.ts').count()) === 1,
    'count=' + await fileRow('src/sidepanel.ts').count());
  await dirRow('src/deep').click();
  check('nested folder expands', await until(() => fileRow('src/deep/util.ts').isVisible()));

  // ---- 5. open, edit, save
  await fileRow('src/sidepanel.ts').click();
  check('file opens in the preview editor', await until(() => visible(page, '#editorPreview')));
  check('editor shows the real file content',
    await until(async () => (await page.locator('#edArea').inputValue()) === SIDEPANEL_SRC),
    JSON.stringify(await page.locator('#edArea').inputValue()));
  const edited = SIDEPANEL_SRC + '// edited by e2e\n';
  await page.locator('#edArea').fill(edited);
  check('editing marks the file dirty', /dirty/.test(await text(page, '#edDirty')));
  await page.locator('#edSave').click();
  check('save reports success', await toastHas(page, /File tersimpan/), await text(page, '#toast'));
  check('save writes the file on disk', fs.readFileSync(path.join(wsA, 'src/sidepanel.ts'), 'utf8') === edited);
  check('dirty marker clears after save', (await text(page, '#edDirty')) === '');

  // ---- 6. external change -> MTIME_CONFLICT, disk untouched
  await new Promise((r) => setTimeout(r, 50));
  const external = '// changed outside the panel\n';
  fs.writeFileSync(path.join(wsA, 'src/sidepanel.ts'), external);
  fs.utimesSync(path.join(wsA, 'src/sidepanel.ts'), new Date(), new Date(Date.now() + 5000));
  await page.locator('#edArea').fill('// would clobber\n');
  await page.locator('#edSave').click();
  check('conflicting save is refused', await toastHas(page, /Konflik/), await text(page, '#toast'));
  check('conflicting save leaves disk content alone', fs.readFileSync(path.join(wsA, 'src/sidepanel.ts'), 'utf8') === external);
  await page.locator('#edClose').click();
  check('editor preview closes', await until(async () => !(await visible(page, '#editorPreview'))));

  // ---- 7. binary file is refused with a message, not garbage
  await fileRow('image.bin').click();
  check('binary file shows an error toast', await toastHas(page, /Gagal membuka file/), await text(page, '#toast'));
  check('binary file does not open the editor', !(await visible(page, '#editorPreview')));

  // ---- 8. search
  await page.locator('.rail-btn[data-tab="search"]').click();
  const searchInfo = (re) => until(async () => re.test(await text(page, '#searchInfo')));
  await page.locator('#searchInput').fill('needle');
  check('search finds every match incl. consecutive lines, skipping ignored dirs',
    await searchInfo(/Ditemukan 3 match di 2 file/), await text(page, '#searchInfo'));
  await page.locator('#searchInput').fill('NEEDLE');
  check('search is case-insensitive by default', await searchInfo(/Ditemukan 3 match/), await text(page, '#searchInfo'));
  await page.locator('#caseChk').check();
  check('case-sensitive toggle is honoured', await searchInfo(/Tidak ada hasil/), await text(page, '#searchInfo'));
  await page.locator('#caseChk').uncheck();
  await page.locator('#regexChk').check();
  await page.locator('#searchInput').fill('needle (one|three)');
  check('regex toggle is honoured', await searchInfo(/Ditemukan 2 match di 2 file/), await text(page, '#searchInfo'));
  await page.locator('#searchInput').fill('needle (');
  check('invalid regex shows an inline error', await until(() => visible(page, '#searchErr')), await text(page, '#searchErr'));
  await page.locator('#regexChk').uncheck();
  await page.locator('#searchInput').fill('needle three');
  await searchInfo(/Ditemukan 1 match di 1 file/);
  await page.screenshot({ path: path.join(shots, 'search-results.png'), fullPage: true });

  // ---- 9. search hit opens the CodeMirror editor tab; save from there
  const [editorPage] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 10000 }),
    page.locator('.search-match[data-file="src/deep/util.ts"]').click(),
  ]);
  watch(editorPage, 'editor');
  await editorPage.waitForLoadState('domcontentloaded');
  check('editor tab loads editor.html', /src\/editor\.html\?path=/.test(editorPage.url()), editorPage.url());
  check('CodeMirror shows the real file',
    await until(async () => /needle three/.test(await editorPage.locator('.cm-content').innerText())),
    await editorPage.locator('#statusMsg').innerText().catch(() => '(no status)'));
  check('editor file name is shown', (await editorPage.locator('#fileName').innerText()) === 'util.ts');
  await editorPage.locator('.cm-content').click();
  await editorPage.keyboard.press('Control+End');
  await editorPage.keyboard.type('// typed in codemirror');
  check('typing marks the editor unsaved',
    await until(async () => /belum disimpan/.test(await editorPage.locator('#statusMsg').innerText())));
  await editorPage.locator('#btnSave').click();
  check('editor save reports success',
    await until(async () => /^Tersimpan/.test(await editorPage.locator('#statusMsg').innerText())),
    await editorPage.locator('#statusMsg').innerText());
  check('editor save writes the file on disk',
    fs.readFileSync(path.join(wsA, 'src/deep/util.ts'), 'utf8').includes('// typed in codemirror'));
  await editorPage.screenshot({ path: path.join(shots, 'editor.png'), fullPage: true });
  await editorPage.close();

  // ---- 10. second workspace, switch, rename, remove
  await page.locator('.rail-btn[data-tab="explorer"]').click();
  await addWorkspaceViaUi(wsB);
  check('adding a second workspace switches the tree to it',
    await until(() => fileRow('beta-only.txt').isVisible()), await text(page, '#tree'));
  await page.locator('#wsBtn').click();
  check('workspace menu lists both workspaces', (await page.locator('#wsList [data-ws]').count()) === 2);
  await page.locator('#wsList [data-ws]', { hasText: 'alpha-project' }).click();
  check('switching workspace re-renders the tree',
    await until(async () => (await fileRow('README.md').isVisible()) && (await fileRow('beta-only.txt').count()) === 0),
    await text(page, '#tree'));
  check('bridge agrees on the active workspace',
    (await bridge.call('workspace.list')).workspaces.find((w) => w.path.endsWith('alpha-project'))?.id
      === (await bridge.call('workspace.list')).activeWorkspaceId);

  await page.locator('#wsBtn').click();
  await page.locator('#wsMenu [data-act="manage"]').click();
  check('manage opens Settings > Workspaces', await until(() => visible(page, '#manageList')));
  await page.locator('#manageList .card', { hasText: 'beta-project' }).locator('[data-rename]').click();
  await page.locator('#wsName').fill('Beta Renamed');
  await page.locator('#modalOk').click();
  check('rename is persisted by the bridge',
    await until(async () => (await bridge.call('workspace.list')).workspaces.some((w) => w.name === 'Beta Renamed')));
  check('rename is reflected in the list', await until(async () => /Beta Renamed/.test(await text(page, '#manageList'))));
  await page.locator('#manageList .card', { hasText: 'Beta Renamed' }).locator('[data-remove]').click();
  check('remove drops the workspace',
    await until(async () => (await page.locator('#manageList .card').count()) === 1), await text(page, '#manageList'));
  check('remove never deletes files on disk', fs.existsSync(path.join(wsB, 'beta-only.txt')));

  // ---- 11. agent approval flow
  await page.locator('.rail-btn[data-tab="agent"]').click();
  await page.locator('#simulateBtn').click();
  check('approval card appears in Ask mode', await until(() => visible(page, '#approvalCard')));
  await page.locator('#apAllow').click();
  check('approval card closes after Allow', await until(async () => !(await visible(page, '#approvalCard'))));
  check('activity log records the tool call', /fs\.writeFile/.test(await text(page, '#cmdLog')));

  // ---- 12. header menus
  await page.locator('#overflowBtn').click();
  check('overflow menu opens', await visible(page, '#overflowMenu'));
  await page.locator('#overflowMenu [data-act="settings"]').click();
  check('overflow > Settings switches tab', (await page.locator('#tab-settings.active').count()) === 1);
  await page.screenshot({ path: path.join(shots, 'final.png'), fullPage: true });

  // ---- 13. state survives a panel reload (bridge config is the source of truth)
  await page.reload();
  check('workspace is restored after reload',
    await until(async () => /alpha-project/.test(await text(page, '#headerWs'))), await text(page, '#headerWs'));
  check('tree is restored after reload', await until(() => fileRow('README.md').isVisible()));

  // ---- 14. host missing -> honest offline state, no fake data
  const offlinePage = await ctx.newPage();
  watch(offlinePage, 'offline-panel');
  await offlinePage.goto(panelUrl + '#offline');
  check('offline: pill says Host offline',
    await until(async () => /Host offline/.test(await text(offlinePage, '#hostPill'))), await text(offlinePage, '#hostPill'));
  check('offline: banner is shown', await until(() => visible(offlinePage, '#banner')));
  check('offline: no workspace data is invented', /Belum ada workspace/.test(await text(offlinePage, '#headerWs')));
  await offlinePage.screenshot({ path: path.join(shots, 'offline.png'), fullPage: true });

  check('no page raised an error', pageErrors.length === 0, JSON.stringify(pageErrors, null, 2));
  check('bridge process stayed alive', !bridge.state.exited);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.log('ABORTED: ' + (error?.stack || error));
  console.log('PAGE ERRORS ' + JSON.stringify(pageErrors, null, 2));
  console.log('BRIDGE STDERR (tail)\n' + bridge.state.stderr.slice(-1500));
} finally {
  await ctx.close().catch(() => {});
  bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);

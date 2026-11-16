// sidepanel.spec.mjs - end-to-end run of the built extension against the REAL bridge.
// Run: npm run build && npm run e2e -w @broagentai/extension
// Exit code 0 = every check passed and no page raised an error.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
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
  for (const tab of ['explorer', 'search', 'scm', 'terminal', 'agent', 'settings']) {
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

  // ---- 10b. source control against a real Git repository
  const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!hasGit) {
    console.log('SKIP  source control checks (git not installed)');
  } else {
    const git = (...args) => execFileSync('git', args, { cwd: wsA, encoding: 'utf8' }).trim();
    const scmRow = (group, file) => page.locator(`[data-scm-group="${group}"] [data-scm-file="${file}"]`);
    const groupCount = (group) => page.locator(`[data-scm-group="${group}"] .scm-row`).count();
    const readme = path.join(wsA, 'README.md');

    await page.locator('.rail-btn[data-tab="scm"]').click();
    check('scm: non-repo workspace shows a clear state',
      await until(async () => /not a Git repository/.test(await text(page, '#scmState'))), await text(page, '#scmState'));
    check('scm: no fake changes are shown for a non-repo', !(await visible(page, '#scmBody')));
    await page.locator('#scmInit').click();
    check('scm: Init repository creates a real repo',
      await until(() => visible(page, '#scmBody')) && fs.existsSync(path.join(wsA, '.git')));
    git('config', 'user.email', 'e2e@example.com');
    git('config', 'user.name', 'E2E');
    git('config', 'commit.gpgsign', 'false');
    const firstBranch = git('branch', '--show-current');
    check('scm: every file starts untracked (ignored dirs included, like git)',
      await until(async () => (await groupCount('untracked')) === 5), 'untracked=' + await groupCount('untracked'));
    check('scm: rail badge shows the change count', (await text(page, '#scmBadge')) === '5');
    check('scm: commit is disabled with nothing staged', await page.locator('#commitBtn').isDisabled());

    await scmRow('untracked', 'README.md').locator('[data-act="stage"]').click();
    check('scm: Stage moves the file to Staged', await until(() => scmRow('staged', 'README.md').isVisible()));
    check('scm: stage is real (git sees it)', /^A\s+README\.md$/m.test(git('status', '--porcelain')));
    await scmRow('staged', 'README.md').locator('[data-act="diff-staged"]').click();
    check('scm: staged diff shows the added lines',
      await until(async () => /\+# Alpha/.test(await text(page, '#modalBody'))), await text(page, '#modalBody'));
    await page.locator('#modalOk').click();
    await scmRow('staged', 'README.md').locator('[data-act="unstage"]').click();
    check('scm: Unstage moves the file back', await until(() => scmRow('untracked', 'README.md').isVisible()));

    await page.locator('[data-scm-group="untracked"] [data-act="stage-all"]').click();
    check('scm: Stage all stages everything', await until(async () => (await groupCount('staged')) === 5));
    check('scm: commit stays disabled without a message', await page.locator('#commitBtn').isDisabled());
    await page.locator('#commitMsg').fill('feat: first commit from e2e');
    await page.locator('#commitBtn').click();
    check('scm: commit reports the new hash',
      await until(async () => /^Commit [0-9a-f]{7,} - feat: first commit from e2e/.test(await text(page, '#commitOut'))),
      await text(page, '#commitOut'));
    check('scm: commit is real (git log)', git('log', '-1', '--format=%s') === 'feat: first commit from e2e');
    check('scm: tree is clean after commit', (await groupCount('staged')) === 0 && (await groupCount('changes')) === 0);
    check('scm: badge hides when clean', !(await visible(page, '#scmBadge')));

    const committed = fs.readFileSync(readme, 'utf8');
    fs.writeFileSync(readme, committed + 'changed after commit\n');
    await page.locator('#scmRefresh').click();
    check('scm: an edit on disk appears under Changes', await until(() => scmRow('changes', 'README.md').isVisible()));
    check('scm: status letter is M', (await scmRow('changes', 'README.md').locator('.scm-letter').innerText()) === 'M');
    await scmRow('changes', 'README.md').locator('[data-act="diff"]').click();
    check('scm: unstaged diff shows the new line',
      await until(async () => /\+changed after commit/.test(await text(page, '#modalBody'))), await text(page, '#modalBody'));
    await page.locator('#modalOk').click();

    await page.locator('#newBranchBtn').click();
    await page.locator('#brName').fill('feat/e2e');
    await page.locator('#modalOk').click();
    check('scm: create branch switches to it',
      await until(async () => (await page.locator('#branchSel').inputValue()) === 'feat/e2e') && git('branch', '--show-current') === 'feat/e2e');
    await page.locator('#branchSel').selectOption(firstBranch);
    check('scm: switching with uncommitted changes is blocked with guidance',
      await toastHas(page, /uncommitted changes/), await text(page, '#toast'));
    check('scm: blocked switch leaves the branch alone',
      git('branch', '--show-current') === 'feat/e2e'
        && await until(async () => (await page.locator('#branchSel').inputValue()) === 'feat/e2e'));

    await scmRow('changes', 'README.md').locator('[data-act="discard"]').click();
    check('scm: discard asks for confirmation first',
      await until(async () => /tidak bisa dibatalkan/.test(await text(page, '#modalBody')))
        && fs.readFileSync(readme, 'utf8') !== committed);
    await page.locator('#modalOk').click();
    check('scm: discard restores the file on disk',
      await until(() => fs.readFileSync(readme, 'utf8').replace(/\r\n/g, '\n') === committed.replace(/\r\n/g, '\n')));
    check('scm: clean again after discard', await until(async () => (await groupCount('changes')) === 0));
    await page.locator('#branchSel').selectOption(firstBranch);
    check('scm: clean switch works', await until(() => git('branch', '--show-current') === firstBranch));
    await page.screenshot({ path: path.join(shots, 'tab-scm.png'), fullPage: true });

    // ---- 10c. remote sync against a local bare "origin"
    check('scm: remote buttons are disabled without a remote', await page.locator('#pushBtn').isDisabled());
    const originDir = path.join(tmp, 'origin.git');
    const otherDir = path.join(tmp, 'other-clone');
    execFileSync('git', ['init', '-q', '--bare', originDir]);
    git('remote', 'add', 'origin', originDir);
    const gitAt = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const upstreamCommit = (file, content, message) => {
      fs.writeFileSync(path.join(otherDir, file), content);
      gitAt(otherDir, 'add', '-A');
      gitAt(otherDir, 'commit', '-q', '-m', message);
      gitAt(otherDir, 'push', '-q');
    };
    await page.locator('#scmRefresh').click();
    check('scm: remote buttons enable once a remote exists', await until(async () => !(await page.locator('#pushBtn').isDisabled())));

    await page.locator('#pushBtn').click();
    check('scm: push asks for confirmation and names the publish target',
      await until(async () => new RegExp('origin/' + firstBranch).test(await text(page, '#modalBody'))), await text(page, '#modalBody'));
    await page.locator('#modalOk').click();
    check('scm: first push publishes the branch', await toastHas(page, /dipublish ke origin\//), await text(page, '#toast'));
    check('scm: push is real (remote has the commit)',
      gitAt(originDir, 'log', '-1', '--format=%s', firstBranch) === 'feat: first commit from e2e');
    check('scm: upstream is shown after publish',
      await until(async () => new RegExp('origin/' + firstBranch).test(await text(page, '#scmUpstream'))), await text(page, '#scmUpstream'));

    execFileSync('git', ['clone', '-q', '-b', firstBranch, originDir, otherDir]);
    gitAt(otherDir, 'config', 'user.email', 'other@example.com');
    gitAt(otherDir, 'config', 'user.name', 'Other');
    gitAt(otherDir, 'config', 'commit.gpgsign', 'false');
    upstreamCommit('from-upstream.txt', 'hello from upstream\n', 'upstream adds a file');
    await page.locator('#fetchBtn').click();
    check('scm: fetch shows the branch is behind', await until(async () => (await text(page, '#behind')) === '1'), await text(page, '#behind'));
    check('scm: fetch does not touch the working tree', !fs.existsSync(path.join(wsA, 'from-upstream.txt')));
    await page.locator('#pullBtn').click();
    await page.locator('#pullMode').waitFor({ state: 'visible' });
    await page.locator('#modalOk').click();
    check('scm: pull ff-only brings the upstream file',
      await until(() => fs.existsSync(path.join(wsA, 'from-upstream.txt'))) && await until(async () => (await text(page, '#behind')) === '0'));

    upstreamCommit('README.md', 'upstream version\n', 'upstream rewrites readme');
    fs.writeFileSync(readme, 'local version\n');
    git('commit', '-q', '-am', 'local rewrites readme');
    await page.locator('#pullBtn').click();
    await page.locator('#pullMode').selectOption('merge');
    await page.locator('#modalOk').click();
    check('scm: conflicting pull shows the conflict banner',
      await until(async () => (await visible(page, '#conflictBanner')) && /merge/.test(await text(page, '#conflictText'))), await text(page, '#toast'));
    check('scm: conflicted file is listed under Merge changes', await until(() => scmRow('conflict', 'README.md').isVisible()));
    check('scm: sync buttons lock during a merge', await page.locator('#pullBtn').isDisabled());
    await page.screenshot({ path: path.join(shots, 'scm-conflict.png'), fullPage: true });
    await page.locator('#scmAbort').click();
    await page.locator('#modalOk').click();
    check('scm: abort restores the pre-merge state',
      await until(async () => !(await visible(page, '#conflictBanner')))
        && fs.readFileSync(readme, 'utf8').replace(/\r\n/g, '\n') === 'local version\n'
        && !fs.existsSync(path.join(wsA, '.git', 'MERGE_HEAD')));
  }

  // ---- TERM. terminal: real PTY in the workspace
  {
    const termText = () => page.evaluate(() => window.__broagentaiTermText?.() ?? '');
    await page.locator('.rail-btn[data-tab="terminal"]').click();
    check('terminal: shell starts in the workspace',
      await until(async () => /alpha-project/.test(await text(page, '#termStatus')), 15000), await text(page, '#termStatus'));
    await page.locator('#termView').click();
    // The shell computes the marker, so it cannot come from the echo of the keystrokes.
    await page.keyboard.type(process.platform === 'win32' ? 'Write-Output "$(6*7)-from-pty"' : 'echo "$((6*7))-from-pty"');
    await page.keyboard.press('Enter');
    check('terminal: typed command runs and output is rendered',
      await until(async () => /42-from-pty/.test(await termText()), 15000), (await termText()).slice(-400));
    await page.keyboard.type(process.platform === 'win32' ? 'Set-Content -Path term-made.txt -Value pty' : 'echo pty > term-made.txt');
    await page.keyboard.press('Enter');
    check('terminal: commands act on the real workspace folder',
      await until(() => fs.existsSync(path.join(wsA, 'term-made.txt')), 15000));
    await page.screenshot({ path: path.join(shots, 'tab-terminal.png'), fullPage: true });
    await page.locator('#termKill').click();
    check('terminal: Kill ends the session',
      await until(async () => /tertutup/.test(await text(page, '#termStatus')), 15000), await text(page, '#termStatus'));
  }

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

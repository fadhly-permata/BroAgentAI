// SCM panel: real Git state of the active workspace through the bridge's git.* RPCs.
// Nothing here is demo data; when Git or a repository is missing the panel says so.
import { bridge } from './bridge-client.js';
import { fileIcon, icon } from './icons.js';
import { formatBadgeCount } from './badge-format.js';
import { openDiffView } from './diff-view.js';
import { layoutGraph, refChips } from './git-graph.js';
import type { GraphEdge, GraphRow } from './git-graph.js';

interface GitFile {
  path: string;
  origPath?: string;
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

interface GitStatus {
  gitAvailable: boolean;
  isRepo: boolean;
  reason?: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  operation: string | null;
  remotes: string[];
  files: GitFile[];
  truncated: boolean;
}

interface GitBranches {
  current: string | null;
  detached: boolean;
  branches: { name: string; current: boolean; upstream: string | null }[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
  refs: string[];
  parents: string[];
}

export interface ScmDeps {
  toast(message: string): void;
  openModal(title: string, bodyHtml: string, onOk: () => void): void;
  hasWorkspace(): boolean;
  /** Called after an action changed files on disk (discard, branch switch). */
  onFilesChanged(): void;
  /** Open a workspace file in the editor (from the diff view's "Open" button). */
  openFile?(path: string): void;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const escapeHtml = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

let deps: ScmDeps;
let status: GitStatus | null = null;
let refreshSeq = 0;
/** Groups the user folded; kept across refreshes. */
const collapsed = new Set<GroupKind>();

type GroupKind = 'conflict' | 'staged' | 'changes' | 'untracked';
const GROUPS: { kind: GroupKind; title: string; pick: (f: GitFile) => boolean }[] = [
  { kind: 'conflict', title: 'Merge changes', pick: (f) => f.conflicted },
  { kind: 'staged', title: 'Staged changes', pick: (f) => f.staged },
  { kind: 'changes', title: 'Changes', pick: (f) => f.unstaged },
  { kind: 'untracked', title: 'Untracked', pick: (f) => f.untracked },
];

function letter(kind: GroupKind, f: GitFile): string {
  if (kind === 'conflict') return '!';
  if (kind === 'untracked') return 'U';
  return kind === 'staged' ? f.index : f.worktree;
}

function button(label: string, act: string, path: string, glyph: string, extra = ''): string {
  return `<button class="action ${extra}" data-act="${act}" data-path="${escapeHtml(path)}" title="${label}" aria-label="${label}">${icon(glyph)}</button>`;
}

/** File name first, folder after it in muted text - the way VS Code lists changes. */
function pathHtml(f: GitFile): string {
  const split = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]; };
  const [dir, base] = split(f.path);
  const from = f.origPath ? `${escapeHtml(split(f.origPath)[1])} &rarr; ` : '';
  return `<span class="scm-name">${from}${escapeHtml(base)}</span>${dir ? `<span class="scm-dir">${escapeHtml(dir)}</span>` : ''}`;
}

function renderGroups(): void {
  const files = status?.files ?? [];
  const html = GROUPS.map((group) => {
    const items = files.filter(group.pick);
    // Like VS Code: empty groups are hidden, except Changes which says "none".
    if (items.length === 0 && group.kind !== 'changes') return '';
    const bulk = items.length === 0 || group.kind === 'conflict' ? ''
      : group.kind === 'staged' ? `<button class="action" data-act="unstage-all" title="Unstage all" aria-label="Unstage all">${icon('remove')}</button>`
      : `<button class="action" data-act="stage-all" data-group="${group.kind}" title="Stage all" aria-label="Stage all">${icon('add')}</button>`;
    const rows = items.map((f) => {
      const mark = letter(group.kind, f);
      const actions =
        group.kind === 'staged' ? button('Diff', 'diff-staged', f.path, 'diff') + button('Unstage', 'unstage', f.path, 'remove')
        : group.kind === 'conflict' ? button('Diff', 'diff', f.path, 'diff')
        : button('Diff', 'diff', f.path, 'diff') + button('Discard', 'discard', f.path, 'discard', 'danger') + button('Stage', 'stage', f.path, 'add');
      const name = f.path.split('/').pop() || f.path;
      return `<div class="scm-row" data-scm-file="${escapeHtml(f.path)}" data-letter="${escapeHtml(mark)}" title="${escapeHtml(f.origPath ? f.origPath + ' -> ' + f.path : f.path)}">`
        + `<span class="ba-tree-icon">${fileIcon(name)}</span><span class="scm-path">${pathHtml(f)}</span>`
        + `<span class="scm-actions">${actions}</span><span class="scm-letter" data-letter="${escapeHtml(mark)}">${escapeHtml(mark)}</span></div>`;
    }).join('');
    const fold = collapsed.has(group.kind) ? ' collapsed' : '';
    return `<div class="scm-group${fold}" data-scm-group="${group.kind}">`
      + `<div class="scm-group-head" data-act="toggle-group" data-group="${group.kind}" role="button" aria-expanded="${!fold}">`
      + `<span class="twist">${icon('chevron-right')}</span><span class="scm-group-title">${group.title}</span>`
      + `<span class="scm-actions">${bulk}</span><span class="count-badge">${items.length}</span></div>`
      + `<div class="scm-rows">${rows || '<p class="scm-empty">Tidak ada perubahan.</p>'}</div></div>`;
  }).join('');
  $('scmGroups').innerHTML = html + (status?.truncated ? '<p class="muted scm-note">Daftar dipotong (terlalu banyak perubahan).</p>' : '');
}

function renderCommitButton(): void {
  const staged = (status?.files ?? []).some((f) => f.staged);
  const message = ($('commitMsg') as HTMLTextAreaElement).value.trim();
  ($('commitBtn') as HTMLButtonElement).disabled = !(status?.isRepo && staged && message);
}

function renderBadge(): void {
  const count = status?.isRepo ? status.files.length : 0;
  const capped = !!status?.truncated;
  $('scmBadge').textContent = formatBadgeCount(count, capped);
  $('scmBadge').title = `${count}${capped ? '+' : ''} changes`;
  $('scmBadge').classList.toggle('hidden', count === 0);
}

function showState(message: string, canInit: boolean): void {
  $('scmBody').classList.add('hidden');
  const state = $('scmState');
  state.classList.remove('hidden');
  state.innerHTML = `<p>${escapeHtml(message)}</p>` + (canInit ? '<button id="scmInit" class="primary">Init repository</button>' : '');
  document.getElementById('scmInit')?.addEventListener('click', () => run(async () => {
    await bridge.call('git.init');
    deps.toast('Repository dibuat');
    await refreshScm();
  }));
}

function renderBranches(branches: GitBranches): void {
  const select = $('branchSel') as HTMLSelectElement;
  select.innerHTML = '';
  if (branches.detached) select.add(new Option('(detached HEAD)', '', true, true));
  for (const b of branches.branches) select.add(new Option(b.name, b.name, b.current, b.current));
}

const GRAPH_PAGE = 50;
const GRAPH_MAX = 500;
const LANE_W = 12;
const ROW_H = 22;
const LANE_COLORS = ['#4fa3e0', '#e06c75', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#be5046'];
let currentCommits: GitCommit[] = [];
let graphLimit = GRAPH_PAGE;
let graphSeq = 0;

const laneX = (lane: number) => lane * LANE_W + LANE_W / 2;
const laneColor = (color: number) => LANE_COLORS[color % LANE_COLORS.length];

/** Rows overlap by this much so adjacent row SVGs never leave an anti-aliasing seam. */
const SEAM = 1;

function edgePath(e: GraphEdge): string {
  const mid = ROW_H / 2;
  const [y1, y2] = e.half === 'top' ? [-SEAM, mid] : [mid, ROW_H + SEAM];
  const x1 = laneX(e.from), x2 = laneX(e.to);
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const [a, b] = e.half === 'top' ? [0, mid] : [mid, ROW_H];
  const c = (a + b) / 2;
  return `M${x1} ${y1}V${a}C${x1} ${c} ${x2} ${c} ${x2} ${b}V${y2}`;
}

function graphSvg(row: GraphRow, lanes: number, isHead: boolean): string {
  const width = Math.max(1, lanes) * LANE_W;
  const edges = row.edges.map((e) => `<path d="${edgePath(e)}" stroke="${laneColor(e.color)}"/>`).join('');
  const cx = laneX(row.lane), cy = ROW_H / 2, fill = laneColor(row.color);
  const dot = isHead
    ? `<circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--bg-sidebar)" stroke="${fill}" stroke-width="2"/>`
    : `<circle cx="${cx}" cy="${cy}" r="3.5" fill="${fill}"/>`;
  return `<svg class="scm-graph-lanes" width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" aria-hidden="true">${edges}${dot}</svg>`;
}

/** Vertical lane lines that keep running beside an expanded commit's file list. */
function laneSpacer(row: GraphRow, lanes: number): string {
  const width = Math.max(1, lanes) * LANE_W;
  const through = new Map<number, number>();
  for (const e of row.edges) if (e.half === 'bottom') through.set(e.to, e.color);
  const lines = [...through].map(([lane, color]) =>
    `<path d="M${laneX(lane)} 0V1" stroke="${laneColor(color)}" vector-effect="non-scaling-stroke"/>`).join('');
  return `<div class="scm-graph-spacer" style="width:${width}px" aria-hidden="true"><svg width="${width}" height="100%" viewBox="0 0 ${width} 1" preserveAspectRatio="none">${lines}</svg></div>`;
}

function formatCommitDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface CommitFile { path: string; origPath?: string; status: string }
interface CommitFiles { files: CommitFile[]; truncated: boolean }

/** Expanded commits and their file lists (null while loading, Error on failure). */
const expanded = new Map<string, CommitFiles | null | Error>();

function filesHtml(hash: string): string {
  const state = expanded.get(hash);
  if (state === null || state === undefined) return '<p class="scm-empty">Memuat file...</p>';
  if (state instanceof Error) return `<p class="scm-empty err">Gagal memuat file: ${escapeHtml(state.message)}</p>`;
  if (state.files.length === 0) return '<p class="scm-empty">Tidak ada perubahan file.</p>';
  const rows = state.files.map((f) => {
    const slash = f.path.lastIndexOf('/');
    const name = slash < 0 ? f.path : f.path.slice(slash + 1);
    const dir = slash < 0 ? '' : f.path.slice(0, slash);
    const letter = f.status === 'A' ? 'A' : f.status === 'D' ? 'D' : f.status === 'R' || f.status === 'C' ? f.status : 'M';
    const from = f.origPath ? `${escapeHtml(f.origPath)} &rarr; ` : '';
    return `<div class="scm-row scm-commit-file" role="button" tabindex="0" data-act="commit-file" data-hash="${escapeHtml(hash)}"`
      + ` data-path="${escapeHtml(f.path)}"${f.origPath ? ` data-orig="${escapeHtml(f.origPath)}"` : ''} data-letter="${letter}" title="${from}${escapeHtml(f.path)}">`
      + `<span class="ba-tree-icon">${fileIcon(name)}</span>`
      + `<span class="scm-path"><span class="scm-name">${escapeHtml(name)}</span>${dir ? `<span class="scm-dir">${escapeHtml(dir)}</span>` : ''}</span>`
      + `<span class="scm-letter" data-letter="${letter}">${letter}</span></div>`;
  }).join('');
  return rows + (state.truncated ? '<p class="scm-empty">Daftar file dipotong (terlalu banyak).</p>' : '');
}

function renderGraph(): void {
  const graphEl = $('scmGraph');
  if (!status?.isRepo || currentCommits.length === 0) {
    graphEl.innerHTML = '<p class="scm-empty">Belum ada commit.</p>';
    return;
  }
  const rows = layoutGraph(currentCommits);
  const lanes = Math.min(rows.reduce((max, r) => Math.max(max, r.width), 1), 16);
  const known = new Set(currentCommits.map((c) => c.hash));
  for (const hash of expanded.keys()) if (!known.has(hash)) expanded.delete(hash);
  const html = currentCommits.map((commit, i) => {
    const chips = refChips(commit.refs);
    const isHead = chips.some((c) => c.kind === 'head');
    const open = expanded.has(commit.hash);
    const chipsHtml = chips.map((c) => `<span class="scm-ref scm-ref-${c.kind}">${escapeHtml(c.label)}</span>`).join('');
    const date = formatCommitDate(commit.date);
    const tip = `${commit.shortHash} · ${commit.author} <${commit.authorEmail}>\n${date}\n\n${commit.message}`;
    const row = `<div class="scm-graph-row${isHead ? ' is-head' : ''}${open ? ' open' : ''}" role="button" tabindex="0" aria-expanded="${open}"`
      + ` data-act="toggle-commit" data-hash="${escapeHtml(commit.hash)}" title="${escapeHtml(tip)}">`
      + graphSvg(rows[i], lanes, isHead)
      + `<span class="scm-graph-msg">${chipsHtml}<span class="scm-graph-subject">${escapeHtml(commit.message)}</span></span>`
      + `<span class="scm-graph-author">${escapeHtml(commit.author)}</span></div>`;
    if (!open) return row;
    return row + `<div class="scm-graph-files">${laneSpacer(rows[i], lanes)}`
      + `<div class="scm-graph-files-list"><div class="scm-graph-files-head">${escapeHtml(commit.shortHash)} · ${escapeHtml(commit.author)} · ${escapeHtml(date)}</div>`
      + `${filesHtml(commit.hash)}</div></div>`;
  }).join('');
  const more = currentCommits.length >= graphLimit && graphLimit < GRAPH_MAX
    ? '<button class="mini scm-graph-more" data-act="graph-more">Muat lebih banyak</button>' : '';
  graphEl.innerHTML = `<div class="scm-graph-rows">${html}</div>${more}`;
}

async function toggleCommit(hash: string): Promise<void> {
  if (expanded.has(hash)) {
    expanded.delete(hash);
    renderGraph();
    return;
  }
  expanded.set(hash, null);
  renderGraph();
  try {
    const res: CommitFiles = await bridge.call('git.commitFiles', { hash });
    if (!expanded.has(hash)) return; // collapsed meanwhile
    expanded.set(hash, { files: res.files, truncated: !!res.truncated });
  } catch (err: any) {
    if (!expanded.has(hash)) return;
    expanded.set(hash, new Error(String(err?.message || err)));
  }
  renderGraph();
}

async function showCommitDiff(hash: string, path: string, origPath?: string): Promise<void> {
  const res: any = await bridge.call('git.commitDiff', { hash, path, origPath });
  const commit = currentCommits.find((c) => c.hash === hash);
  openDiffView({
    path, staged: false, diff: res.diff || '', truncated: !!res.truncated, onOpenFile: deps.openFile,
    label: commit ? commit.shortHash : hash.slice(0, 7),
  });
}

function onGraphClick(e: Event): void {
  const target = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!target) return;
  const act = target.dataset.act;
  if (act === 'graph-more') {
    graphLimit = Math.min(graphLimit + GRAPH_PAGE, GRAPH_MAX);
    loadGraph();
  } else if (act === 'toggle-commit') {
    toggleCommit(target.dataset.hash || '');
  } else if (act === 'commit-file') {
    run(() => showCommitDiff(target.dataset.hash || '', target.dataset.path || '', target.dataset.orig));
  }
}

function onGraphKey(e: KeyboardEvent): void {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!(e.target as HTMLElement).matches('[data-act="toggle-commit"], [data-act="commit-file"]')) return;
  e.preventDefault();
  onGraphClick(e);
}

async function loadGraph(): Promise<void> {
  if (!status?.isRepo) return;
  const seq = ++graphSeq;
  try {
    const res: { commits: GitCommit[] } = await bridge.call('git.log', { maxCount: graphLimit });
    if (seq !== graphSeq) return;
    currentCommits = res.commits;
    renderGraph();
  } catch (err: any) {
    if (seq !== graphSeq) return;
    $('scmGraph').innerHTML = `<p class="scm-empty err">Gagal memuat graph: ${escapeHtml(String(err?.message || err))}</p>`;
  }
}

const graphVisible = () => !$('scmGraphView').classList.contains('hidden');

function showScmView(view: 'changes' | 'graph'): void {
  document.querySelectorAll<HTMLElement>('.scm-view-btn').forEach((btn) => {
    const on = btn.dataset.view === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  $('scmChangesView').classList.toggle('hidden', view !== 'changes');
  $('scmGraphView').classList.toggle('hidden', view !== 'graph');
  if (view === 'graph') {
    if (currentCommits.length === 0) $('scmGraph').innerHTML = '<p class="scm-empty">Memuat riwayat commit...</p>';
    loadGraph();
  }
}

/** Reload Git state for the active workspace and repaint the panel. */
export async function refreshScm(): Promise<void> {
  const seq = ++refreshSeq;
  if (!deps.hasWorkspace()) {
    status = null;
    currentCommits = [];
    renderBadge();
    showState('Pilih workspace untuk melihat status Git.', false);
    return;
  }
  try {
    const next: GitStatus = await bridge.call('git.status');
    const branches: GitBranches | null = next.isRepo ? await bridge.call('git.branches') : null;
    if (seq !== refreshSeq) return; // a newer refresh already painted
    status = next;
    renderBadge();
    if (!next.gitAvailable) return showState('Git tidak ditemukan di PATH. Install Git lalu klik Refresh.', false);
    if (!next.isRepo) return showState(next.reason || 'Workspace ini bukan repository Git.', !/parent/i.test(next.reason || ''));

    $('scmState').classList.add('hidden');
    $('scmBody').classList.remove('hidden');
    if (branches) renderBranches(branches);
    $('ahead').textContent = String(next.ahead);
    $('behind').textContent = String(next.behind);
    $('scmUpstream').textContent = next.upstream ? next.upstream : 'tanpa upstream';
    $('conflictBanner').classList.toggle('hidden', !next.operation);
    $('conflictText').textContent = next.operation
      ? `${next.operation} sedang berlangsung - selesaikan konflik di file lalu stage + commit, atau Abort.` : '';
    const hasRemote = next.remotes.length > 0;
    for (const id of ['fetchBtn', 'pullBtn', 'pushBtn']) {
      const btn = $(id) as HTMLButtonElement;
      btn.disabled = !hasRemote || !!next.operation;
      btn.title = hasRemote ? '' : 'Repository ini belum punya remote';
    }
    renderGroups();
    renderCommitButton();
    if (graphVisible()) loadGraph();
  } catch (err: any) {
    if (seq !== refreshSeq) return;
    status = null;
    currentCommits = [];
    renderBadge();
    showState('Gagal membaca status Git: ' + (err?.message || err), false);
  }
}

/** Run one action; any bridge error becomes a toast instead of an unhandled rejection. */
async function run(action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (err: any) { deps.toast('Git: ' + (err?.message || err)); }
}

function paint(next: GitStatus): void {
  status = next;
  renderBadge();
  renderGroups();
  renderCommitButton();
}

async function showDiff(path: string, staged: boolean): Promise<void> {
  const res: any = await bridge.call('git.diff', { path, staged });
  openDiffView({ path, staged, diff: res.diff || '', truncated: !!res.truncated, onOpenFile: deps.openFile });
}

async function onGroupClick(e: Event): Promise<void> {
  const raw = e.target as HTMLElement;
  const target = raw.closest('[data-act]') as HTMLElement | null;
  if (!target && status) {
    const row = raw.closest('.scm-row') as HTMLElement | null;
    if (row && !raw.closest('.scm-actions')) {
      const staged = !!row.closest('[data-scm-group="staged"]');
      return run(() => showDiff(row.dataset.scmFile || '', staged));
    }
  }
  if (!target || !status) return;
  const act = target.dataset.act!;
  const path = target.dataset.path || '';

  if (act === 'toggle-group') {
    const kind = target.dataset.group as GroupKind;
    if (collapsed.has(kind)) collapsed.delete(kind); else collapsed.add(kind);
    const box = target.closest('.scm-group') as HTMLElement;
    box.classList.toggle('collapsed', collapsed.has(kind));
    target.setAttribute('aria-expanded', String(!collapsed.has(kind)));
    return;
  }

  if (act === 'stage') return run(async () => paint(await bridge.call('git.stage', { paths: [path] })));
  if (act === 'unstage') return run(async () => paint(await bridge.call('git.unstage', { paths: [path] })));
  if (act === 'stage-all') {
    const group = GROUPS.find((g) => g.kind === target.dataset.group)!;
    const paths = status.files.filter(group.pick).map((f) => f.path);
    return run(async () => paint(await bridge.call('git.stage', { paths })));
  }
  if (act === 'unstage-all') {
    const paths = status.files.filter((f) => f.staged).map((f) => f.path);
    return run(async () => paint(await bridge.call('git.unstage', { paths })));
  }
  if (act === 'diff' || act === 'diff-staged') {
    return run(() => showDiff(path, act === 'diff-staged'));
  }
  if (act === 'discard') {
    const file = status.files.find((f) => f.path === path);
    const what = file?.untracked ? 'File untracked ini akan DIHAPUS dari disk.' : 'Perubahan yang belum di-stage akan dibuang.';
    deps.openModal('Discard perubahan?', `<p><code>${escapeHtml(path)}</code></p><p>${what} Aksi ini tidak bisa dibatalkan.</p>`, () => {
      run(async () => {
        paint(await bridge.call('git.discard', { paths: [path] }));
        deps.onFilesChanged();
        deps.toast('Perubahan dibuang: ' + path);
      });
    });
  }
}

/** Attach SCM event handlers once. */
export function initScm(dependencies: ScmDeps): void {
  deps = dependencies;
  $('scmGroups').addEventListener('click', onGroupClick);
  $('scmRefresh').addEventListener('click', () => { refreshScm(); });
  $('commitMsg').addEventListener('input', renderCommitButton);

  // Sub-view toggle (Changes / Graph)
  document.querySelectorAll<HTMLElement>('.scm-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => showScmView(btn.dataset.view === 'graph' ? 'graph' : 'changes'));
  });
  $('scmGraph').addEventListener('click', onGraphClick);
  $('scmGraph').addEventListener('keydown', onGraphKey);

  $('commitBtn').addEventListener('click', () => run(async () => {
    const box = $('commitMsg') as HTMLTextAreaElement;
    const res: any = await bridge.call('git.commit', { message: box.value });
    box.value = '';
    $('commitOut').textContent = `Commit ${res.hash} - ${res.summary}`;
    paint(res.status);
    deps.toast('Commit dibuat: ' + res.hash);
  }));

  $('branchSel').addEventListener('change', async () => {
    const select = $('branchSel') as HTMLSelectElement;
    const branch = select.value;
    if (!branch) return;
    try {
      await bridge.call('git.checkout', { branch });
      deps.toast('Pindah ke branch ' + branch);
      deps.onFilesChanged();
    } catch (err: any) {
      deps.toast('Git: ' + (err?.message || err));
    }
    await refreshScm(); // also resets the select when the switch was refused
  });

  // Remote sync. Pull and push always ask first; a failed sync still refreshes
  // the panel because a conflicting pull leaves the repository mid-merge.
  const sync = async (label: string, action: () => Promise<any>, done: (res: any) => string, touchesFiles = true) => {
    try {
      deps.toast(label + '...');
      deps.toast(done(await action()));
    } catch (err: any) {
      deps.toast('Git: ' + (err?.message || err));
    }
    if (touchesFiles) deps.onFilesChanged();
    await refreshScm();
  };

  $('fetchBtn').addEventListener('click', () => sync('Fetch', () => bridge.call('git.fetch', {}, 130000),
    (res) => `Fetch selesai - up ${res.ahead}, down ${res.behind}`, false));

  $('pullBtn').addEventListener('click', () => {
    if (!status?.isRepo) return;
    deps.openModal('Pull - konfirmasi',
      `<p>Branch: <b>${escapeHtml(status.branch || '(detached)')}</b> &larr; <b>${escapeHtml(status.upstream || 'tanpa upstream')}</b> - up ${status.ahead}, down ${status.behind}</p>` +
      '<label>Mode <select id="pullMode"><option value="ff-only">ff-only (aman, tidak pernah konflik)</option><option value="merge">merge</option><option value="rebase">rebase</option></select></label>',
      () => {
        const mode = (document.getElementById('pullMode') as HTMLSelectElement)?.value || 'ff-only';
        sync('Pull ' + mode, () => bridge.call('git.pull', { mode }, 130000), () => 'Pull ' + mode + ' selesai');
      });
  });

  $('pushBtn').addEventListener('click', () => {
    if (!status?.isRepo) return;
    const target = status.upstream
      ? `ke <b>${escapeHtml(status.upstream)}</b> - ${status.ahead} commit akan di-push`
      : `branch baru akan dipublish ke <b>${escapeHtml((status.remotes.includes('origin') ? 'origin' : status.remotes[0]) + '/' + (status.branch || ''))}</b> dan dijadikan upstream`;
    deps.openModal('Push - konfirmasi',
      `<p>Branch: <b>${escapeHtml(status.branch || '(detached)')}</b> ${target}.</p><p class="muted">Force-push tidak tersedia.</p>`,
      () => sync('Push', () => bridge.call('git.push', {}, 130000),
        (res) => res.publishedTo ? 'Branch dipublish ke ' + res.publishedTo : 'Push selesai'));
  });

  $('scmAbort').addEventListener('click', () => {
    if (!status?.operation) return;
    deps.openModal('Abort ' + status.operation + '?', '<p>Repository dikembalikan ke keadaan sebelum ' + escapeHtml(status.operation) + '. Resolusi konflik yang belum di-commit akan hilang.</p>',
      () => sync('Abort', () => bridge.call('git.abort'), () => 'Dibatalkan'));
  });

  $('newBranchBtn').addEventListener('click', () => {
    if (!status?.isRepo) return;
    deps.openModal('Create branch', '<input id="brName" class="input" placeholder="feat/nama-branch">', () => {
      const name = (document.getElementById('brName') as HTMLInputElement)?.value.trim();
      if (!name) return;
      run(async () => {
        await bridge.call('git.createBranch', { name });
        deps.toast('Branch dibuat: ' + name);
        await refreshScm();
      });
    });
  });
}

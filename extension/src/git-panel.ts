// SCM panel: real Git state of the active workspace through the bridge's git.* RPCs.
// Nothing here is demo data; when Git or a repository is missing the panel says so.
import { bridge } from './bridge-client.js';
import { fileIcon, icon } from './icons.js';
import { formatBadgeCount } from './badge-format.js';
import { openEditorTab } from './editor-tabs.js';
import { layoutGraph, refChips } from './git-graph.js';
import type { GraphEdge, GraphRow } from './git-graph.js';
import { t } from './i18n.js';
import { initPanes } from './panes.js';

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
  /** Display name of the active workspace (the Repositories row). */
  workspaceName?(): string;
  /** Called after an action changed files on disk (discard, branch switch). */
  onFilesChanged(): void;
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
  { kind: 'conflict', title: 'mergeChanges', pick: (f) => f.conflicted },
  { kind: 'staged', title: 'stagedChanges', pick: (f) => f.staged },
  { kind: 'changes', title: 'changes', pick: (f) => f.unstaged },
  { kind: 'untracked', title: 'untracked', pick: (f) => f.untracked },
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
      : group.kind === 'staged' ? `<button class="action" data-act="unstage-all" title="${escapeHtml(t('unstageAll'))}" aria-label="${escapeHtml(t('unstageAll'))}">${icon('remove')}</button>`
      : `<button class="action" data-act="stage-all" data-group="${group.kind}" title="${escapeHtml(t('stageAll'))}" aria-label="${escapeHtml(t('stageAll'))}">${icon('add')}</button>`;
    const rows = items.map((f) => {
      const mark = letter(group.kind, f);
      const actions =
        group.kind === 'staged' ? button(t('diff'), 'diff-staged', f.path, 'diff') + button(t('unstage'), 'unstage', f.path, 'remove')
        : group.kind === 'conflict' ? button(t('diff'), 'diff', f.path, 'diff')
        : button(t('diff'), 'diff', f.path, 'diff') + button(t('discard'), 'discard', f.path, 'discard', 'danger') + button(t('stage'), 'stage', f.path, 'add');
      const name = f.path.split('/').pop() || f.path;
      return `<div class="scm-row" data-scm-file="${escapeHtml(f.path)}" data-letter="${escapeHtml(mark)}" title="${escapeHtml(f.origPath ? f.origPath + ' -> ' + f.path : f.path)}">`
        + `<span class="ba-tree-icon">${fileIcon(name)}</span><span class="scm-path">${pathHtml(f)}</span>`
        + `<span class="scm-actions">${actions}</span><span class="scm-letter" data-letter="${escapeHtml(mark)}">${escapeHtml(mark)}</span></div>`;
    }).join('');
    const fold = collapsed.has(group.kind) ? ' collapsed' : '';
    return `<div class="scm-group${fold}" data-scm-group="${group.kind}">`
      + `<div class="scm-group-head" data-act="toggle-group" data-group="${group.kind}" role="button" aria-expanded="${!fold}">`
      + `<span class="twist">${icon('chevron-right')}</span><span class="scm-group-title">${escapeHtml(t(group.title))}</span>`
      + `<span class="scm-actions">${bulk}</span><span class="count-badge">${items.length}</span></div>`
      + `<div class="scm-rows">${rows || `<p class="scm-empty">${escapeHtml(t('noChanges'))}</p>`}</div></div>`;
  }).join('');
  $('scmGroups').innerHTML = html + (status?.truncated ? `<p class="muted scm-note">${escapeHtml(t('changesTruncated'))}</p>` : '');
}

/**
 * The big button under the message box does what VS Code's SCM action button does:
 * Commit while there are changes, Publish Branch for a clean branch without an
 * upstream, Sync Changes when the branch is ahead of or behind its upstream.
 */
type ActionMode = 'commit' | 'publish' | 'sync';
function actionMode(): ActionMode {
  if (!status?.isRepo || status.files.length > 0 || status.operation || status.detached) return 'commit';
  if (status.remotes.length === 0) return 'commit';
  if (!status.upstream) return 'publish';
  return status.ahead > 0 || status.behind > 0 ? 'sync' : 'commit';
}

function renderCommitButton(): void {
  const staged = (status?.files ?? []).some((f) => f.staged);
  const message = ($('commitMsg') as HTMLTextAreaElement).value.trim();
  const canCommit = !!(status?.isRepo && staged && message);
  const mode = actionMode();
  const btn = $('commitBtn') as HTMLButtonElement;
  btn.dataset.mode = mode;
  const glyph = mode === 'publish' ? 'cloud-upload' : mode === 'sync' ? 'sync' : 'check';
  const label = mode === 'publish' ? t('publishBranch')
    : mode === 'sync' ? `${t('syncChanges')} ${status!.behind}\u2193 ${status!.ahead}\u2191` : t('commit');
  btn.innerHTML = `${icon(glyph)}<span id="commitLabel">${escapeHtml(label)}</span>`;
  btn.disabled = mode === 'commit' ? !canCommit : false;
  ($('commitHeadBtn') as HTMLButtonElement).disabled = !canCommit;
  ($('commitMsg') as HTMLTextAreaElement).placeholder = status?.branch
    ? t('commitOn').replace('{0}', status.branch) : t('commitPlaceholder');
}

/** Grow the message box with its text, like VS Code's SCM input (up to 10 lines). */
function fitCommitBox(): void {
  const box = $('commitMsg') as HTMLTextAreaElement;
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight + 2, 10 * 18 + 10) + 'px';
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
    deps.toast(t('repositoryCreated'));
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
// VS Code Source Control Graph colors (scmGraph.historyItemRefColor, scmGraph.foreground1-5).
const LANE_COLORS = ['#59a4f9', '#ffb000', '#dc267f', '#994f00', '#40b0a6', '#b66dff'];
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
  if (state === null || state === undefined) return `<p class="scm-empty">${escapeHtml(t('loadingFiles'))}</p>`;
  if (state instanceof Error) return `<p class="scm-empty err">${escapeHtml(t('failedLoadingFiles').replace('{0}', escapeHtml(state.message)))}</p>`;
  if (state.files.length === 0) return `<p class="scm-empty">${escapeHtml(t('noFileChanges'))}</p>`;
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
  return rows + (state.truncated ? `<p class="scm-empty">${escapeHtml(t('filesTruncated'))}</p>` : '');
}

function renderGraph(): void {
  const graphEl = $('scmGraph');
  if (!status?.isRepo || currentCommits.length === 0) {
    graphEl.innerHTML = `<p class="scm-empty">${escapeHtml(t('noCommits'))}</p>`;
    return;
  }
  const rows = layoutGraph(currentCommits);
  const lanes = Math.min(rows.reduce((max, r) => Math.max(max, r.width), 1), 16);
  const known = new Set(currentCommits.map((c) => c.hash));
  for (const hash of expanded.keys()) if (!known.has(hash)) expanded.delete(hash);
  const html = currentCommits.map((commit, i) => {
    const chips = refChips(commit.refs, status?.remotes);
    const isHead = chips.some((c) => c.kind === 'head');
    const open = expanded.has(commit.hash);
    // Ref badges like VS Code's graph: local refs take their lane color, remotes purple, tags grey.
    const chipsHtml = chips.map((c) => {
      const glyph = c.kind === 'head' ? 'target' : c.kind === 'remote' ? 'cloud' : c.kind === 'tag' ? 'tag' : 'git-branch';
      const color = c.kind === 'head' || c.kind === 'branch' ? ` style="--ref-color:${laneColor(rows[i].color)}"` : '';
      return `<span class="scm-ref scm-ref-${c.kind}"${color} title="${escapeHtml(c.label)}">${icon(glyph)}<span>${escapeHtml(c.label)}</span></span>`;
    }).join('');
    const date = formatCommitDate(commit.date);
    const tip = `${commit.shortHash} · ${commit.author} <${commit.authorEmail}>\n${date}\n\n${commit.message}`;
    const row = `<div class="scm-graph-row${isHead ? ' is-head' : ''}${open ? ' open' : ''}" role="button" tabindex="0" aria-expanded="${open}"`
      + ` data-act="toggle-commit" data-hash="${escapeHtml(commit.hash)}" title="${escapeHtml(tip)}">`
      + graphSvg(rows[i], lanes, isHead)
      + `<span class="scm-graph-msg"><span class="scm-graph-subject">${escapeHtml(commit.message)}</span>`
      + `<span class="scm-graph-author">${escapeHtml(commit.author)}</span></span>`
      + (chipsHtml ? `<span class="scm-graph-refs">${chipsHtml}</span>` : '') + `</div>`;
    if (!open) return row;
    return row + `<div class="scm-graph-files">${laneSpacer(rows[i], lanes)}`
      + `<div class="scm-graph-files-list"><div class="scm-graph-files-head">${escapeHtml(commit.shortHash)} · ${escapeHtml(commit.author)} · ${escapeHtml(date)}</div>`
      + `${filesHtml(commit.hash)}</div></div>`;
  }).join('');
  const more = currentCommits.length >= graphLimit && graphLimit < GRAPH_MAX
    ? `<button class="mini scm-graph-more" data-act="graph-more">${escapeHtml(t('loadMore'))}</button>` : '';
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

/** A commit's change to one file, in the editor tab. */
async function showCommitDiff(hash: string, path: string, origPath?: string): Promise<void> {
  await openEditorTab({ path, mode: 'diff', hash, origPath });
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
    $('scmGraph').innerHTML = `<p class="scm-empty err">${escapeHtml(t('failedLoadingGraph').replace('{0}', escapeHtml(String(err?.message || err))))}</p>`;
  }
}

/** Folded panes (Repositories / Changes / Graph); kept across refreshes. */
const foldedPanes = new Set<string>();
const graphVisible = () => !foldedPanes.has('graph');

function togglePane(pane: HTMLElement): void {
  const name = pane.dataset.pane || '';
  if (foldedPanes.has(name)) foldedPanes.delete(name); else foldedPanes.add(name);
  const folded = foldedPanes.has(name);
  pane.classList.toggle('collapsed', folded);
  pane.querySelector('.pane-head')?.setAttribute('aria-expanded', String(!folded));
  if (name === 'graph' && !folded) loadGraph();
}

/** Reload Git state for the active workspace and repaint the panel. */
export async function refreshScm(): Promise<void> {
  const seq = ++refreshSeq;
  if (!deps.hasWorkspace()) {
    status = null;
    currentCommits = [];
    renderBadge();
    showState(t('selectWorkspaceForGit'), false);
    return;
  }
  try {
    const next: GitStatus = await bridge.call('git.status');
    const branches: GitBranches | null = next.isRepo ? await bridge.call('git.branches') : null;
    if (seq !== refreshSeq) return; // a newer refresh already painted
    status = next;
    renderBadge();
    if (!next.gitAvailable) return showState(t('gitNotAvailable'), false);
    if (!next.isRepo) return showState(next.reason || t('notARepo'), !/parent/i.test(next.reason || ''));

    $('scmState').classList.add('hidden');
    $('scmBody').classList.remove('hidden');
    if (branches) renderBranches(branches);
    $('scmRepoName').textContent = deps.workspaceName?.() || '';
    $('ahead').textContent = String(next.ahead);
    $('behind').textContent = String(next.behind);
    $('scmUpstream').textContent = next.upstream ? next.upstream : t('noUpstream');
    // Like VS Code's repository row: ahead/behind once the branch tracks a remote, a publish icon before that.
    $('scmSync').classList.toggle('hidden', !next.upstream);
    $('scmSync').title = next.upstream ? `${next.upstream} - ${next.behind}\u2193 ${next.ahead}\u2191` : '';
    $('repoPublish').classList.toggle('hidden', !!next.upstream || next.remotes.length === 0 || next.detached);
    $('conflictBanner').classList.toggle('hidden', !next.operation);
    $('conflictText').textContent = next.operation
      ? `${t('operationInProgress').replace('{0}', next.operation)}` : '';
    const hasRemote = next.remotes.length > 0;
    for (const id of ['fetchBtn', 'pullBtn', 'pushBtn']) {
      const btn = $(id) as HTMLButtonElement;
      btn.disabled = !hasRemote || !!next.operation;
      btn.title = hasRemote ? t(id.replace('Btn', '')) : t('noRemote');
    }
    renderGroups();
    renderCommitButton();
    if (graphVisible()) loadGraph();
  } catch (err: any) {
    if (seq !== refreshSeq) return;
    status = null;
    currentCommits = [];
    renderBadge();
    showState(t('gitStatusFailed').replace('{0}', err?.message || err), false);
  }
}

/** Run one action; any bridge error becomes a toast instead of an unhandled rejection. */
async function run(action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (err: any) { deps.toast(t('gitError').replace('{0}', String(err?.message || err))); }
}

function paint(next: GitStatus): void {
  status = next;
  renderBadge();
  renderGroups();
  renderCommitButton();
}

/** Working-tree or staged diff of one file, in the editor tab. */
async function showDiff(path: string, staged: boolean): Promise<void> {
  await openEditorTab({ path, mode: 'diff', staged });
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
    const what = file?.untracked ? t('untrackedWillDelete') : t('unstagedWillDiscard');
    deps.openModal(t('discardChangesTitle'), `<p><code>${escapeHtml(path)}</code></p><p>${what} Aksi ini tidak bisa dibatalkan.</p>`, () => {
      run(async () => {
        paint(await bridge.call('git.discard', { paths: [path] }));
        deps.onFilesChanged();
        deps.toast(t('changesDiscarded').replace('{0}', path));
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

  initPanes($('scmBody'), 'broagentai.scmPanes');
  // Collapsible panes: click or Enter/Space on a pane header, not on its action buttons.
  document.querySelectorAll<HTMLElement>('#tab-scm .pane-head').forEach((head) => {
    const pane = head.closest('.pane') as HTMLElement;
    head.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.pane-actions')) togglePane(pane); });
    head.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); togglePane(pane); }
    });
  });
  $('graphRefresh').addEventListener('click', () => { loadGraph(); });
  $('repoPublish').addEventListener('click', () => { $('pushBtn').click(); });
  $('commitMsg').addEventListener('input', fitCommitBox);
  $('commitMsg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('commitHeadBtn').click(); }
  });
  $('scmGraph').addEventListener('click', onGraphClick);
  $('scmGraph').addEventListener('keydown', onGraphKey);

  const commit = () => run(async () => {
    const box = $('commitMsg') as HTMLTextAreaElement;
    const res: any = await bridge.call('git.commit', { message: box.value });
    box.value = '';
    fitCommitBox();
    $('commitOut').textContent = t('commitOutput').replace('{0}', res.hash).replace('{1}', res.summary);
    paint(res.status);
    deps.toast(t('commitCreated').replace('{0}', res.hash));
  });
  $('commitHeadBtn').addEventListener('click', () => {
    if (!($('commitHeadBtn') as HTMLButtonElement).disabled) commit();
  });
  $('commitBtn').addEventListener('click', () => {
    const mode = $('commitBtn').dataset.mode as ActionMode | undefined;
    if (mode === 'publish') { $('pushBtn').click(); return; }
    if (mode === 'sync') { syncChanges(); return; }
    commit();
  });

  $('branchSel').addEventListener('change', async () => {
    const select = $('branchSel') as HTMLSelectElement;
    const branch = select.value;
    if (!branch) return;
    try {
      await bridge.call('git.checkout', { branch });
      deps.toast(t('switchedBranch').replace('{0}', branch));
      deps.onFilesChanged();
    } catch (err: any) {
      deps.toast(t('gitError').replace('{0}', String(err?.message || err)));
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
      deps.toast(t('gitError').replace('{0}', String(err?.message || err)));
    }
    if (touchesFiles) deps.onFilesChanged();
    await refreshScm();
  };

  // Sync Changes = pull (ff-only, never conflicts) then push, after one confirmation.
  const syncChanges = () => {
    if (!status?.isRepo || !status.upstream) return;
    const { behind, ahead, upstream } = status;
    deps.openModal(t('syncChanges'),
      `<p>${t('syncDescription').replace('{0}', escapeHtml(status.branch || '')).replace('{1}', escapeHtml(upstream)).replace('{2}', String(behind)).replace('{3}', String(ahead))}</p><p class="muted">${t('forcePushUnavailable')}</p>`,
      () => sync('Sync', async () => {
        if (behind > 0) await bridge.call('git.pull', { mode: 'ff-only' }, 130000);
        if (ahead > 0) await bridge.call('git.push', {}, 130000);
      }, () => t('syncComplete')));
  };

  $('fetchBtn').addEventListener('click', () => sync('Fetch', () => bridge.call('git.fetch', {}, 130000),
    (res) => t('fetchComplete').replace('{0}', String(res.ahead)).replace('{1}', String(res.behind)), false));

  $('pullBtn').addEventListener('click', () => {
    if (!status?.isRepo) return;
    deps.openModal(t('pullConfirm'),
      `<p>Branch: <b>${escapeHtml(status.branch || '(detached)')}</b> &larr; <b>${escapeHtml(status.upstream || 'tanpa upstream')}</b> - up ${status.ahead}, down ${status.behind}</p>` +
      '<label>Mode <select id="pullMode"><option value="ff-only">ff-only (aman, tidak pernah konflik)</option><option value="merge">merge</option><option value="rebase">rebase</option></select></label>',
      () => {
        const mode = (document.getElementById('pullMode') as HTMLSelectElement)?.value || 'ff-only';
        sync('Pull ' + mode, () => bridge.call('git.pull', { mode }, 130000), () => t('pullComplete').replace('{0}', mode));
      });
  });

  $('pushBtn').addEventListener('click', () => {
    if (!status?.isRepo) return;
    const target = status.upstream
      ? `ke <b>${escapeHtml(status.upstream)}</b> - ${status.ahead} commit akan di-push`
      : `branch baru akan dipublish ke <b>${escapeHtml((status.remotes.includes('origin') ? 'origin' : status.remotes[0]) + '/' + (status.branch || ''))}</b> dan dijadikan upstream`;
    deps.openModal(t('pushConfirm'),
      `<p>Branch: <b>${escapeHtml(status.branch || '(detached)')}</b> ${target}.</p><p class="muted">Force-push tidak tersedia.</p>`,
      () => sync('Push', () => bridge.call('git.push', {}, 130000),
        (res) => res.publishedTo ? t('branchPublished').replace('{0}', res.publishedTo) : t('pushComplete')));
  });

  $('scmAbort').addEventListener('click', () => {
    if (!status?.operation) return;
    deps.openModal(t('abortTitle').replace('{0}', status.operation), `<p>${t('abortDescription').replace('{0}', escapeHtml(status.operation))}</p>`,
      () => sync('Abort', () => bridge.call('git.abort'), () => t('aborted')));
  });

  $('newBranchBtn').addEventListener('click', () => {
    if (!status?.isRepo) return;
    deps.openModal(t('createBranch'), `<input id="brName" class="input" placeholder="${t('branchPlaceholder')}">`, () => {
      const name = (document.getElementById('brName') as HTMLInputElement)?.value.trim();
      if (!name) return;
      run(async () => {
        await bridge.call('git.createBranch', { name });
        deps.toast(t('branchCreated').replace('{0}', name));
        await refreshScm();
      });
    });
  });
}

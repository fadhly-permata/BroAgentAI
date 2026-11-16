// SCM panel: real Git state of the active workspace through the bridge's git.* RPCs.
// Nothing here is demo data; when Git or a repository is missing the panel says so.
import { bridge } from './bridge-client.js';

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
  files: GitFile[];
  truncated: boolean;
}

interface GitBranches {
  current: string | null;
  detached: boolean;
  branches: { name: string; current: boolean; upstream: string | null }[];
}

export interface ScmDeps {
  toast(message: string): void;
  openModal(title: string, bodyHtml: string, onOk: () => void): void;
  hasWorkspace(): boolean;
  /** Called after an action changed files on disk (discard, branch switch). */
  onFilesChanged(): void;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const escapeHtml = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

let deps: ScmDeps;
let status: GitStatus | null = null;
let refreshSeq = 0;

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

function button(label: string, act: string, path: string, extra = ''): string {
  return `<button class="mini ${extra}" data-act="${act}" data-path="${escapeHtml(path)}">${label}</button>`;
}

function renderGroups(): void {
  const files = status?.files ?? [];
  const html = GROUPS.map((group) => {
    const items = files.filter(group.pick);
    if (items.length === 0 && group.kind === 'conflict') return '';
    const bulk = items.length === 0 ? ''
      : group.kind === 'staged' ? `<button class="mini" data-act="unstage-all">Unstage all</button>`
      : group.kind === 'conflict' ? ''
      : `<button class="mini" data-act="stage-all" data-group="${group.kind}">Stage all</button>`;
    const rows = items.map((f) => {
      const name = f.origPath ? `${escapeHtml(f.origPath)} &rarr; ${escapeHtml(f.path)}` : escapeHtml(f.path);
      const actions =
        group.kind === 'staged' ? button('Unstage', 'unstage', f.path) + button('Diff', 'diff-staged', f.path)
        : group.kind === 'conflict' ? button('Diff', 'diff', f.path)
        : button('Stage', 'stage', f.path) + button('Diff', 'diff', f.path) + button('Discard', 'discard', f.path, 'danger');
      return `<div class="scm-row" data-scm-file="${escapeHtml(f.path)}"><span class="scm-letter">${escapeHtml(letter(group.kind, f))}</span><span class="scm-path" title="${escapeHtml(f.path)}">${name}</span><span class="scm-actions">${actions}</span></div>`;
    }).join('');
    return `<div class="card scm-group" data-scm-group="${group.kind}"><div class="card-head"><strong>${group.title} (${items.length})</strong>${bulk}</div>${rows || '<p class="muted">Tidak ada.</p>'}</div>`;
  }).join('');
  $('scmGroups').innerHTML = html + (status?.truncated ? '<p class="muted">Daftar dipotong (terlalu banyak perubahan).</p>' : '');
}

function renderCommitButton(): void {
  const staged = (status?.files ?? []).some((f) => f.staged);
  const message = ($('commitMsg') as HTMLTextAreaElement).value.trim();
  ($('commitBtn') as HTMLButtonElement).disabled = !(status?.isRepo && staged && message);
}

function renderBadge(): void {
  const count = status?.isRepo ? status.files.length : 0;
  $('scmBadge').textContent = String(count);
  $('scmBadge').classList.toggle('hidden', count === 0);
}

function showState(message: string, canInit: boolean): void {
  $('scmBody').classList.add('hidden');
  const state = $('scmState');
  state.classList.remove('hidden');
  state.innerHTML = `<p>${escapeHtml(message)}</p>` + (canInit ? '<div><button id="scmInit" class="mini primary">Init repository</button></div>' : '');
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

/** Reload Git state for the active workspace and repaint the panel. */
export async function refreshScm(): Promise<void> {
  const seq = ++refreshSeq;
  if (!deps.hasWorkspace()) {
    status = null;
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
    const banner = $('conflictBanner');
    banner.classList.toggle('hidden', !next.operation);
    banner.textContent = next.operation ? `${next.operation} sedang berlangsung - selesaikan konflik di file lalu commit.` : '';
    renderGroups();
    renderCommitButton();
  } catch (err: any) {
    if (seq !== refreshSeq) return;
    status = null;
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

function diffHtml(diff: string, truncated: boolean): string {
  if (diff === '') return '<p class="muted">Tidak ada perbedaan.</p>';
  const lines = diff.split('\n').map((line) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
      : line.startsWith('-') && !line.startsWith('---') ? 'diff-del'
      : line.startsWith('@@') ? 'diff-hunk' : '';
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join('\n');
  return `<pre class="diff">${lines}</pre>` + (truncated ? '<p class="muted">Diff dipotong (terlalu besar).</p>' : '');
}

async function onGroupClick(e: Event): Promise<void> {
  const target = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!target || !status) return;
  const act = target.dataset.act!;
  const path = target.dataset.path || '';

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
    return run(async () => {
      const res: any = await bridge.call('git.diff', { path, staged: act === 'diff-staged' });
      deps.openModal(`Diff${act === 'diff-staged' ? ' (staged)' : ''}: ${path}`, diffHtml(res.diff, res.truncated), () => {});
    });
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

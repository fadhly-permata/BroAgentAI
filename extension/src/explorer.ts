/**
 * File Explorer Tree View for the BroAgentAI Side Panel.
 */
import { bridge } from "./bridge-client.js";
import { fileIcon, icon } from "./icons.js";

/** Horizontal step per tree level, px (matches --tree-indent). */
const INDENT = 10;
/** Left padding of a row at the given depth: room for the indent plus a 4px gutter. */
const pad = (depth: number) => depth * INDENT + 4;

/**
 * Folders the user has open, kept across re-renders so an auto-refresh from
 * the bridge watcher does not collapse the tree under them.
 */
const expandedPaths = new Set<string>();

/** Forget every remembered folder (e.g. after switching workspace). */
export function resetExplorerState(): void {
  expandedPaths.clear();
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  isIgnored?: boolean;
  isBinary?: boolean;
  children?: FileNode[];
  isExpanded?: boolean;
}

export interface ExplorerOptions {
  onFileClick?: (path: string) => void;
  onContextClick?: (e: MouseEvent, path: string, isDirectory: boolean) => void;
  showIgnored?: boolean;
  /** Git status letter per workspace-relative file path (M, A, D, R, U, !). */
  gitStatus?: Map<string, string>;
}

/** Badge for a file, or a dot for a folder that contains changed files. */
function gitBadge(node: FileNode, status: Map<string, string> | undefined): HTMLElement | null {
  if (!status || status.size === 0) return null;
  let letter = status.get(node.path);
  if (!letter && node.isDirectory && node.path !== '.') {
    const prefix = node.path + '/';
    for (const path of status.keys()) if (path.startsWith(prefix)) { letter = '\u2022'; break; }
  }
  if (!letter) return null;
  const badge = document.createElement('span');
  badge.className = 'badge-git';
  badge.dataset.git = letter;
  badge.textContent = letter;
  return badge;
}

export async function renderExplorer(
  rootEl: HTMLElement,
  workspacePath: string,
  options: ExplorerOptions = {}
): Promise<void> {
  rootEl.innerHTML = '<div class="ba-loading">Memuat direktori...</div>';

  try {
    const tree = await bridge.call("fs.listTree", { path: ".", maxDepth: 1, showIgnored: options.showIgnored });
    if (!tree) {
      rootEl.innerHTML = '<div class="ba-empty">Direktori kosong.</div>';
      return;
    }

    const node = tree as FileNode;
    node.isExpanded = true;
    // The root comes back as "."; show the workspace folder name like VS Code.
    if (!node.name || node.name === ".") node.name = workspacePath.split(/[\\/]/).filter(Boolean).pop() || node.name;

    rootEl.innerHTML = "";
    const treeContainer = document.createElement("div");
    treeContainer.className = "ba-tree";
    rootEl.appendChild(treeContainer);

    renderNode(treeContainer, node, 0, options);
    if (options.onContextClick) {
      // Right-click on empty tree area targets the workspace root.
      rootEl.addEventListener("contextmenu", (e) => {
        if ((e.target as HTMLElement).closest(".ba-tree-node")) return;
        e.preventDefault();
        options.onContextClick!(e, ".", true);
      });
    }
  } catch (e: any) {
    rootEl.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "ba-error";
    errEl.textContent = e.message === "BRIDGE_OFFLINE"
      ? "Bridge offline. Jalankan bridge lalu klik Retry."
      : `Gagal memuat: ${e.message}`;
    const retry = document.createElement("button");
    retry.className = "mini ba-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => renderExplorer(rootEl, workspacePath, options));
    rootEl.append(errEl, retry);
  }
}

/**
 * Render one node as `.ba-tree-item` = row (`.ba-tree-node`) + children box
 * (`.ba-tree-children`). Collapsing just empties the children box, so a
 * re-expand can never duplicate rows.
 */
function renderNode(
  container: HTMLElement,
  node: FileNode,
  depth: number,
  options: ExplorerOptions
): void {
  const item = document.createElement("div");
  item.className = "ba-tree-item";

  const row = document.createElement("div");
  row.className = "ba-tree-node";
  row.style.paddingLeft = `${pad(depth)}px`;
  row.dataset.path = node.path;
  row.tabIndex = -1;
  row.title = node.path;

  // Twistie (chevron for folders, blank spacer for files) keeps names aligned.
  const toggle = document.createElement("span");
  toggle.className = "ba-tree-toggle";
  const iconEl = document.createElement("span");
  iconEl.className = "ba-tree-icon";

  const nameSpan = document.createElement("span");
  nameSpan.className = "ba-tree-name";
  if (node.isIgnored) {
    nameSpan.classList.add("ba-ignored");
    row.title = `${node.path} (diabaikan oleh konfigurasi)`;
  }

  const select = () => {
    row.closest(".ba-tree")?.querySelectorAll(".ba-tree-node.selected").forEach((el) => el.classList.remove("selected"));
    row.classList.add("selected");
    row.focus({ preventScroll: true });
  };

  if (node.isDirectory) {
    row.classList.add("ba-tree-dir");
    if (depth === 0) row.classList.add("ba-tree-root");
    toggle.innerHTML = icon("chevron-right");
    const childrenEl = document.createElement("div");
    childrenEl.className = "ba-tree-children";
    // Indent guide sits under this folder's chevron; the root level has none.
    if (depth === 0) childrenEl.classList.add("no-guide");
    else childrenEl.style.setProperty("--guide-x", `${pad(depth) + 8}px`);

    const paint = (suffix = "") => {
      iconEl.innerHTML = fileIcon(node.name, node.isExpanded ? "dir-open" : "dir");
      nameSpan.textContent = node.name + suffix;
      row.setAttribute("aria-expanded", String(!!node.isExpanded));
    };

    const renderChildren = () => {
      childrenEl.innerHTML = "";
      if (!node.isExpanded || !node.children) return;
      const sorted = [...node.children].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const child of sorted) renderNode(childrenEl, child, depth + 1, options);
    };

    // Lazy-load a folder's children once; returns false when the bridge refused.
    const loadChildren = async (): Promise<boolean> => {
      if (node.children) return true;
      paint(" (memuat...)");
      try {
        const children = await bridge.call("fs.listDir", { path: node.path, showIgnored: options.showIgnored });
        node.children = (children as FileNode[]).map((child) => ({ ...child, isExpanded: false }));
        paint();
        return true;
      } catch (err: any) {
        paint(" (gagal)");
        console.warn("Failed to load directory:", err);
        return false;
      }
    };

    if (options.onContextClick) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        select();
        options.onContextClick!(e, node.path, true);
      });
    }

    row.addEventListener("click", async () => {
      select();
      if (node.isExpanded) {
        node.isExpanded = false;
        expandedPaths.delete(node.path);
        paint();
        renderChildren();
        return;
      }
      node.isExpanded = true;
      expandedPaths.add(node.path);
      paint();
      if (!node.children) {
        const loaded = await loadChildren();
        if (!loaded) {
          // Failed to read the folder: leave it closed so the next click retries.
          node.isExpanded = false;
          expandedPaths.delete(node.path);
        }
      }
      renderChildren();
    });

    // Re-open folders that were open before this render (auto-refresh keeps state).
    if (depth > 0 && expandedPaths.has(node.path)) node.isExpanded = true;

    paint();
    row.append(toggle, iconEl, nameSpan);
    const dirBadge = gitBadge(node, options.gitStatus);
    if (dirBadge) row.appendChild(dirBadge);
    item.append(row, childrenEl);
    container.appendChild(item);

    if (node.isExpanded && !node.children) {
      void loadChildren().then(() => renderChildren());
    } else {
      renderChildren();
    }
    return;
  }

  row.classList.add("ba-tree-file");
  row.dataset.file = node.path;
  iconEl.innerHTML = fileIcon(node.name);
  nameSpan.textContent = node.name;
  row.append(toggle, iconEl, nameSpan);

  if (node.size !== undefined) {
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "ba-tree-size";
    sizeSpan.textContent = node.isBinary ? "bin" : formatSize(node.size);
    row.appendChild(sizeSpan);
  }
  const fileBadge = gitBadge(node, options.gitStatus);
  if (fileBadge) row.appendChild(fileBadge);

  row.addEventListener("click", () => { select(); options.onFileClick?.(node.path); });
  if (options.onContextClick) {
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      select();
      options.onContextClick!(e, node.path, false);
    });
  }

  item.appendChild(row);
  container.appendChild(item);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

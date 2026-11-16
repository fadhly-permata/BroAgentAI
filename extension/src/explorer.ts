/**
 * File Explorer Tree View for the BroAgentAI Side Panel.
 */
import { bridge } from "./bridge-client.js";

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
  onContextClick?: (e: MouseEvent, path: string) => void;
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

    rootEl.innerHTML = "";
    const treeContainer = document.createElement("div");
    treeContainer.className = "ba-tree";
    rootEl.appendChild(treeContainer);

    renderNode(treeContainer, node, 0, options);
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
  row.style.paddingLeft = `${depth * 14 + 4}px`;
  row.dataset.path = node.path;

  const nameSpan = document.createElement("span");
  nameSpan.className = "ba-tree-name";
  if (node.isIgnored) {
    nameSpan.classList.add("ba-ignored");
    nameSpan.title = "Diabaikan oleh konfigurasi";
  }

  const childrenEl = document.createElement("div");
  childrenEl.className = "ba-tree-children";

  if (node.isDirectory) {
    row.classList.add("ba-tree-dir");
    const toggle = document.createElement("span");
    toggle.className = "ba-tree-toggle";

    const paint = (suffix = "") => {
      toggle.textContent = node.isExpanded ? "v" : ">";
      nameSpan.textContent = `${node.name}/${suffix}`;
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

    row.addEventListener("click", async () => {
      node.isExpanded = !node.isExpanded;
      if (node.isExpanded && !node.children) {
        paint(" (memuat...)");
        try {
          const children = await bridge.call("fs.listDir", { path: node.path, showIgnored: options.showIgnored });
          node.children = (children as FileNode[]).map((child) => ({ ...child, isExpanded: false }));
          paint();
        } catch (err: any) {
          node.isExpanded = false;
          paint(" (gagal)");
          console.warn("Failed to load directory:", err);
          return;
        }
      } else {
        paint();
      }
      renderChildren();
    });

    paint();
    row.append(toggle, nameSpan);
    const dirBadge = gitBadge(node, options.gitStatus);
    if (dirBadge) row.appendChild(dirBadge);
    item.append(row, childrenEl);
    container.appendChild(item);
    renderChildren();
    return;
  }

  row.classList.add("ba-tree-file");
  row.style.paddingLeft = `${depth * 14 + 20}px`;
  row.dataset.file = node.path;
  nameSpan.textContent = node.name;
  row.appendChild(nameSpan);
  const fileBadge = gitBadge(node, options.gitStatus);
  if (fileBadge) row.appendChild(fileBadge);

  if (node.size !== undefined) {
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "ba-tree-size";
    sizeSpan.textContent = node.isBinary ? "bin" : formatSize(node.size);
    row.appendChild(sizeSpan);
  }

  row.addEventListener("click", () => options.onFileClick?.(node.path));
  if (options.onContextClick) {
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      options.onContextClick!(e, node.path);
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

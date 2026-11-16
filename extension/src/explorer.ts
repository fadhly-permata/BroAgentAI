/**
 * File Explorer Tree View for the BrowserAgent Side Panel.
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
}

export async function renderExplorer(
  rootEl: HTMLElement,
  workspacePath: string,
  options: ExplorerOptions = {}
): Promise<void> {
  rootEl.innerHTML = '<div class="ba-loading">Memuat direktori...</div>';

  try {
    const tree = await bridge.call("fs.listTree", { path: ".", maxDepth: 1 });
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

    renderNode(treeContainer, node, workspacePath, 0, options);
  } catch (e: any) {
    const msg = e.message === "BRIDGE_OFFLINE"
      ? "Bridge offline. Jalankan bridge lalu klik Retry."
      : `Gagal memuat: ${e.message}`;
    rootEl.innerHTML = `<div class="ba-error">${msg}</div><button id="ba-retry" class="ba-btn">Retry</button>`;
    document.getElementById("ba-retry")?.addEventListener("click", () => renderExplorer(rootEl, workspacePath, options));
  }
}

function renderNode(
  container: HTMLElement,
  node: FileNode,
  workspacePath: string,
  depth: number,
  options: ExplorerOptions
): void {
  const el = document.createElement("div");
  el.className = "ba-tree-node";
  el.style.paddingLeft = `${depth * 16}px`;
  el.dataset.path = node.path;

  const icon = node.isDirectory
    ? (node.isExpanded ? "[DIR-]" : "[DIR+]")
    : (node.isBinary ? "[BIN]" : "[FILE]");

  const nameSpan = document.createElement("span");
  nameSpan.className = "ba-tree-name";
  nameSpan.textContent = `${icon} ${node.name}`;

  if (node.isIgnored) {
    nameSpan.classList.add("ba-ignored");
    nameSpan.title = "Diabaikan oleh konfigurasi";
  }

  if (!node.isDirectory && node.size !== undefined) {
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "ba-tree-size";
    sizeSpan.textContent = formatSize(node.size);
    el.appendChild(sizeSpan);
  }

  if (node.isDirectory) {
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "ba-tree-toggle";
    toggleBtn.textContent = node.isExpanded ? "v" : ">";
    toggleBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      node.isExpanded = !node.isExpanded;
      toggleBtn.textContent = node.isExpanded ? "v" : ">";

      if (node.isExpanded && !node.children) {
        nameSpan.textContent = `${icon} ${node.name} (memuat...)`;
        try {
          const children = await bridge.call("fs.listDir", { path: node.path });
          node.children = (children as any[]).map((child: any) => ({
            ...child,
            isExpanded: false,
          }));
          nameSpan.textContent = `${icon} ${node.name}`;
          renderChildren(container, node, workspacePath, depth, options);
        } catch (err: any) {
          nameSpan.textContent = `${icon} ${node.name} (gagal)`;
          console.error("Failed to load directory:", err);
        }
      } else {
        renderChildren(container, node, workspacePath, depth, options);
      }
    });
    el.insertBefore(toggleBtn, nameSpan);
  } else {
    el.classList.add("ba-tree-file");
    el.addEventListener("click", () => {
      if (options.onFileClick) {
        options.onFileClick(node.path);
      }
    });
    if (options.onContextClick) {
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        options.onContextClick!(e, node.path);
      });
    }
  }

  el.appendChild(nameSpan);
  container.appendChild(el);

  if (node.isDirectory && node.isExpanded && node.children) {
    renderChildren(container, node, workspacePath, depth, options);
  }
}

function renderChildren(
  container: HTMLElement,
  node: FileNode,
  workspacePath: string,
  depth: number,
  options: ExplorerOptions
): void {
  const existingChildren = container.querySelectorAll(
    `.ba-tree-node[data-parent="${node.path}"]`
  );
  existingChildren.forEach((child) => child.remove());

  if (!node.children || !node.isExpanded) return;

  const sorted = [...node.children].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const child of sorted) {
    const childContainer = document.createElement("div");
    childContainer.setAttribute("data-parent", node.path);
    container.appendChild(childContainer);
    renderNode(childContainer, child, workspacePath, depth + 1, options);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
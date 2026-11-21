// Resizable panes (VS Code split view): a sash sits on the top edge of every
// pane; dragging it moves the border between that pane and the one above.
// Only expanded .pane-grow panes take part (CSS shows the sash just between two
// of them). Sizes are flex weights in --pane-weight, so panes keep their ratio
// when the side panel resizes. Double-click a sash to reset; sizes persist in
// localStorage under storageKey.

const MIN_PANE = 72; // header (22px) + a couple of rows

type Weights = Record<string, number>;

function load(key: string): Weights {
  try { return JSON.parse(localStorage.getItem(key) || '{}') as Weights; } catch { return {}; }
}
function save(key: string, weights: Weights): void {
  try { localStorage.setItem(key, JSON.stringify(weights)); } catch { /* storage unavailable */ }
}

const isOpenGrow = (el: Element | null): el is HTMLElement =>
  !!el && el.classList.contains('pane-grow') && !el.classList.contains('collapsed');

export function initPanes(container: HTMLElement, storageKey: string): void {
  const panes = [...container.querySelectorAll<HTMLElement>(':scope > .pane')];
  const stored = load(storageKey);
  for (const pane of panes) {
    const weight = stored[pane.dataset.pane || ''];
    if (weight > 0) pane.style.setProperty('--pane-weight', String(weight));
  }

  for (const pane of panes.slice(1)) {
    const sash = document.createElement('div');
    sash.className = 'sash';
    sash.setAttribute('aria-hidden', 'true');
    pane.prepend(sash);

    sash.addEventListener('pointerdown', (down) => {
      const above = pane.previousElementSibling;
      if (down.button !== 0 || !isOpenGrow(above) || !isOpenGrow(pane)) return;
      down.preventDefault();
      // Freeze every open grow pane at its current pixel height so only this border moves.
      const open = panes.filter(isOpenGrow);
      // Read every height before writing any weight: each write reflows the others.
      const heights = open.map((p) => p.getBoundingClientRect().height);
      open.forEach((p, i) => p.style.setProperty('--pane-weight', String(heights[i])));
      const startY = down.clientY;
      const top0 = heights[open.indexOf(above)];
      const total = top0 + heights[open.indexOf(pane)];
      sash.classList.add('active');
      sash.setPointerCapture(down.pointerId);
      const move = (e: PointerEvent) => {
        const top = Math.max(MIN_PANE, Math.min(total - MIN_PANE, top0 + e.clientY - startY));
        above.style.setProperty('--pane-weight', String(top));
        pane.style.setProperty('--pane-weight', String(total - top));
      };
      const up = () => {
        sash.classList.remove('active');
        sash.removeEventListener('pointermove', move);
        sash.removeEventListener('pointerup', up);
        sash.removeEventListener('pointercancel', up);
        const weights: Weights = {};
        for (const p of open) weights[p.dataset.pane || ''] = Math.round(p.getBoundingClientRect().height);
        save(storageKey, weights);
      };
      sash.addEventListener('pointermove', move);
      sash.addEventListener('pointerup', up);
      sash.addEventListener('pointercancel', up);
    });

    sash.addEventListener('dblclick', () => {
      for (const p of panes) p.style.removeProperty('--pane-weight');
      save(storageKey, {});
    });
  }
}

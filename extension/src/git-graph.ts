// Commit-graph lane layout for the SCM "Graph" view.
// Pure functions only (no DOM) so the layout can be unit tested.

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** A line segment inside one row, in lane units. Top half: y 0 -> 0.5, bottom half: y 0.5 -> 1. */
export interface GraphEdge {
  from: number;
  to: number;
  half: 'top' | 'bottom';
  /** Lane whose colour the edge takes. */
  color: number;
}

export interface GraphRow {
  /** Lane of the commit dot. */
  lane: number;
  /** Colour index of the commit dot. */
  color: number;
  edges: GraphEdge[];
  /** Number of lanes this row spans (for sizing). */
  width: number;
}

/**
 * Assign each commit (newest first, topological order) to a lane and compute
 * the edges that connect it with the rows above and below.
 *
 * Every lane holds the hash it is waiting for. A commit takes the lane that
 * waits for it (leftmost when several converge), hands that lane to its first
 * parent, and opens or joins lanes for any further parents (merges).
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const freeLane = (avoid: number): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== avoid) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const before = lanes.slice();
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      lane = freeLane(-1);
      laneColor[lane] = nextColor++;
    }
    const color = laneColor[lane];
    const edges: GraphEdge[] = [];

    // Top half: lanes coming from the row above.
    for (let i = 0; i < before.length; i++) {
      const waiting = before[i];
      if (waiting === null) continue;
      if (waiting === commit.hash) {
        edges.push({ from: i, to: lane, half: 'top', color: laneColor[i] });
        if (i !== lane) lanes[i] = null; // converged into this commit
      } else {
        edges.push({ from: i, to: i, half: 'top', color: laneColor[i] });
      }
    }

    // Hand lanes to the parents. Lanes that already waited before this row
    // keep running through it, even when a merge parent joins them.
    const passing = new Set<number>();
    for (let i = 0; i < lanes.length; i++) if (lanes[i] !== null && i !== lane) passing.add(i);
    const [first, ...rest] = commit.parents;
    lanes[lane] = first ?? null;
    const parentLanes: number[] = first ? [lane] : [];
    for (const parent of rest) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = freeLane(lane);
        lanes[target] = parent;
        laneColor[target] = nextColor++;
      }
      if (!parentLanes.includes(target)) parentLanes.push(target);
    }

    // Bottom half: pass-through lanes, plus edges from the dot to each parent lane.
    for (const i of passing) edges.push({ from: i, to: i, half: 'bottom', color: laneColor[i] });
    for (const target of parentLanes) {
      edges.push({ from: lane, to: target, half: 'bottom', color: laneColor[target] });
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane + 1, before.length, lanes.length);
    rows.push({ lane, color, edges, width });
  }
  return rows;
}

/** Split `git log %D` decorations into display chips. */
export function refChips(refs: readonly string[]): { label: string; kind: 'head' | 'tag' | 'remote' | 'branch' }[] {
  const chips: { label: string; kind: 'head' | 'tag' | 'remote' | 'branch' }[] = [];
  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) chips.push({ label: ref.slice(8), kind: 'head' });
    else if (ref === 'HEAD') chips.push({ label: 'HEAD', kind: 'head' });
    else if (ref.startsWith('tag: ')) chips.push({ label: ref.slice(5), kind: 'tag' });
    else if (ref.includes('/')) chips.push({ label: ref, kind: 'remote' });
    else chips.push({ label: ref, kind: 'branch' });
  }
  return chips;
}

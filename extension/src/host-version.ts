export interface ParsedVersion {
  core: number[];
  pre: string[];
}

export type VersionOrder = -1 | 0 | 1 | null;
export type HostVersionStatus = 'matching' | 'mismatch' | 'unknown';

export interface HostVersionComparison {
  status: HostVersionStatus;
  extensionVersion: string;
  hostVersion: string;
  relation: VersionOrder;
}

export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  const core = match[1].split('.').map(Number);
  if (core.some((n) => !Number.isSafeInteger(n))) return null;
  const pre = match[2] ? match[2].split('.') : [];
  if (pre.some((part) => !part)) return null;
  return { core, pre };
}

export function compareVersions(left: unknown, right: unknown): VersionOrder {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareHostVersions(extensionVersion: unknown, info: unknown): HostVersionComparison {
  const ext = typeof extensionVersion === 'string' ? extensionVersion.trim() : '';
  const raw = typeof info === 'object' && info !== null ? (info as { hostVersion?: unknown }).hostVersion : undefined;
  const host = typeof raw === 'string' ? raw.trim() : '';
  const relation = compareVersions(ext, host);
  return {
    status: relation === null ? 'unknown' : relation === 0 ? 'matching' : 'mismatch',
    extensionVersion: ext,
    hostVersion: host,
    relation,
  };
}

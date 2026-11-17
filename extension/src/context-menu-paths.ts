/** Pure path helpers for the explorer context menu (no DOM imports; unit tested). */

/** Workspace-relative paths use '/', the workspace root is '.'. */
export const ROOT = '.';

export function parentDir(path: string): string {
  if (path === ROOT) return ROOT;
  const i = path.lastIndexOf('/');
  return i <= 0 ? ROOT : path.slice(0, i);
}

export function baseName(path: string): string {
  if (path === ROOT) return '';
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Directory that "New File/Folder" should create into. */
export function targetDir(path: string, isDirectory: boolean): string {
  return isDirectory ? path : parentDir(path);
}

export function joinRel(dir: string, name: string): string {
  const clean = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return dir === ROOT || dir === '' ? clean : `${dir}/${clean}`;
}

/** Absolute path from workspace root + relative path, using the root's separator style. */
export function toAbsolute(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  if (rel === ROOT || rel === '') return base;
  return base + sep + rel.split('/').join(sep);
}

/** Returns an error message, or null when the entered name is acceptable. */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Nama tidak boleh kosong';
  const segs = n.replace(/\\/g, '/').split('/');
  if (segs.some((s) => s === '..')) return "Nama tidak boleh mengandung '..'";
  if (/^([a-zA-Z]:|\/)/.test(n)) return 'Gunakan path relatif';
  if (segs.filter((s) => s !== '' && s !== '.').length === 0) return 'Nama tidak valid';
  return null;
}

/** [start, end) of the basename without extension, for pre-selecting in Rename. */
export function baseSelection(name: string): [number, number] {
  const dot = name.lastIndexOf('.');
  return [0, dot > 0 ? dot : name.length];
}

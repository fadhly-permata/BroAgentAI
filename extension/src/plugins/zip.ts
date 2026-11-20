// Minimal .zip reader/writer for web chat plugin packages (specs/09 §3.1, R28).
// No dependency: the reader inflates with the platform's DecompressionStream
// ("deflate-raw"), the writer stores files uncompressed. Pure byte handling, so
// node:test covers it.

/** Hard caps checked from the zip headers BEFORE anything is inflated (R28). */
export const ZIP_LIMITS = {
  /** Entries in the archive, folders included. */
  entries: 50,
  /** Files kept (see readZip). */
  files: 10,
  /** Sum of the kept files' uncompressed sizes. */
  totalBytes: 512 * 1024,
};

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Normalize an archive or folder path: forward slashes, no leading "./".
 * Returns null for anything that could escape the plugin (absolute paths,
 * drive letters, "..").
 */
export function safeRelativePath(name: string): string | null {
  const path = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (path === '' || path.startsWith('/') || /^[a-z]:/i.test(path)) return null;
  if (path.split('/').some((part) => part === '..')) return null;
  return path;
}

/**
 * Drop one shared top-level folder ("my-plugin/plugin.json" → "plugin.json")
 * and keep only files directly at the plugin root. Nested files are ignored.
 */
export function rootFiles<T>(entries: Array<[string, T]>): Map<string, T> {
  const paths = entries.map(([path]) => path);
  const tops = new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
  const strip = tops.size === 1 && !tops.has('') ? [...tops][0] + '/' : '';
  const out = new Map<string, T>();
  for (const [path, value] of entries) {
    const rel = path.slice(strip.length);
    if (rel !== '' && !rel.includes('/')) out.set(rel, value);
  }
  return out;
}

export class ZipError extends Error {}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    // The header said `expected`; a stream that keeps going is a zip bomb.
    if (size > expected) { await reader.cancel(); throw new ZipError('a file inflates beyond the size its header declares'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/**
 * Read a plugin .zip: the files at the plugin root (one top-level folder is
 * stripped). Rejects encrypted entries, symlinks, unsafe paths, too many
 * entries/files and too many bytes, all before inflating anything.
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a .zip file');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count > ZIP_LIMITS.entries) throw new ZipError(`the .zip has ${count} entries (max ${ZIP_LIMITS.entries})`);

  type Entry = { method: number; compSize: number; size: number; crc: number; local: number };
  const entries: Array<[string, Entry]> = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIG) throw new ZipError('broken .zip directory');
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const external = view.getUint32(offset + 38, true);
    const local = view.getUint32(offset + 42, true);
    const rawName = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue; // folder entry
    const name = safeRelativePath(rawName);
    if (!name) throw new ZipError(`unsafe path in the .zip: ${rawName}`);
    if (flags & 0x1) throw new ZipError(`encrypted file in the .zip: ${name}`);
    if (madeBy >> 8 === 3 && ((external >>> 16) & 0o170000) === 0o120000) throw new ZipError(`symlink in the .zip: ${name}`);
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression in the .zip: ${name}`);
    entries.push([name, { method, compSize, size, crc, local }]);
  }

  const kept = rootFiles(entries);
  if (kept.size > ZIP_LIMITS.files) throw new ZipError(`the plugin has ${kept.size} files (max ${ZIP_LIMITS.files})`);
  const total = [...kept.values()].reduce((sum, e) => sum + e.size, 0);
  if (total > ZIP_LIMITS.totalBytes) throw new ZipError(`the plugin files total ${total} bytes (max ${ZIP_LIMITS.totalBytes})`);

  const files = new Map<string, Uint8Array>();
  for (const [name, e] of kept) {
    if (e.local + 30 > bytes.length || view.getUint32(e.local, true) !== LOCAL_SIG) throw new ZipError(`broken .zip entry: ${name}`);
    const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
    const data = bytes.subarray(start, start + e.compSize);
    if (data.length !== e.compSize) throw new ZipError(`truncated .zip entry: ${name}`);
    const content = e.method === 0 ? data.slice() : await inflateRaw(data, e.size);
    if (content.length !== e.size) throw new ZipError(`size mismatch in the .zip: ${name}`);
    if (crc32(content) !== e.crc) throw new ZipError(`checksum mismatch in the .zip: ${name}`);
    files.set(name, content);
  }
  return files;
}

/** Write files into an uncompressed .zip under one folder (the plugin id). */
export function writeZip(folder: string, files: Map<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const path = enc.encode(`${folder}/${name}`);
    const crc = crc32(data);
    const local = new Uint8Array(30 + path.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true); lv.setUint16(4, 20, true); lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, path.length, true); local.set(path, 30);
    const central = new Uint8Array(46 + path.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, path.length, true); cv.setUint32(42, offset, true); central.set(path, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true); ev.setUint16(8, files.size, true); ev.setUint16(10, files.size, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

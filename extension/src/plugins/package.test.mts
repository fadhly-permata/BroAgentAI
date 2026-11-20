import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { crc32, readZip, rootFiles, safeRelativePath, writeZip, ZIP_LIMITS } from './zip.ts';
import { buildPackage, cssOutsideMarks, packageFiles, FILE_LIMITS } from './package.ts';
import { patternsOverlap, planInstall, type InstalledPlugin } from './conflicts.ts';
import type { PluginManifest } from './manifest.ts';

const enc = new TextEncoder();
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    apiVersion: 1, id: 'my-chat', name: 'My Chat', version: '1.0.0', author: 'Me',
    homepage: 'https://chat.example.com/', matches: ['https://chat.example.com/*'], status: 'experimental',
    selectors: { composer: 'textarea', assistantMessage: '.reply' },
    ...overrides,
  };
}
const files = (entries: Record<string, string | Uint8Array>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));

/** A hand-built zip with chosen entry names, methods and header values. */
function rawZip(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean; declaredSize?: number; flags?: number; symlink?: boolean }>): Uint8Array {
  const parts: Uint8Array[] = []; const centrals: Uint8Array[] = []; let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const size = e.declaredSize ?? e.data.length;
    const local = new Uint8Array(30 + name.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(6, e.flags ?? 0, true); lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(14, crc32(e.data), true); lv.setUint32(18, body.length, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, e.symlink ? 0x031e : 20, true); cv.setUint16(8, e.flags ?? 0, true); cv.setUint16(10, e.deflate ? 8 : 0, true);
    cv.setUint32(16, crc32(e.data), true); cv.setUint32(20, body.length, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
    if (e.symlink) cv.setUint32(38, (0o120777 << 16) >>> 0, true);
    cv.setUint32(42, offset, true); central.set(name, 46);
    parts.push(local, body); centrals.push(central); offset += local.length + body.length;
  }
  const cs = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cs, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...centrals, eocd]; const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

test('safeRelativePath refuses paths that could leave the plugin', () => {
  for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:/x', 'C:\\x', '']) assert.equal(safeRelativePath(bad), null, bad);
  assert.equal(safeRelativePath('./a\\b.json'), 'a/b.json');
});

test('rootFiles strips one top folder and ignores nested files', () => {
  const m = rootFiles([['p/plugin.json', 1], ['p/style.css', 2], ['p/deep/x.js', 3]]);
  assert.deepEqual([...m.keys()].sort(), ['plugin.json', 'style.css']);
  const flat = rootFiles([['plugin.json', 1], ['sub/x.js', 2]]);
  assert.deepEqual([...flat.keys()], ['plugin.json']);
});

test('writeZip output reads back through readZip (export → import)', async () => {
  const input = files({ 'plugin.json': JSON.stringify(manifest()), 'style.css': '[data-ba-agent]{color:red}', 'icon.png': PNG });
  const back = await readZip(writeZip('my-chat', input));
  assert.deepEqual([...back.keys()].sort(), ['icon.png', 'plugin.json', 'style.css']);
  assert.deepEqual(back.get('icon.png'), PNG);
});

test('readZip inflates deflated entries and checks their checksum', async () => {
  const text = enc.encode('[data-ba-agent] { color: red; }'.repeat(20));
  const zip = rawZip([{ name: 'plugin/style.css', data: text, deflate: true }]);
  assert.deepEqual((await readZip(zip)).get('style.css'), text);
});

test('readZip refuses hostile archives before inflating them (R28)', async () => {
  const one = enc.encode('x');
  await assert.rejects(readZip(enc.encode('not a zip at all, definitely not')), /not a \.zip/);
  await assert.rejects(readZip(rawZip([{ name: '../evil.js', data: one }])), /unsafe path/);
  await assert.rejects(readZip(rawZip([{ name: 'p/x.js', data: one, flags: 1 }])), /encrypted/);
  await assert.rejects(readZip(rawZip([{ name: 'p/link', data: one, symlink: true }])), /symlink/);
  const many = Array.from({ length: ZIP_LIMITS.files + 1 }, (_, i) => ({ name: `p/f${i}.css`, data: one }));
  await assert.rejects(readZip(rawZip(many)), /files \(max/);
  await assert.rejects(readZip(rawZip([{ name: 'p/big.css', data: one, declaredSize: ZIP_LIMITS.totalBytes + 1 }])), /bytes \(max/);
  // Zip bomb: the header claims 10 bytes, the data inflates to far more.
  const bomb = rawZip([{ name: 'p/style.css', data: new Uint8Array(100_000), deflate: true, declaredSize: 10 }]);
  await assert.rejects(readZip(bomb), /inflates beyond/);
});

test('buildPackage accepts a full plugin and turns the icon into a data URL', () => {
  const result = buildPackage(files({
    'plugin.json': JSON.stringify(manifest({ script: 'plugin.js', style: 'style.css', icon: 'icon.png' })),
    'plugin.js': "BroAgentAI.registerPlugin('my-chat', {});",
    'style.css': '[data-ba-agent] { color: red }',
    'icon.png': PNG,
  }));
  assert.ok(result.ok, result.ok ? '' : result.errors.join('; '));
  assert.match(result.pkg.icon!.dataUrl, /^data:image\/png;base64,/);
  assert.ok(result.warnings.some((w) => /contains code that runs on/.test(w)), 'script warning');
  assert.ok(!result.warnings.some((w) => /restyles the chat site/.test(w)));
  // Export gives the same files back.
  const back = packageFiles(result.pkg);
  assert.deepEqual(back.get('icon.png'), PNG);
  assert.equal(new TextDecoder().decode(back.get('style.css')), '[data-ba-agent] { color: red }');
});

test('buildPackage reports missing, oversized and unnamed files', () => {
  const missing = buildPackage(files({ 'plugin.json': JSON.stringify(manifest({ style: 'style.css' })) }));
  assert.ok(!missing.ok && missing.errors.some((e) => /style "style.css" .* missing/.test(e)));
  const big = buildPackage(files({ 'plugin.json': JSON.stringify(manifest({ style: 'style.css' })), 'style.css': 'a'.repeat(FILE_LIMITS.style + 1) }));
  assert.ok(!big.ok && big.errors.some((e) => /larger than 64 KB/.test(e)));
  const badIcon = buildPackage(files({ 'plugin.json': JSON.stringify(manifest({ icon: 'icon.gif' })), 'icon.gif': PNG }));
  assert.ok(!badIcon.ok && badIcon.errors.some((e) => /\.png or \.svg/.test(e)));
  const extra = buildPackage(files({ 'plugin.json': JSON.stringify(manifest()), 'notes.txt': 'hi' }));
  assert.ok(extra.ok && extra.warnings.some((w) => /notes.txt is not named/.test(w)));
  assert.ok(!buildPackage(files({ 'style.css': 'x' })).ok);
  assert.ok(!buildPackage(files({ 'plugin.json': '{ not json' })).ok);
});

test('cssOutsideMarks lists selectors that restyle the site itself (R9)', () => {
  const css = `/* comment { } */ [data-ba-agent] { color: red }
    #app .x[data-ba-agent], body { margin: 0 }
    @media (max-width: 600px) { .sidebar { display: none } [data-ba-agent]::after { top: 0 } }`;
  assert.deepEqual(cssOutsideMarks(css), ['body', '.sidebar']);
});

test('patternsOverlap compares hosts, with leading *. wildcards', () => {
  assert.ok(patternsOverlap('https://chat.example.com/*', 'https://chat.example.com/app/*'));
  assert.ok(patternsOverlap('https://*.example.com/*', 'https://chat.example.com/*'));
  assert.ok(patternsOverlap('https://*.example.com/*', 'https://example.com/*'));
  assert.ok(!patternsOverlap('https://chat.example.com/*', 'https://other.example.com/*'));
  assert.ok(!patternsOverlap('https://*.example.com/*', 'https://example.org/*'));
});

test('planInstall tells new, update, override, id clash and domain conflicts apart', () => {
  const builtin: InstalledPlugin = { manifest: manifest({ id: 'deepseek', name: 'DeepSeek', author: 'BroAgentAI', matches: ['https://chat.deepseek.com/*'], homepage: 'https://chat.deepseek.com/' }), source: 'builtin', enabled: true };
  const user: InstalledPlugin = { manifest: manifest({ version: '1.2.0' }), source: 'user', enabled: true };
  const installed = [builtin, user];

  assert.equal(planInstall(manifest({ id: 'fresh', matches: ['https://fresh.example.org/*'], homepage: 'https://fresh.example.org/' }), installed).kind, 'new');

  const update = planInstall(manifest({ version: '1.1.0', author: 'Someone else', matches: ['https://chat.example.com/*', 'https://beta.example.com/*'] }), installed);
  assert.equal(update.kind, 'update');
  if (update.kind === 'update') {
    assert.equal(update.downgrade, true);
    assert.equal(update.authorChanged, true);
    assert.deepEqual(update.addedMatches, ['https://beta.example.com/*']);
  }

  const override = planInstall(manifest({ id: 'deepseek', matches: ['https://chat.deepseek.com/*'], homepage: 'https://chat.deepseek.com/' }), installed);
  assert.equal(override.kind, 'override');

  // Same id, different site: not an update (R29).
  assert.equal(planInstall(manifest({ matches: ['https://elsewhere.example.org/*'], homepage: 'https://elsewhere.example.org/' }), installed).kind, 'idClash');

  // Another id claiming DeepSeek's domain: a domain conflict with the built-in (R2, R6).
  const rival = planInstall(manifest({ id: 'deepseek-v2', matches: ['https://chat.deepseek.com/*'], homepage: 'https://chat.deepseek.com/' }), installed);
  assert.equal(rival.kind, 'new');
  if (rival.kind === 'new') assert.deepEqual(rival.domainConflicts.map((c) => c.id), ['deepseek']);

  // A disabled plugin does not block a domain.
  const disabled = planInstall(manifest({ id: 'deepseek-v2', matches: ['https://chat.deepseek.com/*'], homepage: 'https://chat.deepseek.com/' }), [{ ...builtin, enabled: false }]);
  assert.ok(disabled.kind === 'new' && disabled.domainConflicts.length === 0);
});

import { compactDiff, lineDiff } from './diff.ts';

test('lineDiff finds added and removed lines; compactDiff keeps only the changes with context', () => {
  const diff = lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nC\nd\ne\nf\ng\nh')!;
  assert.deepEqual(diff.filter((l) => l.kind !== 'same').map((l) => `${l.kind}:${l.text}`), ['del:c', 'add:C', 'add:h']);
  const compact = compactDiff(diff, 1).map((l) => (l ? `${l.kind}:${l.text}` : '...'));
  assert.deepEqual(compact, ['same:b', 'del:c', 'add:C', 'same:d', '...', 'same:g', 'add:h']);
  assert.deepEqual(lineDiff('', 'x'), [{ kind: 'add', text: 'x' }]);
  assert.equal(lineDiff('x\n'.repeat(3000), 'y'), null);
});

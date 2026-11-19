// Settings > Plugins: the only place where web chat plugins are managed
// (specs/09-WEBCHAT-PLUGINS.md §4.4–4.6). Install from a folder or .zip after a
// review, update, export, remove/reset, turn on/off, re-grant site access,
// reload open tabs and check a plugin on an open chat tab.
import { builtInPlugins, pluginEntries, refreshProviders } from './providers/registry.js';
import { buildPackage, packageFiles, type PackageResult, type PluginPackage } from './plugins/package.ts';
import { readZip, rootFiles, safeRelativePath, writeZip, ZIP_LIMITS, ZipError } from './plugins/zip.ts';
import { manifestsOverlap, planInstall, type DomainConflict, type InstallPlan, type InstalledPlugin } from './plugins/conflicts.ts';
import { installPackage, loadPluginState, removeUserPlugin, setPluginEnabled, type PluginRef } from './plugins/store.ts';
import { compactDiff, lineDiff } from './plugins/diff.ts';
import type { PluginEntry } from './plugins/merge.ts';

export interface PluginsDeps {
  toast(message: string): void;
  openModal(title: string, bodyHtml: string, onOk: () => void): void;
}

/** Built-in plugin scripts as text, only for "Export .zip". */
const builtInScripts = import.meta.glob('../plugins/*/*.js', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };
/** Strings follow the panel language (Settings > Display & Language). */
const tr = (en: string, id: string) => (document.documentElement.lang === 'en' ? en : id);

let deps: PluginsDeps;
/** Whether Chrome granted site access, per user plugin id (filled while rendering). */
let access = new Map<string, boolean>();

const installed = (): InstalledPlugin[] => pluginEntries.map((e) => ({ manifest: e.manifest, source: e.source, enabled: e.enabled && !e.problem }));

// ---------- list ----------

async function computeAccess(): Promise<void> {
  const next = new Map<string, boolean>();
  for (const e of pluginEntries) {
    if (e.source !== 'user') continue;
    next.set(e.id, await chrome.permissions.contains({ origins: e.manifest.matches }).catch(() => false));
  }
  access = next;
}

function badges(e: PluginEntry): string {
  const b: string[] = [];
  b.push(e.source === 'builtin' ? `<span class="pl-badge">${tr('Built-in', 'Bawaan')}</span>` : e.overridesBuiltin ? `<span class="pl-badge warn">${tr('Override', 'Pengganti bawaan')}</span>` : `<span class="pl-badge warn">${tr('Custom', 'Custom')}</span>`);
  if (e.hasScript) b.push(`<span class="pl-badge" title="${esc(tr('Has plugin.js hooks', 'Punya hook plugin.js'))}">${tr('Script', 'Script')}${e.source === 'user' ? ' · ' + tr('not run yet', 'belum dijalankan') : ''}</span>`);
  if (e.problem) b.push(`<span class="pl-badge err">${tr('Needs update', 'Perlu update')}</span>`);
  if (e.source === 'user' && e.enabled && access.get(e.id) === false) b.push(`<span class="pl-badge err">${tr('Access revoked', 'Akses dicabut')}</span>`);
  if (!e.enabled) b.push(`<span class="pl-badge">${tr('Off', 'Mati')}</span>`);
  return b.join('');
}

function row(e: PluginEntry): string {
  const icon = e.icon ? `<img class="pl-icon" src="${esc(e.icon)}" alt="">` : '<span class="pl-icon pl-icon-none"></span>';
  const acts: string[] = [];
  if (e.source === 'user' && e.enabled && access.get(e.id) === false) acts.push(`<button class="mini primary" data-pl-act="grant">${tr('Re-grant access', 'Izinkan lagi')}</button>`);
  acts.push(`<button class="mini" data-pl-act="health">${tr('Check on open tab', 'Cek di tab')}</button>`);
  acts.push(`<button class="mini" data-pl-act="reload">${tr('Reload open tabs', 'Muat ulang tab')}</button>`);
  acts.push(`<button class="mini" data-pl-act="update">${tr('Update', 'Update')}</button>`);
  acts.push(`<button class="mini" data-pl-act="export">${tr('Export .zip', 'Export .zip')}</button>`);
  if (e.source === 'user') acts.push(`<button class="mini danger" data-pl-act="remove">${e.overridesBuiltin ? tr('Reset to built-in', 'Kembalikan bawaan') : tr('Remove', 'Hapus')}</button>`);
  return `<div class="pl-row${e.enabled ? '' : ' off'}" data-pl-id="${esc(e.id)}" data-pl-source="${e.source}">`
    + `<div class="pl-head">${icon}<div class="pl-title"><b>${esc(e.manifest.name)}</b> <span class="muted">${esc(e.manifest.version)}${e.manifest.author ? ' · ' + esc(e.manifest.author) : ''}</span><div class="pl-badges">${badges(e)}</div></div>`
    + `<label class="pl-switch" title="${esc(tr('Turn on/off', 'Nyalakan/matikan'))}"><input type="checkbox" data-pl-act="toggle"${e.enabled ? ' checked' : ''}${e.problem ? ' disabled' : ''}><span></span></label></div>`
    + `<div class="pl-domains">${e.manifest.matches.map((m) => `<code>${esc(m)}</code>`).join(' ')}</div>`
    + (e.problem ? `<p class="err">${esc(e.problem)}</p>` : '')
    + `<div class="btn-row pl-actions">${acts.join('')}</div></div>`;
}

export async function renderPlugins(): Promise<void> {
  const body = document.getElementById('pluginsBody');
  if (!body || !deps) return;
  await computeAccess();
  const anyScript = pluginEntries.some((e) => e.source === 'user' && e.hasScript);
  body.innerHTML =
    `<p class="setting-desc">${tr('Each web chat BroAgentAI drives is a plugin: its selectors, how BroAgentAI looks on that site, and hooks for its quirks. Import a plugin folder or .zip to add a chat or replace a built-in one; nothing is rebuilt.', 'Tiap web chat yang dijalankan BroAgentAI adalah plugin: selector-nya, tampilan BroAgentAI di site itu, dan hook untuk keanehannya. Import folder atau .zip plugin untuk menambah chat atau mengganti yang bawaan; tanpa rebuild.')}</p>`
    + `<div class="btn-row"><button class="mini primary" data-pl-act="import-folder">${tr('Import folder…', 'Import folder…')}</button><button class="mini primary" data-pl-act="import-zip">${tr('Import .zip…', 'Import .zip…')}</button></div>`
    + (anyScript ? `<p class="hint">${tr('plugin.js hooks of custom plugins do not run yet; their selectors and style.css do.', 'Hook plugin.js milik plugin custom belum dijalankan; selector dan style.css-nya sudah.')}</p>` : '')
    + `<div class="pl-list">${pluginEntries.map(row).join('')}</div>`;
}

// ---------- reading a package ----------

async function filesFromFolder(list: FileList): Promise<Map<string, Uint8Array>> {
  const entries: Array<[string, File]> = [];
  for (const file of Array.from(list)) {
    const path = safeRelativePath(file.webkitRelativePath || file.name);
    if (path) entries.push([path, file]);
  }
  const root = rootFiles(entries);
  // Same caps as a .zip, checked on file sizes before reading anything (R18, R28).
  if (root.size > ZIP_LIMITS.files) throw new ZipError(tr(`The folder has ${root.size} files at its root (max ${ZIP_LIMITS.files}).`, `Folder punya ${root.size} file di root (maks ${ZIP_LIMITS.files}).`));
  const total = [...root.values()].reduce((s, f) => s + f.size, 0);
  if (total > ZIP_LIMITS.totalBytes) throw new ZipError(tr(`The plugin files total ${total} bytes (max ${ZIP_LIMITS.totalBytes}).`, `Total file plugin ${total} byte (maks ${ZIP_LIMITS.totalBytes}).`));
  const files = new Map<string, Uint8Array>();
  for (const [name, file] of root) files.set(name, new Uint8Array(await file.arrayBuffer()));
  return files;
}

function pickFiles(kind: 'folder' | 'zip'): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (kind === 'folder') input.webkitdirectory = true;
    else input.accept = '.zip,application/zip';
    input.addEventListener('change', () => resolve(input.files && input.files.length > 0 ? input.files : null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

async function importFrom(kind: 'folder' | 'zip'): Promise<void> {
  const picked = await pickFiles(kind);
  if (!picked) return;
  let result: PackageResult;
  try {
    const files = kind === 'zip' ? await readZip(new Uint8Array(await picked[0].arrayBuffer())) : await filesFromFolder(picked);
    result = buildPackage(files);
  } catch (err) {
    deps.openModal(tr('Plugin not imported', 'Plugin tidak diimport'), `<p class="err">${esc(err instanceof Error ? err.message : String(err))}</p>`, () => {});
    return;
  }
  review(result);
}

// ---------- review ----------

const sortedJson = (value: object) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))), null, 2);

function list(items: string[], cls = ''): string {
  return items.length === 0 ? '' : `<ul class="pl-list-items ${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function diffHtml(before: string | undefined, after: string | undefined, label: string): string {
  if ((before ?? '') === (after ?? '')) return '';
  const diff = lineDiff(before ?? '', after ?? '');
  if (!diff) return `<h4>${esc(label)}</h4><pre class="pl-code">${esc(after ?? '')}</pre>`;
  const lines = compactDiff(diff).map((l) => (l === null ? '<span class="pl-gap">…</span>' : `<span class="pl-${l.kind}">${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} ${esc(l.text)}</span>`));
  // Each line is a block-level span, so no "\n" between them (that would double the spacing).
  return `<h4>${esc(label)}</h4><pre class="pl-code pl-diff">${lines.join('')}</pre>`;
}

async function previousPackage(plan: InstallPlan, id: string): Promise<Partial<PluginPackage> | null> {
  if (plan.kind === 'update') return (await loadPluginState()).user[id] ?? null;
  if (plan.kind === 'override') {
    const b = builtInPlugins.find((x) => x.manifest.id === id);
    return b ? { manifest: b.manifest, style: b.style, script: builtInScriptText(id) } : null;
  }
  return null;
}

function builtInScriptText(id: string): string | undefined {
  const b = builtInPlugins.find((x) => x.manifest.id === id);
  return b?.manifest.script ? builtInScripts[`../plugins/${id}/${b.manifest.script}`] : undefined;
}

async function review(result: PackageResult): Promise<void> {
  const title = tr('Review plugin', 'Review plugin');
  if (!result.ok) {
    deps.openModal(tr('Plugin cannot be installed', 'Plugin tidak bisa dipasang'), `<p>${tr('Fix these problems in the plugin and import it again:', 'Perbaiki masalah ini di plugin lalu import lagi:')}</p>${list(result.errors, 'err')}${list(result.warnings)}`, () => {});
    return;
  }
  const { pkg, warnings } = result;
  const m = pkg.manifest;
  const plan = planInstall(m, installed());
  if (plan.kind === 'idClash') {
    deps.openModal(tr('Plugin id already used', 'ID plugin sudah dipakai'), `<p>${esc(tr(`"${m.id}" is already used by "${plan.existing.name}" for other sites (${plan.existing.matches.join(', ')}). This is not an update of it. Change the id in plugin.json and import again.`, `"${m.id}" sudah dipakai "${plan.existing.name}" untuk site lain (${plan.existing.matches.join(', ')}). Ini bukan update-nya. Ganti id di plugin.json lalu import lagi.`))}</p>`, () => {});
    return;
  }
  const prev = await previousPackage(plan, m.id);
  const notes: string[] = [];
  if (plan.kind === 'new') notes.push(tr('New plugin.', 'Plugin baru.'));
  if (plan.kind === 'update') {
    notes.push(tr(`Update of "${plan.previous.name}" from ${plan.previous.version} to ${m.version}.`, `Update "${plan.previous.name}" dari ${plan.previous.version} ke ${m.version}.`));
    if (plan.downgrade) notes.push(tr('⚠ This is an older version (rollback).', '⚠ Ini versi lebih lama (rollback).'));
    if (plan.authorChanged) notes.push(tr(`⚠ Different author: "${plan.previous.author ?? '-'}" → "${m.author ?? '-'}".`, `⚠ Author beda: "${plan.previous.author ?? '-'}" → "${m.author ?? '-'}".`));
  }
  if (plan.kind === 'override') notes.push(tr(`Replaces the built-in "${plan.builtin.name}" until you reset it.`, `Mengganti plugin bawaan "${plan.builtin.name}" sampai Anda kembalikan.`));
  if ((plan.kind === 'update' || plan.kind === 'override') && plan.addedMatches.length) notes.push(tr(`New sites: ${plan.addedMatches.join(', ')}`, `Site baru: ${plan.addedMatches.join(', ')}`));
  if ((plan.kind === 'update' || plan.kind === 'override') && plan.removedMatches.length) notes.push(tr(`Sites no longer used: ${plan.removedMatches.join(', ')}`, `Site yang tidak dipakai lagi: ${plan.removedMatches.join(', ')}`));
  const conflicts: DomainConflict[] = plan.domainConflicts;
  const conflictHtml = conflicts.length === 0 ? '' : `<div class="callout callout-warn"><span>${esc(tr('One plugin per site: installing turns these off:', 'Satu plugin per site: memasang ini akan mematikan:'))} ${conflicts.map((c) => `<b>${esc(c.name)}</b> (${esc(c.patterns.join(', '))})`).join('; ')}</span></div>`;
  const icon = pkg.icon ? `<img class="pl-icon" src="${esc(pkg.icon.dataUrl)}" alt="">` : '';
  const files = ['plugin.json', m.script, m.style, m.icon].filter(Boolean) as string[];
  let code = '';
  if (plan.kind === 'new') {
    if (pkg.script !== undefined) code += `<h4>${esc(m.script!)}</h4><pre class="pl-code">${esc(pkg.script)}</pre>`;
    if (pkg.style !== undefined) code += `<h4>${esc(m.style!)}</h4><pre class="pl-code">${esc(pkg.style)}</pre>`;
  } else {
    code += diffHtml(prev?.script, pkg.script, m.script ?? 'plugin.js');
    code += diffHtml(prev?.style, pkg.style, m.style ?? 'style.css');
    // chrome.storage hands objects back with sorted keys, so compare both sides in one key order.
    code += diffHtml(prev?.manifest ? sortedJson(prev.manifest.selectors) : '', sortedJson(m.selectors), 'selectors');
  }
  const body = `<div class="pl-head">${icon}<div class="pl-title"><b>${esc(m.name)}</b> <span class="muted">${esc(m.version)}${m.author ? ' · ' + esc(m.author) : ''} · id <code>${esc(m.id)}</code></span></div></div>`
    + (m.description ? `<p>${esc(m.description)}</p>` : '')
    + list(notes)
    + `<p>${tr('Sites (Chrome will ask for access):', 'Site (Chrome akan minta izin akses):')} ${m.matches.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>`
    + conflictHtml
    + (warnings.length ? `<h4>${tr('Warnings', 'Peringatan')}</h4>${list(warnings, 'warn')}` : '')
    + `<p class="muted">${tr('Files', 'File')}: ${files.map(esc).join(', ')}</p>`
    + code;
  deps.openModal(title, body, () => {
    // Runs inside the OK click: permissions.request needs that user gesture (R8).
    const asked = chrome.permissions.request({ origins: m.matches });
    // A failure must stay on screen with its reason (a toast disappears after 4 s).
    const fail = (why: string) => setTimeout(() => deps.openModal(tr('Plugin not installed', 'Plugin tidak dipasang'), `<p class="err">${esc(why)}</p>`, () => {}), 0);
    void (async () => {
      let granted: boolean;
      try { granted = await asked; } catch (err) { fail(tr('Chrome refused the site access request: ', 'Chrome menolak permintaan akses site: ') + (err instanceof Error ? err.message : String(err))); return; }
      if (!granted) { fail(tr('Site access was not granted, so the plugin was not installed.', 'Akses site tidak diizinkan, jadi plugin tidak dipasang.')); return; }
      try {
        await installPackage(pkg, conflicts.map((c): PluginRef => ({ id: c.id, source: c.source })));
        const done = plan.kind === 'update' ? tr(`${m.name} is now version ${m.version}.`, `${m.name} sekarang versi ${m.version}.`) : tr(`${m.name} installed.`, `${m.name} terpasang.`);
        deps.toast(done + ' ' + tr('Reload its open chat tabs to use it.', 'Muat ulang tab chat-nya yang terbuka untuk memakainya.'));
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}

// ---------- row actions ----------

function entryOf(el: HTMLElement): PluginEntry | undefined {
  const rowEl = el.closest('[data-pl-id]') as HTMLElement | null;
  return rowEl ? pluginEntries.find((e) => e.id === rowEl.dataset.plId && e.source === rowEl.dataset.plSource) : undefined;
}

async function tabsOf(e: PluginEntry): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: e.manifest.matches }).catch(() => []);
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function exportPlugin(e: PluginEntry): Promise<void> {
  let pkg: PluginPackage;
  if (e.source === 'user') {
    const stored = (await loadPluginState()).user[e.id];
    if (!stored) return;
    pkg = stored;
  } else {
    const b = builtInPlugins.find((x) => x.manifest.id === e.id)!;
    let icon: PluginPackage['icon'];
    if (b.icon && b.manifest.icon) {
      const bytes = new Uint8Array(await (await fetch(b.icon)).arrayBuffer());
      const mime = /\.svg$/i.test(b.manifest.icon) ? 'image/svg+xml' : 'image/png';
      let binary = '';
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      icon = { mime, dataUrl: `data:${mime};base64,${btoa(binary)}` };
    }
    pkg = { manifest: b.manifest, style: b.style, script: builtInScriptText(e.id), icon };
  }
  // R30: only the plugin's own files go into the archive.
  download(`${e.id}-${e.manifest.version}.zip`, writeZip(e.id, packageFiles(pkg)));
}

async function toggle(e: PluginEntry, on: boolean, input: HTMLInputElement): Promise<void> {
  const ref: PluginRef = { id: e.id, source: e.source };
  if (!on) { await setPluginEnabled(ref, false); return; }
  // Turning on: site access first (still inside the click), then one plugin per site (R2).
  const granted = e.source === 'builtin' || await chrome.permissions.request({ origins: e.manifest.matches }).catch(() => false);
  if (!granted) { input.checked = false; deps.toast(tr('Site access not granted.', 'Akses site tidak diizinkan.')); return; }
  const rivals = pluginEntries.filter((x) => x.enabled && !x.problem && x.id !== e.id && manifestsOverlap(e.manifest, x.manifest).length > 0);
  if (rivals.length === 0) { await setPluginEnabled(ref, true); return; }
  input.checked = false;
  deps.openModal(tr('Turn on plugin', 'Nyalakan plugin'), `<p>${esc(tr(`One plugin per site: turning on "${e.manifest.name}" turns off`, `Satu plugin per site: menyalakan "${e.manifest.name}" akan mematikan`))} ${rivals.map((r) => `<b>${esc(r.manifest.name)}</b>`).join(', ')}.</p>`, () => {
    void (async () => {
      for (const r of rivals) await setPluginEnabled({ id: r.id, source: r.source }, false);
      await setPluginEnabled(ref, true);
    })();
  });
}

async function remove(e: PluginEntry): Promise<void> {
  const reset = e.overridesBuiltin;
  deps.openModal(reset ? tr('Reset to built-in', 'Kembalikan ke bawaan') : tr('Remove plugin', 'Hapus plugin'),
    `<p>${esc(reset ? tr(`Remove your version of "${e.manifest.name}" and use the built-in one again?`, `Hapus versi Anda dari "${e.manifest.name}" dan pakai yang bawaan lagi?`) : tr(`Remove "${e.manifest.name}"? Its chat tabs stop working with BroAgentAI. You can import it again later.`, `Hapus "${e.manifest.name}"? Tab chat-nya berhenti bekerja dengan BroAgentAI. Bisa diimport lagi nanti.`))}</p>`,
    () => {
      void (async () => {
        await removeUserPlugin(e.id);
        // Give back site access nobody else needs (static/built-in hosts cannot be removed and are skipped).
        const still = new Set(pluginEntries.filter((x) => x.id !== e.id).flatMap((x) => x.manifest.matches));
        const release = e.manifest.matches.filter((m) => !still.has(m));
        if (release.length) await chrome.permissions.remove({ origins: release }).catch(() => false);
        deps.toast(reset ? tr('Built-in plugin restored.', 'Plugin bawaan dipakai lagi.') : tr('Plugin removed.', 'Plugin dihapus.'));
      })();
    });
}

async function health(e: PluginEntry): Promise<void> {
  const tabs = await tabsOf(e);
  if (tabs.length === 0) { deps.toast(tr(`Open ${e.manifest.homepage} in a tab first.`, `Buka ${e.manifest.homepage} di tab dulu.`)); return; }
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  const res: any = await chrome.tabs.sendMessage(tab.id!, { type: 'ba.ping' }).catch(() => null);
  const lines = !res
    ? [tr('The relay is not running on that tab. Use "Reload open tabs" (or reload the tab) and check again.', 'Relay belum jalan di tab itu. Pakai "Muat ulang tab" lalu cek lagi.')]
    : res.provider !== e.id
      ? [tr(`That tab is handled by plugin "${res.provider}", not "${e.id}".`, `Tab itu ditangani plugin "${res.provider}", bukan "${e.id}".`)]
      : [
          (res.composer ? '✓ ' : '✗ ') + tr('Chat input found', 'Kolom chat ketemu'),
          `${res.messages} ${tr('assistant replies found on the page', 'balasan AI ketemu di halaman')}`,
        ];
  deps.openModal(tr('Plugin check', 'Cek plugin'), `<p><b>${esc(e.manifest.name)}</b> · ${esc(tab.title ?? tab.url ?? '')}</p>${list(lines)}`, () => {});
}

export function initPlugins(dependencies: PluginsDeps): void {
  deps = dependencies;
  const body = document.getElementById('pluginsBody');
  body?.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest('[data-pl-act]') as HTMLElement | null;
    if (!el) return;
    const act = el.dataset.plAct;
    if (act === 'import-folder') { void importFrom('folder'); return; }
    if (act === 'import-zip' || act === 'update') { void importFrom('zip'); return; }
    const e = entryOf(el);
    if (!e) return;
    if (act === 'toggle') { void toggle(e, (el as HTMLInputElement).checked, el as HTMLInputElement); return; }
    if (act === 'export') { void exportPlugin(e); return; }
    if (act === 'remove') { void remove(e); return; }
    if (act === 'health') { void health(e); return; }
    if (act === 'reload') { void tabsOf(e).then((tabs) => { tabs.forEach((t) => t.id !== undefined && chrome.tabs.reload(t.id)); deps.toast(tr(`${tabs.length} tab(s) reloaded.`, `${tabs.length} tab dimuat ulang.`)); }); return; }
    if (act === 'grant') { void chrome.permissions.request({ origins: e.manifest.matches }).then(() => renderPlugins()); return; }
  });
  void refreshProviders().then(() => renderPlugins());
}

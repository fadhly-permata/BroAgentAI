import { bridge, BridgeErrorCode } from './bridge-client.js';
import { renderExplorer, ExplorerOptions } from './explorer.js';
import { initScm, refreshScm } from './git-panel.js';
import { initTerminal, showTerminal } from './terminal-panel.js';
import { initMcp, refreshMcp } from './mcp-panel.js';
import { initAgent, showAgent } from './agent-panel.js';
import { applyTheme, translatePage, t, Lang, Theme } from './i18n.js';
import { hydrateIcons, icon, fileIcon } from './icons.js';

hydrateIcons();

type FileNode={name:string;path:string;kind:'dir'|'file';git?:string;children?:FileNode[];content?:string};
const $=(id:string)=>document.getElementById(id) as HTMLElement;
const on=(id:string,ev:string,fn:(e:any)=>void)=>{const el=document.getElementById(id); if(!el){console.warn('Missing element #'+id+' for event '+ev); return;} el.addEventListener(ev,fn)};
let workspaces: any[] = [];
let activeWs: any = null;

async function loadWorkspaces() {
  try {
    const res = await bridge.call('workspace.list');
    workspaces = (res.workspaces || []).map((w: any) => ({ ...w, last: 'baru saja' }));
    activeWs = workspaces.find((w: any) => w.id === res.activeWorkspaceId) || workspaces[0] || null;
    renderWs();
    await renderTree();
    refreshScm();
  } catch (e) {
    console.error('Failed to load workspaces', e);
  }
}
let currentFile:FileNode|null=null; let currentMtime:number|null=null; let dirty=false;
let toastTimer:any=null;
function toast(m:string){const t=$('toast');t.textContent=m;t.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.add('hidden'),4000)}
function renderWs(){
  const head=$('headerWs');
  head.textContent=activeWs?activeWs.name:t('noWorkspace');
  head.title=activeWs?activeWs.path:'';
  $('wsList').innerHTML=workspaces.map((w,i)=>'<button data-ws="'+i+'" role="menuitem"><span class="ws-check">'+(w===activeWs?icon('check'):'')+'</span><span class="ws-text"><b>'+escapeHtml(w.name)+'</b><small>'+escapeHtml(w.path)+'</small></span></button>').join('');
  $('manageList').innerHTML=workspaces.map((w,i)=>'<div class="card'+(w===activeWs?' active-ws':'')+'"><div class="ws-item-main"><b>'+escapeHtml(w.name)+'</b><small title="'+escapeHtml(w.path)+'">'+escapeHtml(w.path)+' - '+escapeHtml(w.last)+'</small></div><div class="ws-item-actions"><button class="mini" data-open="'+i+'">Open</button><button class="mini" data-rename="'+i+'">Rename</button><button class="mini danger" data-remove="'+i+'">Remove</button></div></div>').join('')||'<p class="muted">Belum ada workspace.</p>';
  setCheck('ckWs', !!activeWs);
}
/** First-run checklist mark: text stays x/o for scripts, the class draws it. */
function setCheck(id:string, done:boolean){ const el=$(id); el.textContent=done?'x':'o'; el.classList.toggle('done',done); }

function updateHostStatus(status: 'offline' | 'ready' | 'error') {
  const pill = $('hostPill');
  const tKey = status === 'offline' ? 'hostOffline' : status === 'ready' ? 'hostOnline' : 'hostError';
  // Keep a data-i18n span so a language switch retranslates the pill too.
  pill.innerHTML = '<span class="dot"></span><span data-i18n="' + tKey + '"></span>';
  (pill.lastElementChild as HTMLElement).textContent = t(tKey);
  pill.className = 'pill ' + (status === 'offline' ? 'pill-warn' : status === 'ready' ? 'pill-ok' : 'pill-error');
  setCheck('ckHost', status === 'ready');
  if (status === 'offline' || status === 'error') {
    $('banner').classList.remove('hidden');
  } else {
    $('banner').classList.add('hidden');
  }
}
/** Status letter per changed file, for explorer badges. Empty when the workspace is not a repo. */
async function loadGitBadges(): Promise<Map<string,string>> {
  const badges = new Map<string,string>();
  try {
    const status: any = await bridge.call('git.status');
    if (!status?.isRepo) return badges;
    for (const f of status.files) badges.set(f.path, f.conflicted ? '!' : f.untracked ? 'U' : f.unstaged ? f.worktree : f.index);
  } catch { /* host offline or git missing: no badges */ }
  return badges;
}
async function renderTree(){
  if (!activeWs) {
    const msg = ((v=>v==='selectWorkspaceForFiles'?'Pilih workspace untuk melihat file.':v)(t('selectWorkspaceForFiles')));
    $('tree').innerHTML = '<p class="muted">' + msg + '</p>';
    return;
  }
  const showIgnored = ($('showIgnored') as HTMLInputElement).checked;
  const options: ExplorerOptions = {
    onFileClick: (path) => openFile(path),
    onContextClick: (e, path) => showContextMenu(e, path),
    showIgnored,
    gitStatus: await loadGitBadges(),
  };
  await renderExplorer($('tree'), activeWs.path, options);
}

function showContextMenu(e: MouseEvent, path: string) {
  e.preventDefault();
  const existing = document.getElementById('ctxMenu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'ctxMenu';
  menu.className = 'menu';
  menu.style.position = 'fixed';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.style.zIndex = '9999';
  const items = [
    { label: 'Rename...', act: () => renamePath(path) },
    { label: 'Delete...', act: () => deletePath(path) },
    { label: 'Copy Relative Path', act: () => { navigator.clipboard.writeText(path); toast('Path disalin: ' + path); } },
  ];
  menu.innerHTML = items.map((it, i) => `<button class="ctx-item" data-i="${i}">${it.label}</button>`).join('');
  document.body.appendChild(menu);
  menu.querySelectorAll('.ctx-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number((btn as HTMLElement).dataset.i);
      menu.remove();
      items[i].act();
    });
  });
  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

async function renamePath(path: string) {
  const newName = prompt('Rename to (relative path):', path);
  if (!newName || newName === path) return;
  try {
    await bridge.call('fs.rename', { from: path, to: newName.trim() });
    toast('Renamed: ' + path + ' -> ' + newName.trim());
    await renderTree();
    refreshScm();
  } catch (err: any) {
    toast('Gagal rename: ' + (err?.message || err));
  }
}

async function deletePath(path: string) {
  if (!confirm('Delete ' + path + '? (directory must be empty)')) return;
  try {
    await bridge.call('fs.delete', { path });
    toast('Deleted: ' + path);
    await renderTree();
    refreshScm();
  } catch (err: any) {
    toast('Gagal delete: ' + (err?.message || err));
  }
}

async function newFile() {
  const name = prompt('New file path (relative to workspace):');
  if (!name) return;
  try {
    await bridge.call('fs.createFile', { path: name.trim() });
    toast('File dibuat: ' + name.trim());
    await renderTree();
  } catch (err: any) {
    toast('Gagal membuat file: ' + (err?.message || err));
  }
}

async function newFolder() {
  const name = prompt('New folder path (relative to workspace):');
  if (!name) return;
  try {
    await bridge.call('fs.mkdir', { path: name.trim() });
    toast('Folder dibuat: ' + name.trim());
    await renderTree();
  } catch (err: any) {
    toast('Gagal membuat folder: ' + (err?.message || err));
  }
}

async function applyIgnore() {
  const raw = ($('ignoreInput') as HTMLInputElement).value;
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const res = await bridge.call('workspace.setIgnore', { patterns });
    toast('Ignore patterns updated: ' + (res?.ignore?.length || 0) + ' rules');
    await renderTree();
  } catch (err: any) {
    toast('Gagal set ignore: ' + (err?.message || err));
  }
}
async function openFile(path:string){
  if (!activeWs) return;
  
  try {
    const res: any = await bridge.call('fs.readFileLines', { path });
    const content: string = typeof res?.content === 'string' ? res.content : '';
    currentFile = { name: path.split('/').pop() || path, path, kind: 'file', content };
    currentMtime = typeof res?.mtime === 'number' ? res.mtime : null;
    dirty = false;
    $('editorPreview').classList.remove('hidden');
    $('edName').textContent = path;
    $('edIcon').innerHTML = fileIcon(currentFile.name);
    ($('edArea') as HTMLTextAreaElement).value = content;
    $('edDirty').textContent = '';
    $('edMeta').textContent = 'File dari workspace - ' + content.length + ' karakter';
    switchTab('explorer');
  } catch (err: any) {
    toast('Gagal membuka file: ' + (err.message || err));
  }
}
async function saveCurrentFile(){
  if(!currentFile) return;
  const content=($('edArea') as HTMLTextAreaElement).value;
  const params:any={ path: currentFile.path, content };
  if(currentMtime!==null) params.expectedMtime=currentMtime;
  try{
    const res:any=await bridge.call('fs.writeFile', params);
    currentMtime=typeof res?.mtime==='number'?res.mtime:null;
    currentFile.content=content; dirty=false; $('edDirty').textContent='';
    $('edMeta').textContent='File dari workspace - '+content.length+' karakter';
    toast('File tersimpan: '+currentFile.path); refreshScm();
  }catch(err:any){
    if(err?.code===BridgeErrorCode.MTIME_CONFLICT) toast('Konflik: file berubah di disk sejak dibuka. Tutup lalu buka ulang file sebelum menyimpan.');
    else toast('Gagal menyimpan: '+(err?.message||err));
  }
}
function closeEditorPreview(){ $('editorPreview').classList.add('hidden'); currentFile=null; currentMtime=null; dirty=false; }
async function setActiveWorkspace(ws:any){
  try{
    await bridge.call('workspace.setActive', { id: ws.id });
    activeWs=ws; closeEditorPreview(); renderWs(); await renderTree(); refreshScm();
    $('searchResults').innerHTML=''; $('searchInfo').textContent='';
    toast('Workspace aktif: '+ws.name);
  }catch(err:any){ toast('Gagal set aktif: '+(err?.message||err)); }
}
async function addWorkspace(path:string){
  const addRes:any=await bridge.call('workspace.add', { path });
  await loadWorkspaces();
  toast('Workspace ditambahkan: '+(addRes.workspace?.name||path));
}
// Open folder: the path box is always shown first, so the user is never stuck
// waiting on an OS dialog. "Browse..." asks the bridge for the native picker and
// only fills the box; nothing is added until OK.
function openFolder(){
  openModal('Open folder','<label>Absolute path<br><input id="wsPath" class="input" placeholder="D:/Projects/my-repo"></label><p><button id="wsBrowse" class="mini" type="button">Browse...</button> <span id="wsBrowseHint" class="muted"></span></p><p class="muted">Host validasi: exists, directory, realpath.</p>',async()=>{
    const v=(document.getElementById('wsPath') as HTMLInputElement)?.value.trim();
    if(!v) return toast('Path kosong');
    try{ await addWorkspace(v); }catch(e:any){ toast('Gagal menambahkan workspace: '+(e?.message||e)); }
  });
  const input=document.getElementById('wsPath') as HTMLInputElement;
  const browse=document.getElementById('wsBrowse') as HTMLButtonElement;
  const hint=document.getElementById('wsBrowseHint') as HTMLElement;
  input.focus();
  browse.addEventListener('click',async()=>{
    browse.disabled=true;
    hint.textContent='Dialog folder terbuka. Kalau tidak terlihat, cek taskbar atau Alt+Tab.';
    try{
      // The user may take a while to pick, so the timeout is long.
      const picked:any=await bridge.call('workspace.openFolderDialog', {}, 5*60*1000);
      if(picked?.path && document.body.contains(input)) input.value=picked.path;
      hint.textContent='';
    }catch(e:any){
      hint.textContent=e?.code===BridgeErrorCode.OPERATION_CANCELLED?'':'Dialog folder tidak tersedia di host ini. Ketik path secara manual.';
    }finally{ browse.disabled=false; }
  });
}
async function connectBridge(){
  try{
    await bridge.connect();
    updateHostStatus('ready');
    await loadWorkspaces();
  }catch(err){
    console.warn('Bridge connection failed:', err);
    updateHostStatus('offline');
  }
}
function switchTab(t:string){ 
  document.querySelectorAll('.rail-btn').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.tab===t)); 
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+t)); 
  if(t==='settings') refreshMcp(); 
  if(t==='agent') showAgent(); 
  if(t==='scm') refreshScm(); 
  if(t==='terminal') showTerminal(); 
}
let modalCb:(()=>void)|null=null;
function openModal(title:string,body:string,cb:()=>void){ $('modalTitle').textContent=title; $('modalBody').innerHTML=body; modalCb=cb; $('modalBackdrop').classList.remove('hidden') }
function closeModal(){ $('modalBackdrop').classList.add('hidden'); modalCb=null }
async function doSearch(){
  const query = ($('searchInput') as HTMLInputElement).value.trim();
  if (!query) {
    const msg = ((v=>v==='enterQuery'?'Masukkan query pencarian.':v)(t('enterQuery')));
    $('searchResults').innerHTML = '<p class="muted">' + msg + '</p>';
    $('searchErr').classList.add('hidden');
    return;
  }
  
  if (!activeWs) {
    const msg = ((v=>v==='selectWorkspaceFirst'?'Pilih workspace terlebih dahulu.':v)(t('selectWorkspaceFirst')));
    $('searchResults').innerHTML = '<p class="muted">' + msg + '</p>';
    return;
  }
  
  const caseSensitive = ($('caseChk') as HTMLInputElement).checked;
  const useRegex = ($('regexChk') as HTMLInputElement).checked;
  
  const msg = ((v=>v==='searching'?'Mencari...':v)(t('searching')));
  $('searchResults').innerHTML = '<p class="muted">' + msg + '</p>';
  $('searchErr').classList.add('hidden');
  
  try {
    const res: any = await bridge.call('fs.searchFiles', { path: '.', query, caseSensitive, regex: useRegex });
    const results: any[] = Array.isArray(res) ? res : (res?.results || []);

    if (results.length === 0) {
      const msg = ((v=>v==='noMatches'?'Tidak ada hasil':v)(t('noMatches')));
      $('searchResults').innerHTML = '<p class="muted">' + msg + '</p>';
      $('searchInfo').textContent = msg;
      return;
    }
    
    const grouped: { [file: string]: { line: number; text: string }[] } = {};
    results.forEach((r: any) => {
      if (!grouped[r.file]) grouped[r.file] = [];
      grouped[r.file].push({ line: r.line, text: r.text });
    });
    
    const hit = matcher(query, caseSensitive, useRegex);
    let html = '';
    Object.entries(grouped).forEach(([file, matches]) => {
      const cut = file.lastIndexOf('/');
      const base = cut < 0 ? file : file.slice(cut + 1);
      const dir = cut < 0 ? '' : file.slice(0, cut);
      html += `<div class="search-group">`;
      html += `<div class="search-file" role="button" aria-expanded="true" title="${escapeHtml(file)}"><span class="twist">${icon('chevron-right')}</span><span class="ba-tree-icon">${fileIcon(base)}</span><span class="sf-name">${escapeHtml(base)}</span><span class="sf-dir">${escapeHtml(dir)}</span><span class="count-badge">${matches.length}</span></div>`;
      html += `<div class="search-matches">`;
      matches.forEach((m: any) => {
        const text = String(m.text ?? '').replace(/^\s+/, '');
        html += `<div class="search-match" data-file="${escapeHtml(file)}" data-line="${m.line}" title="L${m.line}: ${escapeHtml(text.slice(0, 300))}">`;
        html += `<span class="line-num">${m.line}</span>`;
        html += `<span class="match-text">${highlight(text, hit)}</span>`;
        html += `</div>`;
      });
      html += `</div></div>`;
    });
    
    $('searchResults').innerHTML = html;
    const matchMsg = (((v=>v==='matchesFound'?'Ditemukan {count} match di {files} file':v)(t('matchesFound'))))
      .replace('{count}', String(results.length))
      .replace('{files}', String(Object.keys(grouped).length));
    $('searchInfo').textContent = matchMsg;
    
    document.querySelectorAll('#searchResults .search-file').forEach(el => {
      el.addEventListener('click', () => {
        const group = el.parentElement!;
        el.setAttribute('aria-expanded', String(!group.classList.toggle('collapsed')));
      });
    });
    document.querySelectorAll('.search-match').forEach(el => {
      el.addEventListener('click', () => {
        const file = (el as HTMLElement).dataset.file!;
        const line = Number((el as HTMLElement).dataset.line);
        openFileAtLine(file, line);
      });
    });
    
  } catch (e: any) {
    $('searchErr').textContent = `Error: ${e.message}`;
    $('searchErr').classList.remove('hidden');
    $('searchResults').innerHTML = ''; $('searchInfo').textContent = '';
  }
}

/** A global regex for the query with the same flags the search used, or null when it does not compile. */
function matcher(query: string, caseSensitive: boolean, regex: boolean): RegExp | null {
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch { return null; }
}

/** Escape a result line and wrap each match in <mark>. */
function highlight(text: string, re: RegExp | null): string {
  if (!re) return escapeHtml(text);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += escapeHtml(text.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function openFileAtLine(path: string, line: number) {
  const editorUrl = chrome.runtime.getURL(`src/editor.html?path=${encodeURIComponent(path)}&line=${line}`);
  chrome.tabs.create({ url: editorUrl });
}

async function runDiagnostics() {
  const diagEl = $('diagOut') as HTMLElement;
  diagEl.classList.remove('hidden');
  diagEl.textContent = 'Running diagnostics...';
  try {
    const info = await bridge.call('system.info');
    const config = await bridge.call('config.get');
    diagEl.textContent = `Host Info:\n${JSON.stringify(info, null, 2)}\n\nConfig:\n${JSON.stringify(config, null, 2)}`;
  } catch (err: any) {
    diagEl.textContent = `Diagnostics failed: ${err.message}`;
  }
}

async function restartHost() {
  toast('Restarting companion...');
  await connectBridge();
  toast($('banner').classList.contains('hidden') ? 'Host terhubung' : 'Host masih offline');
}

async function createProjectConfig() {
  if (!activeWs) return toast('Pilih workspace terlebih dahulu');
  try {
    // fs.createFile refuses to overwrite; the starter content is written only into the new file.
    await bridge.call('fs.createFile', { path: 'broagentai.jsonc' });
    await bridge.call('fs.writeFile', { path: 'broagentai.jsonc', content: '{\n  "version": 1,\n  // MCP servers defined here need "Review & trust" in Settings > MCP before they can start.\n  "mcp": {}\n}\n' });
    await renderTree(); refreshScm();
    toast('broagentai.jsonc dibuat di root workspace');
  } catch (err: any) {
    toast('Gagal membuat config: ' + (err?.message || err));
  }
}

let searchTimer:any=null;
document.querySelectorAll('.rail-btn').forEach(b=>b.addEventListener('click',()=>switchTab((b as HTMLElement).dataset.tab!)));
document.querySelectorAll('.set-tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.set-tab').forEach(x=>x.classList.toggle('active',x===b)); document.querySelectorAll('.set-panel').forEach(p=>p.classList.toggle('active',p.id==='set-'+(b as HTMLElement).dataset.set))}));
on('wsBtn','click',()=>{$('wsMenu').classList.toggle('hidden'); $('overflowMenu').classList.add('hidden')});
on('overflowBtn','click',()=>{$('overflowMenu').classList.toggle('hidden'); $('wsMenu').classList.add('hidden')});
document.querySelectorAll('#overflowMenu [data-act]').forEach(b=>b.addEventListener('click',()=>{const a=(b as HTMLElement).dataset.act; $('overflowMenu').classList.add('hidden'); if(a==='settings')switchTab('settings'); if(a==='diagnostics')runDiagnostics(); if(a==='restart')restartHost(); if(a==='reload')location.reload()}));
document.querySelectorAll('#wsMenu [data-act]').forEach(b=>b.addEventListener('click',()=>{const a=(b as HTMLElement).dataset.act; $('wsMenu').classList.add('hidden'); if(a==='open-folder')openFolder(); if(a==='manage'){switchTab('settings'); (document.querySelector('.set-tab[data-set="workspaces"]') as HTMLElement)?.click()}}));
on('wsList','click',(e:any)=>{const t=e.target.closest('[data-ws]'); if(!t)return; $('wsMenu').classList.add('hidden'); setActiveWorkspace(workspaces[Number(t.dataset.ws)])});
on('manageList','click',async(e:any)=>{const o=e.target.closest('[data-open]'); const r=e.target.closest('[data-remove]'); const rn=e.target.closest('[data-rename]'); if(o){await setActiveWorkspace(workspaces[Number(o.dataset.open)])} if(r){const idx=Number(r.dataset.remove); const ws=workspaces[idx]; try{ await bridge.call('workspace.remove', { id: ws.id }); await loadWorkspaces(); toast('Workspace dihapus dari list'); }catch(err){ toast('Gagal hapus: ' + err); }} if(rn){const idx=Number(rn.dataset.rename); const ws=workspaces[idx]; openModal('Rename workspace','<input id="wsName" class="input" value="'+ws.name+'">',async()=>{const newName=(document.getElementById('wsName') as HTMLInputElement).value; try{ await bridge.call('workspace.rename', { id: ws.id, name: newName }); await loadWorkspaces(); toast('Workspace direname'); }catch(err){ toast('Gagal rename: ' + err); }})}});
on('restartBtn','click',async()=>{await connectBridge(); toast($('banner').classList.contains('hidden')?'Host terhubung':'Host masih offline')}); on('restart2Btn','click',async()=>{await connectBridge(); toast($('banner').classList.contains('hidden')?'Host terhubung':'Host masih offline')}); on('setupBtn','click',()=>openModal('Setup help','<p>Host: <code>com.broagentai.host</code></p><p>Dev: build host + register sekali, lalu reload extension.</p><p>Config: <code>~/.broagentai/config.jsonc</code> - Log: <code>~/.broagentai/host.log</code></p>',()=>{}));
on('diagBtn','click',runDiagnostics); on('reloadConfigBtn','click',async()=>{try{await bridge.call('config.get'); toast('Config reloaded')}catch(err:any){toast('Gagal reload config: '+(err?.message||err))}}); on('createConfigBtn','click',createProjectConfig);
on('dismissCk','click',()=>$('checklist').classList.add('hidden'));
document.querySelectorAll('[data-ck]').forEach(b=>b.addEventListener('click',()=>{const k=(b as HTMLElement).dataset.ck; if(k==='host')(async()=>{await connectBridge(); toast($('banner').classList.contains('hidden')?'Host terhubung':'Host masih offline')})(); if(k==='ws')($('wsBtn') as HTMLElement).click(); if(k==='ai')switchTab('agent')}));

// UI settings persistence (localStorage)
const UI_SETTINGS_KEY = 'broagentai.ui';
function loadUISettings() {
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { lang: 'id', theme: 'system', fontSize: 13, tabSize: 2, wrap: false };
  } catch { return { lang: 'id', theme: 'system', fontSize: 13, tabSize: 2, wrap: false }; }
}
function saveUISettings(settings: any) {
  try {
    const current = loadUISettings();
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ ...current, ...settings }));
  } catch {}
}
function applyUISettings() {
  const s = loadUISettings();
  
  // Apply Language
  const lang = (s.lang || 'id') as Lang;
  if (($('langSel') as HTMLSelectElement)) ($('langSel') as HTMLSelectElement).value = lang;
  document.documentElement.lang = lang;
  translatePage(lang);
  
  // Apply Theme
  const theme = (s.theme || 'system') as Theme;
  if (($('themeSel') as HTMLSelectElement)) ($('themeSel') as HTMLSelectElement).value = theme;
  applyTheme(theme);
  
  // Apply Font & Editor settings
  if (s.fontSize) {
    ($('fontSize') as HTMLInputElement).value = String(s.fontSize);
    document.documentElement.style.setProperty('--font-size', s.fontSize + 'px');
  }
  if (s.tabSize) {
    ($('tabSize') as HTMLInputElement).value = String(s.tabSize);
    document.documentElement.style.setProperty('--tab-size', String(s.tabSize));
  }
  if (s.wrap !== undefined) {
    ($('wrapChk') as HTMLInputElement).checked = s.wrap;
    document.documentElement.style.setProperty('--editor-wrap', s.wrap ? 'pre-wrap' : 'pre');
  }
}

on('langSel','change',(e)=>{
  const v = (e.target as HTMLSelectElement).value as Lang; 
  saveUISettings({lang: v}); 
  document.documentElement.lang = v;
  translatePage(v);
  renderWs(); // dynamic text is not covered by data-i18n
});
on('themeSel','change',(e)=>{
  const v = (e.target as HTMLSelectElement).value as Theme; 
  saveUISettings({theme: v}); 
  applyTheme(v);
});
on('fontSize','change',(e)=>{const v=Number((e.target as HTMLInputElement).value); if(v>0){saveUISettings({fontSize:v}); document.documentElement.style.setProperty('--font-size',v+'px');}});
on('tabSize','change',(e)=>{const v=Number((e.target as HTMLInputElement).value); if(v>0){saveUISettings({tabSize:v}); document.documentElement.style.setProperty('--tab-size',String(v));}});
on('wrapChk','change',(e)=>{const v=(e.target as HTMLInputElement).checked; saveUISettings({wrap:v}); document.documentElement.style.setProperty('--editor-wrap',v?'pre-wrap':'pre');});

applyUISettings();

on('refreshTree','click',async()=>{await renderTree(); toast('Tree direfresh')});
on('newFileBtn','click',()=>newFile());
on('collapseTree','click',()=>{renderTree()});
on('searchCollapse','click',()=>{const groups=document.querySelectorAll('#searchResults .search-group'); const fold=[...groups].some(g=>!g.classList.contains('collapsed')); groups.forEach(g=>{g.classList.toggle('collapsed',fold); g.querySelector('.search-file')?.setAttribute('aria-expanded',String(!fold));})});
on('searchClear','click',()=>{($('searchInput') as HTMLInputElement).value=''; $('searchResults').innerHTML=''; $('searchInfo').textContent=''; $('searchErr').classList.add('hidden'); ($('searchInput') as HTMLInputElement).focus()});
on('newFolderBtn','click',()=>newFolder());
on('showIgnored','change',async()=>{await renderTree()});
on('ignoreInput','change',()=>applyIgnore());
on('ignoreInput','blur',()=>applyIgnore());
on('edSave','click',saveCurrentFile); on('edClose','click',()=>{if(dirty && !confirm('Ada perubahan belum disimpan. Tutup?'))return; closeEditorPreview()}); on('edArea','input',()=>{dirty=true; $('edDirty').innerHTML='●<span class="sr-only"> dirty</span>'; $('edDirty').title='Unsaved changes'}); document.addEventListener('keydown',(e)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&currentFile){e.preventDefault(); ($('edSave') as HTMLElement).click()}});
on('searchInput','input',()=>{clearTimeout(searchTimer); searchTimer=setTimeout(doSearch,250)}); on('caseChk','change',doSearch); on('regexChk','change',doSearch);
on('modalOk','click',()=>{modalCb&&modalCb(); closeModal()}); on('modalCancel','click',closeModal); on('modalClose','click',closeModal); on('modalBackdrop','click',(e:any)=>{if(e.target.id==='modalBackdrop')closeModal()}); document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeModal()});
try{ ($('extId') as HTMLElement).textContent=chrome.runtime.id }catch{ ($('extId') as HTMLElement).textContent='(dev)' }

initAgent({ toast, hasWorkspace: ()=>!!activeWs, onFilesChanged: ()=>{ renderTree(); refreshScm(); } });
initMcp({ toast, openModal, hasWorkspace: ()=>!!activeWs });
initTerminal({ toast, hasWorkspace: ()=>!!activeWs });
initScm({ toast, openModal, hasWorkspace: ()=>!!activeWs, onFilesChanged: ()=>{ closeEditorPreview(); renderTree(); } });

connectBridge();

bridge.onEvent((ev) => {
  console.log('Event from bridge:', ev);
});

renderWs();
renderTree();

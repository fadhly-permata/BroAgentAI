import { bridge, BridgeErrorCode } from './bridge-client.js';
import { renderExplorer, ExplorerOptions } from './explorer.js';
import { initScm, refreshScm } from './git-panel.js';
import { initTerminal, showTerminal } from './terminal-panel.js';
import { initMcp, refreshMcp } from './mcp-panel.js';

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
let logs:{tool:string;risk:string;decision:string;status:string;dur:number}[]=[{tool:'fs.readFile src/sidepanel.ts',risk:'Read',decision:'auto',status:'ok',dur:42}];
let currentFile:FileNode|null=null; let currentMtime:number|null=null; let dirty=false;
let detectedChat={name:'DeepSeek',url:'chat.deepseek.com',tab:'Tab aktif'};
let toastTimer:any=null;
function toast(m:string){const t=$('toast');t.textContent=m;t.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.add('hidden'),4000)}
function renderWs(){ $('headerWs').textContent=activeWs?activeWs.name+' - '+activeWs.path:'Belum ada workspace'; $('wsList').innerHTML=workspaces.map((w,i)=>'<button data-ws="'+i+'">'+(w===activeWs?'&#10003; ':'')+'<b>'+w.name+'</b><small>'+w.path+'</small></button>').join(''); $('manageList').innerHTML=workspaces.map((w,i)=>'<div class="card"><b>'+w.name+'</b><br><small>'+w.path+' - '+w.last+'</small><br><br><button class="mini" data-open="'+i+'">Open</button> <button class="mini" data-rename="'+i+'">Rename</button> <button class="mini danger" data-remove="'+i+'">Remove</button></div>').join('')||'<p class="muted">Belum ada workspace.</p>'; ($('chatWs') as HTMLElement).textContent=activeWs?.name||'-'; $('ckWs').textContent=activeWs?'x':'o'; }

function updateHostStatus(status: 'offline' | 'ready' | 'error') {
  const pill = $('hostPill');
  const text = status === 'offline' ? 'Host offline' : status === 'ready' ? 'Host ready' : 'Host error';
  pill.innerHTML = '<span class="dot"></span>';
  pill.appendChild(document.createTextNode(text));
  pill.className = 'pill ' + (status === 'offline' ? 'pill-warn' : status === 'ready' ? 'pill-ok' : 'pill-error');
  $('ckHost').textContent = status === 'ready' ? 'x' : 'o';
  if (status === 'offline' || status === 'error') {
    $('banner').classList.remove('hidden');
  } else {
    $('banner').classList.add('hidden');
  }
}
async function renderTree(){
  if (!activeWs) {
    $('tree').innerHTML = '<p class="muted">Pilih workspace untuk melihat file.</p>';
    return;
  }
  
  const options: ExplorerOptions = {
    onFileClick: (path) => openFile(path),
    onContextClick: (e, path) => {
      openModal('File: ' + path, '<p>New File, Rename, Duplicate, Copy Path, Copy Relative Path, Delete.</p><p><button class="mini" onclick="navigator.clipboard.writeText(\'' + path + '\')">Copy Relative Path</button></p>', () => toast('Context action (demo)'));
    }
  };
  
  await renderExplorer($('tree'), activeWs.path, options);
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
function askWorkspacePath(){
  openModal('Open folder','<label>Absolute path<br><input id="wsPath" class="input" placeholder="D:/Projects/my-repo"></label><p class="muted">Host validasi: exists, directory, realpath.</p>',async()=>{
    const v=(document.getElementById('wsPath') as HTMLInputElement)?.value.trim();
    if(!v) return toast('Path kosong');
    try{ await addWorkspace(v); }catch(e:any){ toast('Gagal menambahkan workspace: '+(e?.message||e)); }
  });
}
async function openFolder(){
  let picked:any=null;
  try{
    // Dialog native bisa lama (user memilih folder), jadi timeout dilonggarkan.
    picked=await bridge.call('workspace.openFolderDialog', {}, 5*60*1000);
  }catch(e:any){
    if(e?.code===BridgeErrorCode.OPERATION_CANCELLED) return;
    // Dialog native tidak tersedia (platform lain / host lama): input path manual.
    return askWorkspacePath();
  }
  if(!picked?.path) return;
  try{ await addWorkspace(picked.path); }catch(e:any){ toast('Gagal menambahkan workspace: '+(e?.message||e)); }
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
function renderLog(){const f=($('logFilter') as HTMLSelectElement).value; $('cmdLog').innerHTML=logs.filter(l=>f==='all'||l.status===f).map(l=>'<div class="log-row">'+l.tool+' - '+l.risk+' - '+l.decision+' - '+l.status+' - '+l.dur+'ms</div>').join('')||'<p class="muted">Belum ada tool call.</p>'}
function renderProviders(){ $('providerList').innerHTML=[['DeepSeek','chat.deepseek.com'],['Qwen','chat.qwen.ai'],['Gemini','gemini.google.com'],['ChatGPT','chatgpt.com'],['Claude','claude.ai']].map(p=>'<div class="card"><strong>'+p[0]+'</strong> - <code>'+p[1]+'</code> - plugin aktif <label><input type="checkbox" checked> Enabled</label> <button class="mini" data-health="'+p[0]+'">Health check</button></div>').join(''); document.querySelectorAll('[data-health]').forEach(el=>el.addEventListener('click',()=>toast('Health check '+(el as HTMLElement).dataset.health+': OK (demo)'))) }
function renderResources(){ $('resourcesList').innerHTML='<h4>Instructions</h4><div class="log-row">AGENTS.md - 0.4 KB</div><div class="log-row">.broagentai/rules/*.md - 3 files</div><h4>Skills (6, metadata saja)</h4><div class="log-row">review-code - Review patch <button class="mini" data-skill="review-code">Preview body</button></div><div class="log-row">write-tests - Buat test</div><h4>Agents</h4><div class="log-row">default / reviewer / planner</div><h4>Commands</h4><div class="log-row">/review - template prompt <button class="mini" data-cmd="/review">Salin template</button></div>'; document.querySelectorAll('[data-skill]').forEach(el=>el.addEventListener('click',()=>openModal('Skill: review-code','<p>Body dibaca on-demand via skills.read. Isi: cek diff, cari bug, sarankan test.</p>',()=>{}))); document.querySelectorAll('[data-cmd]').forEach(el=>el.addEventListener('click',()=>{navigator.clipboard.writeText('/review ').then(()=>toast('Template /review disalin - paste di halaman chat')) })); }
function renderChatSite(){ ($('chatSiteName') as HTMLElement).textContent=detectedChat.name; ($('chatSiteUrl') as HTMLElement).textContent=detectedChat.url; ($('chatSiteTab') as HTMLElement).textContent=detectedChat.tab; ($('chatSiteName2') as HTMLElement).textContent=detectedChat.name; }
function switchTab(t:string){ document.querySelectorAll('.rail-btn').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.tab===t)); document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+t)); if(t==='settings'){ renderProviders(); refreshMcp(); } if(t==='scm') refreshScm(); if(t==='terminal') showTerminal(); }
let modalCb:(()=>void)|null=null;
function openModal(title:string,body:string,cb:()=>void){ $('modalTitle').textContent=title; $('modalBody').innerHTML=body; modalCb=cb; $('modalBackdrop').classList.remove('hidden') }
function closeModal(){ $('modalBackdrop').classList.add('hidden'); modalCb=null }
async function doSearch(){
  const query = ($('searchInput') as HTMLInputElement).value.trim();
  if (!query) {
    $('searchResults').innerHTML = '<p class="muted">Masukkan query pencarian.</p>';
    $('searchErr').classList.add('hidden');
    return;
  }
  
  if (!activeWs) {
    $('searchResults').innerHTML = '<p class="muted">Pilih workspace terlebih dahulu.</p>';
    return;
  }
  
  const caseSensitive = ($('caseChk') as HTMLInputElement).checked;
  const useRegex = ($('regexChk') as HTMLInputElement).checked;
  
  $('searchResults').innerHTML = '<p class="muted">Mencari...</p>';
  $('searchErr').classList.add('hidden');
  
  try {
    const res: any = await bridge.call('fs.searchFiles', { path: '.', query, caseSensitive, regex: useRegex });
    const results: any[] = Array.isArray(res) ? res : (res?.results || []);

    if (results.length === 0) {
      $('searchResults').innerHTML = '<p class="muted">Tidak ada hasil ditemukan.</p>';
      $('searchInfo').textContent = 'Tidak ada hasil';
      return;
    }
    
    // Group by file
    const grouped: { [file: string]: { line: number; text: string }[] } = {};
    results.forEach((r: any) => {
      if (!grouped[r.file]) grouped[r.file] = [];
      grouped[r.file].push({ line: r.line, text: r.text });
    });
    
    let html = '';
    
    Object.entries(grouped).forEach(([file, matches]) => {
      html += `<div class="card search-group">`;
      html += `<strong class="search-file">${escapeHtml(file)} <span class="muted">(${matches.length} match)</span></strong>`;
      html += `<div class="search-matches">`;
      matches.forEach((m: any) => {
        html += `<div class="search-match" data-file="${escapeHtml(file)}" data-line="${m.line}">`;
        html += `<span class="line-num">L${m.line}:</span> `;
        html += `<span class="match-text">${escapeHtml(m.text)}</span>`;
        html += `</div>`;
      });
      html += `</div></div>`;
    });
    
    $('searchResults').innerHTML = html;
    $('searchInfo').textContent = 'Ditemukan ' + results.length + ' match di ' + Object.keys(grouped).length + ' file';
    
    // Add click handlers to open file at line
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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function openFileAtLine(path: string, line: number) {
  // Buka file di editor tab dengan parameter line
  const editorUrl = chrome.runtime.getURL(`src/editor.html?path=${encodeURIComponent(path)}&line=${line}`);
  chrome.tabs.create({ url: editorUrl });
}
let searchTimer:any=null;
function addChat(who:string,text:string){const d=document.createElement('div'); d.className='msg '+(who==='user'?'user':'assistant'); d.innerHTML='<div class="avatar">'+(who==='user'?'Kamu':'BA')+'</div><div class="bubble"></div>'; (d.querySelector('.bubble') as HTMLElement).textContent=text; $('chat').appendChild(d); $('chat').scrollTop=$('chat').scrollHeight}
function showApproval(tool:string,summary:string,diff:string,params:string){ $('approvalCard').classList.remove('hidden'); $('apTool').textContent=tool; $('apSummary').textContent=summary; $('apDiff').textContent=diff; $('apParams').textContent=params; }
function finishApproval(decision:string){ const tool=$('apTool').textContent||''; logs.push({tool, risk:'Write', decision, status:decision==='deny'?'denied':'ok', dur:1200}); renderLog(); $('approvalCard').classList.add('hidden'); addChat('assistant', decision==='deny'?'Ditolak - error terstruktur dikirim balik ke halaman chat.':'Disetujui ('+decision+') - tool dijalankan, hasil dikirim balik ke halaman chat.'); if(decision!=='deny' && currentFile){currentFile.content='// hasil edit (demo, disetujui)\n'+currentFile.content; ($('edArea') as HTMLTextAreaElement).value=currentFile.content||''} }
function simulateToolFromChat(){ if(!activeWs)return toast('Pilih workspace dulu'); const mode=($('modeSel') as HTMLSelectElement).value; addChat('assistant','Perintah dari halaman chat '+detectedChat.name+' terdeteksi. Aku baca file-nya dulu...'); logs.push({tool:'fs.readFile '+(currentFile?.path||'src/sidepanel.ts'),risk:'Read',decision:'auto',status:'ok',dur:87}); renderLog(); if(mode==='Read-only'){addChat('assistant','Mode Read-only: write ditolak. Ubah ke Ask / Auto-edit untuk edit.'); logs.push({tool:'fs.writeFile',risk:'Write',decision:'deny (Read-only)',status:'denied',dur:0}); renderLog()} else if(mode==='Ask'){ showApproval('fs.writeFile','Perintah dari halaman chat '+detectedChat.name+': menulis perubahan.','- lama\n+ baru (diff preview, capped)','path: '+(currentFile?.path||'src/sidepanel.ts')) } else { logs.push({tool:'fs.writeFile',risk:'Write',decision:'auto ('+mode+')',status:'ok',dur:210}); renderLog(); addChat('assistant','Selesai (mode '+mode+'): perubahan diterapkan. Cek SCM.') } ($('sessionStatus') as HTMLElement).textContent='Session: ready'; }
document.querySelectorAll('.rail-btn').forEach(b=>b.addEventListener('click',()=>switchTab((b as HTMLElement).dataset.tab!)));
document.querySelectorAll('.set-tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.set-tab').forEach(x=>x.classList.toggle('active',x===b)); document.querySelectorAll('.set-panel').forEach(p=>p.classList.toggle('active',p.id==='set-'+(b as HTMLElement).dataset.set))}));
on('wsBtn','click',()=>{$('wsMenu').classList.toggle('hidden'); $('overflowMenu').classList.add('hidden')});
on('overflowBtn','click',()=>{$('overflowMenu').classList.toggle('hidden'); $('wsMenu').classList.add('hidden')});
document.querySelectorAll('#overflowMenu [data-act]').forEach(b=>b.addEventListener('click',()=>{const a=(b as HTMLElement).dataset.act; $('overflowMenu').classList.add('hidden'); if(a==='settings')switchTab('settings'); if(a==='diagnostics'){switchTab('settings'); ($('diagOut') as HTMLElement).classList.remove('hidden')} if(a==='restart')toast('Restart companion (demo - host offline)'); if(a==='reload')location.reload()}));
document.querySelectorAll('#wsMenu [data-act]').forEach(b=>b.addEventListener('click',()=>{const a=(b as HTMLElement).dataset.act; $('wsMenu').classList.add('hidden'); if(a==='open-folder')openFolder(); if(a==='manage'){switchTab('settings'); (document.querySelector('.set-tab[data-set="workspaces"]') as HTMLElement)?.click()}}));
on('wsList','click',(e:any)=>{const t=e.target.closest('[data-ws]'); if(!t)return; $('wsMenu').classList.add('hidden'); setActiveWorkspace(workspaces[Number(t.dataset.ws)])});
on('manageList','click',async(e:any)=>{const o=e.target.closest('[data-open]'); const r=e.target.closest('[data-remove]'); const rn=e.target.closest('[data-rename]'); if(o){await setActiveWorkspace(workspaces[Number(o.dataset.open)])} if(r){const idx=Number(r.dataset.remove); const ws=workspaces[idx]; try{ await bridge.call('workspace.remove', { id: ws.id }); await loadWorkspaces(); toast('Workspace dihapus dari list'); }catch(err){ toast('Gagal hapus: ' + err); }} if(rn){const idx=Number(rn.dataset.rename); const ws=workspaces[idx]; openModal('Rename workspace','<input id="wsName" class="input" value="'+ws.name+'">',async()=>{const newName=(document.getElementById('wsName') as HTMLInputElement).value; try{ await bridge.call('workspace.rename', { id: ws.id, name: newName }); await loadWorkspaces(); toast('Workspace direname'); }catch(err){ toast('Gagal rename: ' + err); }})}});
on('restartBtn','click',async()=>{await connectBridge(); toast($('banner').classList.contains('hidden')?'Host terhubung':'Host masih offline')}); on('restart2Btn','click',async()=>{await connectBridge(); toast($('banner').classList.contains('hidden')?'Host terhubung':'Host masih offline')}); on('setupBtn','click',()=>openModal('Setup help','<p>Host: <code>com.broagentai.host</code></p><p>Dev: build host + register sekali, lalu reload extension.</p><p>Config: <code>~/.broagentai/config.jsonc</code> - Log: <code>~/.broagentai/host.log</code></p>',()=>{}));
on('diagBtn','click',()=>{($('diagOut') as HTMLElement).classList.toggle('hidden')}); on('resetStateBtn','click',()=>{logs=[]; renderLog(); toast('State direset - file tidak dihapus')}); on('reloadConfigBtn','click',()=>toast('Config direload (demo)')); on('createConfigBtn','click',()=>openModal('Create project config','<p>Buat <code>broagentai.jsonc</code> di root workspace dengan default Ask + ff-only?</p>',()=>toast('broagentai.jsonc dibuat (demo)')));
on('dismissCk','click',()=>$('checklist').classList.add('hidden'));
document.querySelectorAll('[data-ck]').forEach(b=>b.addEventListener('click',()=>{const k=(b as HTMLElement).dataset.ck; if(k==='host')(async()=>{await connectBridge(); toast($('banner').classList.contains('hidden')?'Host terhubung':'Host masih offline')})(); if(k==='ws')($('wsBtn') as HTMLElement).click(); if(k==='ai')switchTab('agent')}));
on('refreshTree','click',async()=>{await renderTree(); toast('Tree direfresh')}); on('newFileBtn','click',()=>toast('Fitur New File akan diimplementasikan di Fase 2')); on('newFolderBtn','click',()=>toast('Fitur New Folder akan diimplementasikan di Fase 2'));
on('edSave','click',saveCurrentFile); on('edClose','click',()=>{if(dirty && !confirm('Ada perubahan belum disimpan. Tutup?'))return; closeEditorPreview()}); on('edArea','input',()=>{dirty=true; $('edDirty').textContent='- dirty'}); document.addEventListener('keydown',(e)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&currentFile){e.preventDefault(); ($('edSave') as HTMLElement).click()}});
on('searchInput','input',()=>{clearTimeout(searchTimer); searchTimer=setTimeout(doSearch,250)}); on('caseChk','change',doSearch); on('regexChk','change',doSearch);
on('modeSel','change',()=>{const v=($('modeSel') as HTMLSelectElement).value; toast('Approval mode: '+v)}); on('agentSel','change',()=>toast('Agent profile: '+($('agentSel') as HTMLSelectElement).value+' - berlaku turn berikutnya'));
on('simulateBtn','click',simulateToolFromChat);
on('apAllow','click',()=>finishApproval('allow once')); on('apSession','click',()=>finishApproval('allow for session')); on('apDeny','click',()=>finishApproval('deny'));
on('logFilter','change',renderLog); on('clearLog','click',()=>{logs=[]; renderLog()}); on('copyLog','click',()=>{navigator.clipboard.writeText(JSON.stringify(logs,null,2)).then(()=>toast('Command JSON disalin'))});
on('openChatBtn','click',()=>{toast('Buka tab '+detectedChat.name+' (demo - di host: chrome.tabs.create '+detectedChat.url+')'); ($('sessionStatus') as HTMLElement).textContent='Session: ready - tab chat dibuka'});
on('modalOk','click',()=>{modalCb&&modalCb(); closeModal()}); on('modalCancel','click',closeModal); on('modalClose','click',closeModal); on('modalBackdrop','click',(e:any)=>{if(e.target.id==='modalBackdrop')closeModal()}); document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeModal()});
try{ ($('extId') as HTMLElement).textContent=chrome.runtime.id }catch{ ($('extId') as HTMLElement).textContent='(dev)' }

initMcp({ toast, openModal, hasWorkspace: ()=>!!activeWs });
initTerminal({ toast, hasWorkspace: ()=>!!activeWs });
initScm({ toast, openModal, hasWorkspace: ()=>!!activeWs, onFilesChanged: ()=>{ closeEditorPreview(); renderTree(); } });

// 0.5: Koneksi ke bridge dan load workspaces
connectBridge();

bridge.onEvent((ev) => {
  console.log('Event from bridge:', ev);
});

renderWs(); renderLog(); renderResources(); renderChatSite();

// Render tree setelah workspace dimuat
renderTree();

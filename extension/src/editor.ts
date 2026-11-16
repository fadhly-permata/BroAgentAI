// Editor: CodeMirror 6 dengan dukungan read_file_lines dan write_file + MTIME_CONFLICT detection
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { bridge } from './bridge-client.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

let currentPath = '';
let currentMtime: number | null = null;
let view: EditorView | null = null;
let dirty = false;

function getLanguageExtension(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'jsx' || ext === 'tsx' });
    case 'html':
    case 'htm':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'json':
    case 'jsonc':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return [];
  }
}

function updateStatus(msg: string) {
  $('statusMsg').textContent = msg;
}

function updateCursorPos(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  $('cursorPos').textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
}

async function loadFile(path: string) {
  currentPath = path;
  dirty = false;
  updateStatus(`Membuka: ${path}`);
  $('fileName').textContent = path.split('/').pop() || path;
  
  try {
    // Gunakan fs.readFileLines untuk membaca file
    const res: any = await bridge.call('fs.readFileLines', { path, startLine: 0, endLine: -1 });
    const content = res.content || '';
    
    // Dapatkan info file untuk mtime
    const info: any = await bridge.call('get_file_info', { path });
    currentMtime = info.mtime || null;
    
    $('fileMeta').textContent = `${content.split('\n').length} lines - ${content.length} chars`;
    
    // Inisialisasi CodeMirror
    if (view) {
      view.destroy();
    }
    
    const startState = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        getLanguageExtension(path),
        keymap.of([
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          {
            key: 'Mod-s',
            run: () => {
              saveFile();
              return true;
            }
          }
        ]),
        EditorView.updateListener.of((update: any) => {
          if (update.docChanged) {
            dirty = true;
            updateStatus(`${path} - belum disimpan`);
          }
          updateCursorPos(update.view);
        })
      ]
    });
    
    view = new EditorView({
      state: startState,
      parent: $('editor')
    });
    
    updateStatus(`Membuka: ${path}`);
  } catch (e: any) {
    updateStatus(`Gagal membuka ${path}: ${e.message}`);
    $('fileMeta').textContent = 'Error';
  }
}

async function saveFile() {
  if (!currentPath || !view) {
    updateStatus('Tidak ada file yang dibuka.');
    return;
  }
  
  updateStatus('Menyimpan...');
  const content = view.state.doc.toString();
  
  try {
    // Kirim content dan mtime untuk deteksi konflik
    await bridge.call('fs.writeFile', { 
      path: currentPath, 
      content, 
      expectedMtime: currentMtime 
    });
    
    // Update mtime setelah save berhasil
    const info: any = await bridge.call('fs.stat', { path: currentPath });
    currentMtime = info.mtime || null;
    
    dirty = false;
    updateStatus(`Tersimpan: ${currentPath}`);
    $('fileMeta').textContent = `${content.split('\n').length} lines - ${content.length} chars`;
  } catch (e: any) {
    if (e.code === 'MTIME_CONFLICT') {
      updateStatus(`KONFLIK: File telah diubah di tempat lain. Simpan dibatalkan untuk mencegah kehilangan data.`);
      if (confirm('File telah diubah di tempat lain sejak Anda membukanya. Apakah Anda ingin menimpa perubahan tersebut?')) {
        // Force save tanpa expectedMtime
        try {
          await bridge.call('write_file', { path: currentPath, content });
          const info: any = await bridge.call('get_file_info', { path: currentPath });
          currentMtime = info.mtime || null;
          dirty = false;
          updateStatus(`Tersimpan (force): ${currentPath}`);
        } catch (err: any) {
          updateStatus(`GAGAL menyimpan: ${err.message}`);
        }
      } else {
        updateStatus(`Simpan dibatalkan oleh pengguna.`);
      }
    } else {
      updateStatus(`GAGAL menyimpan: ${e.message} - file di disk TIDAK berubah.`);
    }
  }
}

// Event listeners
$('btnSave').addEventListener('click', saveFile);
$('btnBack').addEventListener('click', () => {
  if (dirty) {
    if (!confirm('Ada perubahan belum disimpan. Kembali ke side panel?')) {
      return;
    }
  }
  window.close();
});

// Load file dari URL parameter
const params = new URLSearchParams(window.location.search);
const filePath = params.get('path');
if (filePath) {
  loadFile(filePath);
} else {
  updateStatus('Tidak ada file yang ditentukan.');
  $('fileName').textContent = 'Untitled';
  $('fileMeta').textContent = 'Buka file dari side panel';
}
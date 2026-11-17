export type Lang = 'en' | 'id';
export type Theme = 'system' | 'dark' | 'light';

export const translations = {
  en: {
    brandName: 'BroAgentAI',
    noWorkspace: 'No workspace',
    hostOffline: 'Host offline',
    hostOnline: 'Host ready',
    hostError: 'Host error',
    explorer: 'Explorer',
    search: 'Search',
    scm: 'Source Control',
    terminal: 'Terminal',
    agent: 'Agent',
    settings: 'Settings',
    showIgnored: 'Show ignored',
    refresh: 'Refresh',
    newFile: '+ New File',
    newFolder: '+ New Folder',
    save: 'Save',
    close: 'Close',
    commit: 'Commit',
    fetch: 'Fetch',
    pull: 'Pull',
    push: 'Push',
    sessionReady: 'Session: ready',
    noSession: 'No active session',
    settingsTitle: 'Settings',
    companion: 'Companion',
    workspaces: 'Workspaces',
    mcp: 'MCP',
    editor: 'Editor / Agent',
    themeLabel: 'Theme',
    langLabel: 'Language',
    fontSizeLabel: 'Font Size',
    tabSizeLabel: 'Tab Size',
    wordWrapLabel: 'Word wrap',
    systemTheme: 'System (Auto)',
    darkTheme: 'Dark',
    lightTheme: 'Light',
    searchPlaceholder: 'Search text in workspace...',
    caseSensitive: 'Case sensitive',
    regex: 'Regex',
    noResults: 'No results found.',
    enterQuery: 'Enter a search query.',
    selectWorkspaceFirst: 'Select a workspace first.',
    searching: 'Searching...',
    matchesFound: 'Found {count} matches in {files} files',
    noMatches: 'No matches found',
    loadingGit: 'Loading Git status...',
    gitNotAvailable: 'Git not found in PATH. Install Git and click Refresh.',
    notARepo: 'This workspace is not a Git repository.',
    selectWorkspaceForGit: 'Select a workspace to see Git status.',
    branch: 'Branch',
    upstream: 'upstream',
    noUpstream: 'no upstream',
    mergeChanges: 'Merge changes',
    stagedChanges: 'Staged changes',
    changes: 'Changes',
    untracked: 'Untracked',
    commitMessage: 'Commit message',
    commitPlaceholder: 'feat: ...',
    terminalNotOpen: 'Terminal not opened.',
    newTerminal: 'New',
    clearTerminal: 'Clear',
    killTerminal: 'Kill',
    approvalMode: 'Approval mode',
    modeReadOnly: 'Read-only',
    modeAlwaysAsk: 'Always ask',
    modeAskOnce: 'Ask once',
    modeAutoApprove: 'Auto approve',
    modeHintReadOnly: 'The AI can only read. Anything that changes files, Git or runs a command is refused.',
    modeHintAlwaysAsk: 'Every action that changes something needs your approval, every time.',
    modeHintAskOnce: 'You approve each tool the first time; after that it runs on its own for this session. Shell commands are approved per command line.',
    modeHintAutoApprove: 'Everything runs without asking, including shell commands, delete and push.',
    readOnly: 'Read-only',
    ask: 'Ask',
    autoEdit: 'Auto-edit',
    fullAuto: 'Full-auto',
    monitoringAgent: 'Monitoring & Approval Agent',
    home: 'Home',
    homeWorkspace: 'Workspace',
    homeProvider: 'AI Provider',
    homeStart: 'Start Session',
    homeActive: 'Active',
    homeExperimental: 'Experimental',
    homeOpenFolder: 'Open Folder',
    homeNoWorkspace: 'No workspace yet. Open a folder to get started.',
    homeNeedWorkspace: 'Select a workspace first',
    homeOpening: 'Opening {provider}... {s}s',
    homeStarting: 'Starting session...',
    homeSessionActive: 'Session already active',
    agentNoticeShow: 'Show info',
    dismiss: 'Dismiss',
    homeStartHint: 'Opens the provider chat in a new tab, waits for it to load, then starts the agent session.',
    agentDesc: 'Chat stays in your AI tab. This panel runs tool commands from the AI, asks for approval when needed, and logs everything.',
    chatTab: 'Chat tab',
    noChatTab: 'No chat tab open',
    startSession: 'Start session',
    stopSession: 'Stop',
    activity: 'Activity',
    all: 'All',
    success: 'Success',
    denied: 'Denied',
    error: 'Error',
    copy: 'Copy',
    clear: 'Clear',
    displayLang: 'Display & Language',
    companionHost: 'Companion Host',
    manageWorkspaces: 'Manage Workspaces',
    ignorePatterns: 'Ignore patterns',
    mcpServers: 'MCP Servers',
    agentSettings: 'Agent',
    agentDelayLabel: 'Delay before each send',
    agentDelayDesc: 'Seconds the agent waits before typing a tool result into the chat. Raise it when the chat provider rate-limits (DeepSeek). Applies from the next command; refused messages are retried automatically.',
    seconds: 'seconds',
    resend: 'Resend',
    reload: 'Reload',
    diagnostics: 'Diagnostics',
    restartCompanion: 'Restart Companion',
    openFolder: '+ Open folder...',
    manageWorkspacesBtn: 'Manage workspaces...',
    collapseAll: 'Collapse All',
    newFileTip: 'New File...',
    newFolderTip: 'New Folder...',
    workspace: 'Workspace',
    langDesc: 'Language of the panel interface.',
    themeDesc: 'Color theme. System follows the operating system setting.',
    fontSizeDesc: 'Font size in pixels for the panel and the file preview.',
    tabSizeDesc: 'Number of spaces a tab is equal to in the file preview.',
    wordWrapDesc: 'Wrap long lines in the file preview.',
    ignoreDesc: 'Comma-separated names hidden from the explorer and search.',
    versionLabel: 'Version',
    extIdLabel: 'Extension ID'
  },
  id: {
    brandName: 'BroAgentAI',
    noWorkspace: 'Belum ada workspace',
    hostOffline: 'Host offline',
    hostOnline: 'Host siap',
    hostError: 'Host error',
    explorer: 'Explorer',
    search: 'Pencarian',
    scm: 'Source Control',
    terminal: 'Terminal',
    agent: 'Agen',
    settings: 'Pengaturan',
    showIgnored: 'Tampilkan diabaikan',
    refresh: 'Segarkan',
    newFile: '+ File Baru',
    newFolder: '+ Folder Baru',
    save: 'Simpan',
    close: 'Tutup',
    commit: 'Komit',
    fetch: 'Fetch',
    pull: 'Pull',
    push: 'Push',
    sessionReady: 'Sesi: siap',
    noSession: 'Belum ada sesi',
    settingsTitle: 'Pengaturan',
    companion: 'Pendamping',
    workspaces: 'Ruang Kerja',
    mcp: 'MCP',
    editor: 'Editor / Agen',
    themeLabel: 'Tema',
    langLabel: 'Bahasa',
    fontSizeLabel: 'Ukuran Font',
    tabSizeLabel: 'Ukuran Tab',
    wordWrapLabel: 'Word wrap',
    systemTheme: 'Sistem (Otomatis)',
    darkTheme: 'Gelap',
    lightTheme: 'Terang',
    searchPlaceholder: 'Cari teks di workspace...',
    caseSensitive: 'Case sensitive',
    regex: 'Regex',
    noResults: 'Tidak ada hasil ditemukan.',
    enterQuery: 'Masukkan query pencarian.',
    selectWorkspaceFirst: 'Pilih workspace terlebih dahulu.',
    searching: 'Mencari...',
    matchesFound: 'Ditemukan {count} match di {files} file',
    noMatches: 'Tidak ada hasil',
    loadingGit: 'Memuat status Git...',
    gitNotAvailable: 'Git tidak ditemukan di PATH. Install Git lalu klik Segarkan.',
    notARepo: 'Workspace ini bukan repository Git.',
    selectWorkspaceForGit: 'Pilih workspace untuk melihat status Git.',
    branch: 'Branch',
    upstream: 'upstream',
    noUpstream: 'tanpa upstream',
    mergeChanges: 'Perubahan merge',
    stagedChanges: 'Perubahan yang di-stage',
    changes: 'Perubahan',
    untracked: 'Belum dilacak',
    commitMessage: 'Pesan commit',
    commitPlaceholder: 'feat: ...',
    terminalNotOpen: 'Terminal belum dibuka.',
    newTerminal: 'Baru',
    clearTerminal: 'Bersihkan',
    killTerminal: 'Hentikan',
    approvalMode: 'Mode Persetujuan',
    modeReadOnly: 'Hanya-baca',
    modeAlwaysAsk: 'Selalu tanya',
    modeAskOnce: 'Tanya sekali',
    modeAutoApprove: 'Setujui otomatis',
    modeHintReadOnly: 'AI hanya bisa membaca. Semua yang mengubah file, Git, atau menjalankan perintah ditolak.',
    modeHintAlwaysAsk: 'Setiap aksi yang mengubah sesuatu butuh persetujuanmu, setiap kali.',
    modeHintAskOnce: 'Tiap tool kamu setujui saat pertama dipakai; setelah itu jalan sendiri selama sesi ini. Perintah shell disetujui per baris perintah.',
    modeHintAutoApprove: 'Semua jalan tanpa bertanya, termasuk perintah shell, hapus, dan push.',
    readOnly: 'Hanya-baca',
    ask: 'Tanya',
    autoEdit: 'Edit-otomatis',
    fullAuto: 'Otomatis-penuh',
    monitoringAgent: 'Pemantauan & Persetujuan Agen',
    home: 'Beranda',
    homeWorkspace: 'Workspace',
    homeProvider: 'Penyedia AI',
    homeStart: 'Mulai Sesi',
    homeActive: 'Aktif',
    homeExperimental: 'Eksperimental',
    homeOpenFolder: 'Buka Folder',
    homeNoWorkspace: 'Belum ada workspace. Buka folder untuk memulai.',
    homeNeedWorkspace: 'Pilih workspace dulu',
    homeOpening: 'Membuka {provider}... {s} dtk',
    homeStarting: 'Memulai sesi...',
    homeSessionActive: 'Sesi sudah aktif',
    agentNoticeShow: 'Tampilkan info',
    dismiss: 'Tutup',
    homeStartHint: 'Membuka chat provider di tab baru, menunggu termuat, lalu memulai sesi agent.',
    agentDesc: 'Chat tetap di tab AI Anda. Panel ini menjalankan perintah tool dari AI, meminta persetujuan bila perlu, dan mencatat semuanya.',
    chatTab: 'Tab chat',
    noChatTab: 'Tidak ada tab chat terbuka',
    startSession: 'Mulai sesi',
    stopSession: 'Hentikan',
    activity: 'Aktivitas',
    all: 'Semua',
    success: 'Sukses',
    denied: 'Ditolak',
    error: 'Error',
    copy: 'Salin',
    clear: 'Hapus',
    displayLang: 'Tampilan & Bahasa',
    companionHost: 'Host Pendamping',
    manageWorkspaces: 'Kelola Ruang Kerja',
    ignorePatterns: 'Pola abaikan',
    mcpServers: 'Server MCP',
    agentSettings: 'Agent',
    agentDelayLabel: 'Jeda sebelum tiap kirim',
    agentDelayDesc: 'Detik yang ditunggu agent sebelum mengetik hasil tool ke chat. Naikkan kalau provider chat membatasi kecepatan (DeepSeek). Berlaku mulai perintah berikutnya; pesan yang ditolak dicoba ulang otomatis.',
    seconds: 'detik',
    resend: 'Kirim ulang',
    reload: 'Muat Ulang',
    diagnostics: 'Diagnostik',
    restartCompanion: 'Restart Pendamping',
    openFolder: '+ Buka folder...',
    manageWorkspacesBtn: 'Kelola ruang kerja...',
    collapseAll: 'Ciutkan Semua',
    newFileTip: 'File Baru...',
    newFolderTip: 'Folder Baru...',
    workspace: 'Workspace',
    langDesc: 'Bahasa antarmuka panel.',
    themeDesc: 'Tema warna. Sistem mengikuti pengaturan sistem operasi.',
    fontSizeDesc: 'Ukuran font (px) untuk panel dan pratinjau file.',
    tabSizeDesc: 'Jumlah spasi untuk satu tab di pratinjau file.',
    wordWrapDesc: 'Bungkus baris panjang di pratinjau file.',
    ignoreDesc: 'Nama dipisah koma yang disembunyikan dari explorer dan pencarian.',
    versionLabel: 'Versi',
    extIdLabel: 'ID Extension'
  }
};

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

let currentLang: Lang = 'id';

/**
 * Translate one key in the current language. Use this for text set from code:
 * looking the string up in the DOM breaks as soon as the element that carried
 * the `data-i18n` attribute is re-rendered.
 */
export function t(key: string): string {
  const table = translations[currentLang] as Record<string, string>;
  return table[key] ?? (translations.en as Record<string, string>)[key] ?? key;
}

export function translatePage(lang: Lang) {
  const t = translations[lang];
  if (!t) return;
  currentLang = lang;

  // Helper to safely set text content
  const setText = (id: string, key: keyof typeof t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t[key];
  };

  // Header
  // headerWs is dynamic (workspace name or the empty-state text); sidepanel.ts renders it.
  void setText;
  
  // Buttons & Labels (using querySelector for specific texts if needed, but ID is safer)
  // We will rely on the sidepanel.ts to call this and update specific elements dynamically,
  // or we can add data-i18n attributes to HTML. For now, let's update by ID where possible.
  
  // Explorer
  const explorerTitle = document.querySelector('#tab-explorer .panel-head h2');
  if (explorerTitle) explorerTitle.textContent = t.explorer;
  
  // Search
  const searchTitle = document.querySelector('#tab-search .panel-head h2');
  if (searchTitle) searchTitle.textContent = t.search;
  const searchInput = document.getElementById('searchInput') as HTMLInputElement;
  if (searchInput) searchInput.placeholder = t.searchPlaceholder;
  
  // SCM
  const scmTitle = document.querySelector('#tab-scm .panel-head h2');
  if (scmTitle) scmTitle.textContent = t.scm;
  
  // Terminal
  const termTitle = document.querySelector('#tab-terminal .panel-head h2');
  if (termTitle) termTitle.textContent = t.terminal;
  
  // Agent
  const agentTitle = document.querySelector('#tab-agent .panel-head h2');
  if (agentTitle) agentTitle.textContent = t.agent;
  
  // Settings
  const settingsTitle = document.querySelector('#tab-settings .panel-head h2');
  if (settingsTitle) settingsTitle.textContent = t.settings;
  
  // Update selects
  const langSel = document.getElementById('langSel') as HTMLSelectElement;
  if (langSel) {
    langSel.options[0].text = lang === 'id' ? 'Bahasa Indonesia' : 'Indonesian';
    langSel.options[1].text = lang === 'id' ? 'Inggris' : 'English';
  }
  
  const themeSel = document.getElementById('themeSel') as HTMLSelectElement;
  if (themeSel) {
    themeSel.options[0].text = t.systemTheme;
    themeSel.options[1].text = t.darkTheme;
    themeSel.options[2].text = t.lightTheme;
  }

  // Generic pass: every element that declares its key gets translated, so new
  // markup only needs the attribute. Keys without a translation keep their text.
  const table = t as Record<string, string>;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const value = table[el.dataset.i18n!];
    if (value !== undefined && el.id !== 'headerWs') el.textContent = value;
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const value = table[el.dataset.i18nTitle!];
    if (value !== undefined) el.title = value;
  });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    const value = table[el.dataset.i18nPlaceholder!];
    if (value !== undefined) el.placeholder = value;
  });
}

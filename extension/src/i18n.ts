export type Lang = 'en' | 'id';
export type Theme = 'system' | 'dark' | 'light';

export const translations = {
  en: {
    workspace: 'Workspace',
    hostOffline: 'Host offline',
    hostOnline: 'Host online',
    explorer: 'Explorer',
    search: 'Search',
    scm: 'Source Control',
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
    settingsTitle: 'Settings',
    companion: 'Companion',
    workspaces: 'Workspaces',
    config: 'Configuration',
    resources: 'Skills / Agents',
    mcp: 'MCP',
    providers: 'Chat sites',
    editor: 'Editor / Agent',
    themeLabel: 'Theme',
    langLabel: 'Language'
  },
  id: {
    workspace: 'Workspace',
    hostOffline: 'Host offline',
    hostOnline: 'Host online',
    explorer: 'Explorer',
    search: 'Pencarian',
    scm: 'Kontrol Sumber',
    agent: 'Agen',
    settings: 'Pengaturan',
    showIgnored: 'Tampilkan diabaikan',
    refresh: 'Segarkan',
    newFile: '+ File Baru',
    newFolder: '+ Folder Baru',
    save: 'Simpan',
    close: 'Tutup',
    commit: 'Komit',
    fetch: 'Ambil',
    pull: 'Tarik',
    push: 'Dorong',
    sessionReady: 'Sesi: siap',
    settingsTitle: 'Pengaturan',
    companion: 'Pendamping',
    workspaces: 'Ruang Kerja',
    config: 'Konfigurasi',
    resources: 'Keterampilan / Agen',
    mcp: 'MCP',
    providers: 'Situs Chat',
    editor: 'Editor / Agen',
    themeLabel: 'Tema',
    langLabel: 'Bahasa'
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

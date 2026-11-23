type ExtensionApi = typeof chrome;

type PanelCapableApi = Omit<ExtensionApi, 'sidePanel'> & {
  sidePanel?: {
    setPanelBehavior?: (info: { openPanelOnActionClick: boolean }) => Promise<void>;
    setOptions?: (options: { path?: string; enabled?: boolean; tabId?: number }) => Promise<void>;
    getLayout?: (callback: (layout?: { side?: string }) => void) => void;
  };
};

type GlobalWithExtensionApis = typeof globalThis & {
  browser?: ExtensionApi;
  chrome?: ExtensionApi;
};

export interface PanelLayout {
  side?: 'left' | 'right';
}

export interface PanelApi {
  configure(options: { path: string; openOnActionClick?: boolean }): Promise<void>;
  getLayout(): Promise<PanelLayout>;
}

export interface UserScriptsApi {
  configureWorld(properties: { worldId?: string; csp?: string; messaging?: boolean }): Promise<void>;
  getScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string }>>;
  register(scripts: Array<{ id: string; matches: string[]; js: Array<{ code: string }>; runAt?: string; world?: string; worldId?: string }>): Promise<void>;
  unregister(filter?: { ids?: string[] }): Promise<void>;
}

const scope = globalThis as GlobalWithExtensionApis;
export const isFirefox = typeof scope.browser !== 'undefined';
const missingApi = new Proxy({}, {
  get() { throw new Error('BroAgentAI: WebExtension API is unavailable'); },
}) as PanelCapableApi;
const impl = (scope.browser ?? scope.chrome ?? missingApi) as PanelCapableApi;

function createPanelApi(api: PanelCapableApi, firefox: boolean, available: boolean): PanelApi {
  const sidePanel = available ? api.sidePanel : undefined;
  if (firefox || !sidePanel) {
    return {
      async configure() {},
      async getLayout() { return { side: 'right' }; },
    };
  }
  return {
    async configure({ path, openOnActionClick = true }) {
      if (openOnActionClick && sidePanel.setPanelBehavior) {
        await sidePanel.setPanelBehavior({ openPanelOnActionClick: openOnActionClick }).catch(() => {});
      }
      if (sidePanel.setOptions) {
        await sidePanel.setOptions({ path, enabled: true }).catch(() => {});
      }
    },
    getLayout() {
      const getLayout = sidePanel.getLayout;
      if (!getLayout) return Promise.resolve({ side: 'right' });
      return new Promise<PanelLayout>((resolve) => {
        try {
          getLayout((layout) => resolve(layout?.side === 'left' ? { side: 'left' } : { side: 'right' }));
        } catch {
          resolve({ side: 'right' });
        }
      });
    },
  };
}

const hasApi = typeof scope.browser !== 'undefined' || typeof scope.chrome !== 'undefined';
const panel = createPanelApi(impl, isFirefox, hasApi);
export const browser = new Proxy(impl, {
  get(target, property) {
    if (property === 'panel') return panel;
    return Reflect.get(target, property);
  },
}) as ExtensionApi & { panel: PanelApi };

export type Port = chrome.runtime.Port;
export type Tab = chrome.tabs.Tab;
export type RegisteredContentScript = chrome.scripting.RegisteredContentScript;

export function userScriptsApi(): UserScriptsApi | null {
  const api = (browser as unknown as { userScripts?: UserScriptsApi }).userScripts;
  return typeof api?.register === 'function' ? api : null;
}

export function lastError(): { message?: string } | undefined {
  try {
    return browser.runtime.lastError;
  } catch {
    return undefined;
  }
}

export function currentTab(): Promise<Tab | undefined> {
  if (isFirefox) {
    return (browser.tabs as unknown as { getCurrent: () => Promise<Tab | undefined> }).getCurrent();
  }
  return new Promise<Tab | undefined>((resolve) => {
    try {
      (browser.tabs as unknown as { getCurrent: (callback: (tab?: Tab) => void) => void }).getCurrent((tab) => resolve(tab));
    } catch {
      resolve(undefined);
    }
  });
}

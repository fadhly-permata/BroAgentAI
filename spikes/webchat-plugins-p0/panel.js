// P0 spike side panel: runs the checks of specs/09-WEBCHAT-PLUGINS.md §5 P0.
const MATCHES = ['https://example.com/*'];
const out = document.getElementById('out');

async function record(key, value) {
  const { p0 = {} } = await chrome.storage.local.get('p0');
  p0[key] = value;
  await chrome.storage.local.set({ p0 });
}
async function show() {
  const { p0 = {} } = await chrome.storage.local.get('p0');
  out.textContent = JSON.stringify(p0, null, 2);
}
const safe = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } };

// Code of a "plugin" user script, built from a string the way user plugins
// will be (stored text, not a bundled file). Results go onto <html> attributes
// so the test page (and a reader in the MAIN world) can see them.
function pluginCode(name) {
  return `(() => {
    const root = document.documentElement;
    const set = (k, v) => root.setAttribute('data-p0-us-${name}-' + k, typeof v === 'string' ? v : JSON.stringify(v));
    window.__p0Name = '${name}';
    set('loaded', { chrome: typeof chrome, sendMessage: typeof chrome?.runtime?.sendMessage, storage: typeof chrome?.storage });
    // C5: synchronous DOM-event bridge from the content script (isolated world).
    document.addEventListener('p0:ping', (e) => { e.target.setAttribute('data-p0-reply-${name}', String(window.__p0Name)); }, true);
    // C4: messaging to the extension.
    try {
      chrome.runtime.sendMessage({ from: '${name}', kind: 'hello' })
        .then((r) => set('msg', r), (e) => set('msg', 'ERR ' + e.message));
    } catch (e) { set('msg', 'THROW ' + e.message); }
    // C9: network and eval under the world CSP.
    fetch('https://example.com/?p0=' + Date.now()).then((r) => set('fetch', 'ok ' + r.status), (e) => set('fetch', 'blocked ' + e.message));
    try { set('eval', String(eval('1 + 1'))); } catch (e) { set('eval', 'blocked ' + e.message); }
  })();`;
}

document.getElementById('perm').addEventListener('click', async () => {
  // C8: permission request from a side-panel click.
  const res = await safe(() => chrome.permissions.request({ origins: MATCHES }));
  const has = await safe(() => chrome.permissions.contains({ origins: MATCHES }));
  await record('permission', { request: res, contains: has, time: new Date().toISOString() });
  await show();
});

document.getElementById('setup').addEventListener('click', async () => {
  const result = {};
  // C1: is the userScripts API usable (toggle on)?
  result.userScriptsAvailable = await safe(() => chrome.userScripts.getScripts().then(() => true));
  if (!result.userScriptsAvailable.ok) { await record('setup', result); await show(); return; }

  await safe(() => chrome.userScripts.unregister());
  await safe(() => chrome.scripting.unregisterContentScripts());

  // C2: one world per plugin. A gets a strict CSP, B the default one.
  result.configureA = await safe(() => chrome.userScripts.configureWorld({ worldId: 'plugin-a', messaging: true, csp: "script-src 'self'; connect-src 'none'" }));
  result.configureB = await safe(() => chrome.userScripts.configureWorld({ worldId: 'plugin-b', messaging: true }));

  // C3: two plugins on the same page, separate worlds.
  result.registerUserScripts = await safe(() => chrome.userScripts.register([
    { id: 'p0-a', matches: MATCHES, js: [{ code: pluginCode('A') }], worldId: 'plugin-a', runAt: 'document_start' },
    { id: 'p0-b', matches: MATCHES, js: [{ code: pluginCode('B') }], worldId: 'plugin-b', runAt: 'document_start' },
  ]));

  // C6 + C7: dynamic content script with JS and CSS, persisted across sessions.
  result.registerContentScript = await safe(() => chrome.scripting.registerContentScripts([
    { id: 'p0-cs', matches: MATCHES, js: ['cs.js'], css: ['cs.css'], runAt: 'document_idle', persistAcrossSessions: true },
  ]));

  result.registrations = await chrome.runtime.sendMessage({ type: 'p0:registrations' });
  result.time = new Date().toISOString();
  await record('setup', result);
  await show();
});

document.getElementById('show').addEventListener('click', show);
document.getElementById('clear').addEventListener('click', async () => {
  await safe(() => chrome.userScripts.unregister());
  await safe(() => chrome.scripting.unregisterContentScripts());
  await chrome.storage.local.remove('p0');
  await show();
});

show();

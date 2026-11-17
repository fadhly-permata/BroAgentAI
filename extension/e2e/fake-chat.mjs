// fake-chat.mjs - a scripted stand-in for a provider chat page.
//
// The page is served (via Playwright routing) at the DeepSeek URL and uses the
// DOM shape the bundled deepseek provider.json expects, so the REAL content
// script is injected and the REAL relay / parser / approval loop runs. Only
// the "AI" is fake: it answers from the fixed rules below, streaming its
// reply in two steps like a real chat does.
//
// The DOM shape mirrors the live site as inspected on 2026-11-17: an id-less
// <textarea>, replies in .ds-markdown.ds-assistant-message-main-content, code in
// a bare <pre> (no <code>) inside .md-code-block next to a language label and
// Copy/Download buttons, and a round send button that is disabled when idle and
// becomes an enabled Stop button while the reply streams. The live site can
// still change; re-check provider.json when the health check fails.
export const FAKE_CHAT_URL = 'https://chat.deepseek.com/';

const html = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Fake DeepSeek (e2e)</title>
<style>body{font-family:sans-serif;margin:16px}.user{color:#555;white-space:pre-wrap;border-left:3px solid #999;padding-left:8px;margin:8px 0;max-height:120px;overflow:auto}
.ds-markdown{border-left:3px solid #06c;padding-left:8px;margin:8px 0}pre{background:#eee;padding:6px}textarea{width:100%;height:60px}</style></head>
<body>
<div id="messages"></div>
<textarea placeholder="Message DeepSeek"></textarea>
<div role="button" id="sendBtn" class="ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--disabled" style="width:32px;height:32px;border-radius:50%;background:#06c"></div>
<script>
const box = document.getElementById('messages');
const input = document.querySelector('textarea');
const sendBtn = document.getElementById('sendBtn');
const cmd = (command, params) => JSON.stringify({ command, params });

// Each rule: [test(userText), prose, ...codeBlocks]
// The real shell computes the number, so the marker cannot come from echoing the command text.
const isWin = /win/i.test(navigator.platform);
const shellCmd = (n, tag) => (isWin ? 'Write-Output "$(' + n + '*7)-shell-' + tag + '"' : 'echo "$((' + n + '*7))-shell-' + tag + '"');

const rules = [
  [(t) => t.includes('BroAgentAI operating instructions'), 'READY'],
  [(t) => /baca readme/i.test(t), 'Baik, saya baca README dulu.', cmd('fs.readFile', { path: 'README.md' })],
  [(t) => t.startsWith('[BroAgentAI tool result] fs.readFile OK'), 'Sekarang saya tulis catatannya.',
    (t) => cmd('fs.writeFile', { path: 'notes-from-ai.txt', content: 'README starts with: ' + ((t.match(/"content": "([^\\\n"]*)/) || [])[1] || '?') + '\n' })],
  [(t) => t.startsWith('[BroAgentAI tool result] fs.writeFile OK'), 'Selesai. Catatan sudah ditulis.'],
  [(t) => /tulis langsung/i.test(t), 'Saya tulis file.', cmd('fs.writeFile', { path: 'direct.txt', content: 'written directly\n' })],
  [(t) => /dua perintah/i.test(t), 'Dua sekaligus.', cmd('fs.readFile', { path: 'README.md' }), cmd('fs.readFile', { path: 'image.bin' })],
  // DeepSeek sometimes answers in its native tool-call markup ("DSML") instead of JSON.
  [(t) => /pakai dsml/i.test(t), '<｜DSML｜function_calls>\n<｜DSML｜invoke name="fs.readFile">\n<｜DSML｜parameter name="path" string="true">README.md</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>'],
  [(t) => /tool tak dikenal/i.test(t), 'Coba tool lain.', cmd('fs.format', { path: 'README.md' })],
  [(t) => /keluar workspace/i.test(t), 'Saya coba baca di luar.', cmd('fs.readFile', { path: '../outside.txt' })],
  [(t) => /push sekarang/i.test(t), 'Saya push.', cmd('git.push', {})],
  [(t) => /jalankan shell satu/i.test(t), 'Saya jalankan perintah.', cmd('shell.run', { command: shellCmd(6, 'one') })],
  [(t) => /jalankan shell lain/i.test(t), 'Saya jalankan perintah lain.', cmd('shell.run', { command: shellCmd(7, 'two') })],
  [(t) => t.startsWith('[BroAgentAI tool result] shell.run OK'), (t) => 'Shell menjawab: ' + ((t.match(/(\d+-shell-\w+)/) || [])[1] || '?')],
  [(t) => t.startsWith('[BroAgentAI tool result] git.push OK'), 'Selesai. Sudah di-push.'],
  [(t) => /pakai mcp/i.test(t), 'Saya panggil MCP.', cmd('mcp.fx.echo', { text: 'from chat' })],
  [(t) => t.startsWith('[BroAgentAI tool result] mcp.fx.echo OK'), 'MCP menjawab.'],
  [(t) => t.startsWith('[BroAgentAI tool result]') && / ERROR/.test(t.split('\n')[0]), (t) => 'Baik, saya berhenti. Alasan: ' + t.split('\n').slice(2).join(' ').slice(0, 120)],
  [(t) => t.startsWith('[BroAgentAI] '), 'Maaf, saya perbaiki formatnya nanti.'],
  [() => true, 'Saya tidak punya jawaban untuk itu.'],
];

// Like the live page, each message sits in a wrapper with an ordering key
// (assistant positive, user negative) and old messages can leave the DOM.
let turn = 0;
const wrapMessage = (el, key) => {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-virtual-list-item-key', String(key));
  wrap.appendChild(el);
  box.appendChild(wrap);
  return wrap;
};
// Simulates scrolling up in a virtualized list: the newest assistant message
// leaves the DOM, so an OLDER one becomes the last assistant element.
window.__scrollAwayNewest = () => {
  const wraps = [...box.children].filter((w) => w.querySelector('.ds-assistant-message-main-content'));
  const newest = wraps[wraps.length - 1];
  window.__detached = newest;
  newest.remove();
  return wraps.length - 1;
};
window.__scrollBack = () => { if (window.__detached) box.appendChild(window.__detached); };

function addAssistant(prose, blocks, key) {
  const el = document.createElement('div');
  el.className = 'ds-markdown ds-assistant-message-main-content';
  sendBtn.classList.remove('ds-button--disabled'); // Stop button while generating
  const p = document.createElement('p');
  p.textContent = prose.slice(0, Math.ceil(prose.length / 2)); // first half "streams" in
  el.appendChild(p);
  wrapMessage(el, key);
  setTimeout(() => {
    p.textContent = prose;
    for (const block of blocks) {
      const wrap = document.createElement('div');
      wrap.className = 'md-code-block';
      wrap.innerHTML = '<div class="md-code-block-banner"><span>json</span><div role="button">Copy</div><div role="button">Download</div></div>';
      const pre = document.createElement('pre');
      pre.textContent = block;
      wrap.appendChild(pre);
      el.appendChild(wrap);
    }
    window.scrollTo(0, document.body.scrollHeight);
    sendBtn.classList.add('ds-button--disabled');
  }, 2500); // > relay stability window: only the generating selector prevents a premature report
}

// Rate-limit stand-in: refuse this many agent-typed messages, leaving the text
// in the composer and showing a toast, like a provider that throttles sends.
window.__rejectAgentSends = 0;
function submit() {
  const text = input.value;
  if (!text.trim()) return;
  if (window.__rejectAgentSends > 0 && text.startsWith('[BroAgentAI')) {
    window.__rejectAgentSends--;
    const toast = document.createElement('div');
    toast.className = 'rate-limit-toast';
    toast.textContent = 'You are sending messages too frequently. Please wait.';
    document.body.appendChild(toast);
    return;
  }
  input.value = '';
  const user = document.createElement('div');
  user.className = 'user';
  user.textContent = text;
  turn += 2;
  const key = turn; // the reply belongs to this turn even if the user types again meanwhile
  wrapMessage(user, -key);
  const rule = rules.find((r) => r[0](text));
  const resolve = (part) => (typeof part === 'function' ? part(text) : part);
  setTimeout(() => addAssistant(resolve(rule[1]), rule.slice(2).map(resolve), key), 250);
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});
</script></body></html>`;

/** Serve the fake chat for every request to the provider origin. */
export async function routeFakeChat(ctx) {
  await ctx.route('https://chat.deepseek.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
}

/** Type a message into the fake chat as the user would. */
export async function say(chatPage, text) {
  await chatPage.locator('textarea').fill(text);
  await chatPage.locator('textarea').press('Enter');
}

export const lastAssistant = (chatPage) => chatPage.locator('.ds-assistant-message-main-content').last().innerText();
export const lastUser = (chatPage) => chatPage.locator('.user').last().innerText();

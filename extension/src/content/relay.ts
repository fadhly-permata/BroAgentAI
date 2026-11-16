// Content-script relay, injected only on bundled provider URLs.
// It does two things and nothing else: type a prompt into the chat composer
// when the side panel asks, and report each finished assistant reply. It has
// no access to files, Git or MCP; those live behind the panel and the bridge.
import { DomAdapter } from '../providers/dom-adapter.js';
import { providerForUrl } from '../providers/registry.js';

const POLL_MS = 400;
/** A reply counts as finished after its text stayed unchanged for this many polls. */
const STABLE_POLLS = 3;

const provider = providerForUrl(location.href);

if (provider) {
  const adapter = new DomAdapter(provider);
  let active = false;
  let reported = { count: 0, text: '' };
  let candidate = { count: 0, text: '', polls: 0 };
  let timer: number | undefined;

  const poll = () => {
    if (!active) return;
    let reply;
    try { reply = adapter.readLatestReply(); } catch { return; }
    if (reply.count === 0 || adapter.isGenerating()) { candidate.polls = 0; return; }
    if (reply.count === reported.count && reply.text === reported.text) return;

    if (reply.count === candidate.count && reply.text === candidate.text) candidate.polls++;
    else candidate = { count: reply.count, text: reply.text, polls: 1 };
    if (candidate.polls < STABLE_POLLS || reply.text.trim() === '') return;

    reported = { count: reply.count, text: reply.text };
    chrome.runtime.sendMessage({ type: 'ba.reply', provider: provider.id, reply }).catch(() => {
      // The side panel is closed: nobody is listening, so pause until reactivated.
      active = false;
    });
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only this extension's own pages may drive the relay.
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return;

    if (message.type === 'ba.ping') {
      sendResponse({ ...adapter.health(), label: provider.label, status: provider.status, active });
      return;
    }
    if (message.type === 'ba.activate') {
      // Replies already on the page belong to the past; only new ones are reported.
      const current = adapter.readLatestReply();
      reported = { count: current.count, text: current.text };
      candidate = { count: 0, text: '', polls: 0 };
      active = true;
      window.clearInterval(timer);
      timer = window.setInterval(poll, POLL_MS);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'ba.deactivate') {
      active = false;
      window.clearInterval(timer);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'ba.send') {
      adapter.sendPrompt(String(message.text ?? ''))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true; // async response
    }
  });
}

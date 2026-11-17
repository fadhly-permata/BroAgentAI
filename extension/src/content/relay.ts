// Content-script relay, injected only on bundled provider URLs.
// It does two things and nothing else: type a prompt into the chat composer
// when the side panel asks, and report each finished assistant reply. It has
// no access to files, Git or MCP; those live behind the panel and the bridge.
import { DomAdapter, NOT_ACCEPTED } from '../providers/dom-adapter.js';
import { providerForUrl } from '../providers/registry.js';
import { startAgentMarks } from './agent-marks.js';
import { ReplyTracker } from './reply-tracker.js';

const POLL_MS = 400;
/** A reply counts as finished after its text stayed unchanged this long. */
const STABLE_MS = 1200;
/** Stop polling after deliveries kept failing this long (the side panel is gone). */
const GIVE_UP_MS = 60_000;

const provider = providerForUrl(location.href);
const loadedAt = Date.now();

if (provider) {
  // Agent-typed messages get their own look, session or not (they persist in the chat history).
  startAgentMarks(provider);
  const adapter = new DomAdapter(provider);
  const tracker = new ReplyTracker(STABLE_MS);
  let active = false;
  let timer: number | undefined;
  let failingSince = 0;

  const stop = () => {
    active = false;
    window.clearInterval(timer);
  };

  const deliver = (reply: ReturnType<DomAdapter['readLatestReply']>) => {
    const failed = () => {
      tracker.failed();
      // Keep offering the reply: the panel may be busy reloading. Only a long
      // silence means it is gone; then pause until it activates us again.
      if (failingSince === 0) failingSince = Date.now();
      else if (Date.now() - failingSince > GIVE_UP_MS) stop();
    };
    chrome.runtime.sendMessage({ type: 'ba.reply', provider: provider.id, reply })
      .then((res) => {
        if (!res?.ok) return failed();
        failingSince = 0;
        tracker.delivered(reply);
      })
      .catch(failed);
  };

  // Called from our own interval and from the side panel's tick. A hidden tab
  // gets its timers throttled (down to once a minute after a few minutes in
  // the background); messages from the panel are not, so a long-running task
  // in a background tab still finishes promptly.
  const poll = () => {
    if (!active) return;
    let reply;
    try { reply = adapter.readLatestReply(); } catch { return; }
    const ready = tracker.observe(reply, adapter.isGenerating(), Date.now());
    if (ready) deliver(reply);
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only this extension's own pages may drive the relay.
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return;

    if (message.type === 'ba.ping') {
      sendResponse({ ...adapter.health(), label: provider.label, status: provider.status, active });
      return;
    }
    if (message.type === 'ba.tick') {
      poll();
      sendResponse({ active, composer: adapter.health().composer, loadedMs: Date.now() - loadedAt });
      return;
    }
    if (message.type === 'ba.activate') {
      // Replies already on the page belong to the past; only new ones are reported.
      tracker.reset(adapter.readLatestReply());
      failingSince = 0;
      active = true;
      window.clearInterval(timer);
      timer = window.setInterval(poll, POLL_MS);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'ba.deactivate') {
      stop();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'ba.send') {
      adapter.sendPrompt(String(message.text ?? ''))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          const text = error instanceof Error ? error.message : String(error);
          sendResponse({ ok: false, code: text.startsWith(NOT_ACCEPTED) ? NOT_ACCEPTED : 'SEND_FAILED', error: text });
        });
      return true; // async response
    }
  });
}

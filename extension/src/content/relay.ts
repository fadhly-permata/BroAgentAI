// Content-script relay, injected on the pages of the enabled web chat plugins:
// statically for built-in plugins (manifest), dynamically for user plugins
// (registered by the service worker, see plugins/sync.ts).
// It does two things and nothing else: type a prompt into the chat composer
// when the side panel asks, and report each finished assistant reply. It has
// no access to files, Git or MCP; those live behind the panel and the bridge.
// Order matters: plugin-global exposes BroAgentAI.registerPlugin before
// plugin-scripts evaluates the built-in plugin.js files that call it.
import './plugin-global.js';
import './plugin-scripts.js';
import { DomAdapter, NOT_ACCEPTED } from '../providers/dom-adapter.js';
import { providerForUrl, refreshProviders } from '../providers/registry.js';
import type { ProviderInfo } from '../providers/types.js';
import { PREPARE_TIMEOUT_MS, runPrepare } from '../plugins/hooks.js';
import { callUserHook } from '../plugins/user-world.ts';
import { createHookApi } from '../plugins/hook-api.js';
import { startAgentMarks } from './agent-marks.js';
import { ReplyTracker } from './reply-tracker.js';

const POLL_MS = 400;
/** A reply counts as finished after its text stayed unchanged this long. */
const STABLE_MS = 1200;
/** Stop polling after deliveries kept failing this long (the side panel is gone). */
const GIVE_UP_MS = 60_000;

const loadedAt = Date.now();

// A page can get the relay twice (the static content script of a built-in plugin
// and the dynamic one of a user plugin whose patterns overlap it). Both run in
// this extension's isolated world, so a flag there keeps only the first.
const RELAY_FLAG = Symbol.for('broagentai.relay');
const relayGlobal = globalThis as unknown as Record<symbol, boolean>;
if (!relayGlobal[RELAY_FLAG]) {
  relayGlobal[RELAY_FLAG] = true;
  // User plugins live in chrome.storage; merge them before picking this page's plugin.
  void refreshProviders().then(() => {
    const provider = providerForUrl(location.href);
    if (provider) startRelay(provider);
  });
}

/**
 * Run the page plugin's prepare hook. Built-in hooks are bundled into this
 * relay; a user plugin's plugin.js runs in its own world and is reached through
 * the DOM bridge (plugins/user-world.ts). A user plugin that overrides a
 * built-in replaces it completely, so the built-in hook does not run then.
 */
function prepareFor(provider: ProviderInfo): Promise<{ ran: boolean; error?: string }> {
  if (provider.source === 'user') {
    return provider.hasScript ? callUserHook(provider.id, 'prepare', PREPARE_TIMEOUT_MS) : Promise.resolve({ ran: false });
  }
  return runPrepare(provider.id, createHookApi());
}

function startRelay(provider: ProviderInfo): void {
  // Agent-typed messages get their own look, session or not (they persist in the chat history).
  startAgentMarks(provider);
  const adapter = new DomAdapter(provider);
  const tracker = new ReplyTracker(STABLE_MS);
  let active = false;
  /**
   * Set when the panel asks us to hold (the chat tab lost focus). The page keeps
   * its own timers going, but poll() returns early so no reply is read or
   * delivered while paused; whatever the AI already answered is still the
   * latest reply and is offered as soon as the panel resumes us.
   */
  let paused = false;
  let timer: number | undefined;
  let failingSince = 0;

  const stop = () => {
    active = false;
    paused = false;
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
  // in a background tab still finishes promptly. While paused we skip the
  // whole body: no read, no observe, no delivery.
  const poll = () => {
    if (!active || paused) return;
    let reply;
    try { reply = adapter.readLatestReply(); } catch { return; }
    const ready = tracker.observe(reply, adapter.isGenerating(), Date.now());
    if (ready) deliver(reply);
  };

  /** Id of the blocking prompt (plugin's blockingPrompts) showing now, or null. Never throws. */
  const blocking = (): string | null => {
    try { return adapter.blockingPrompt()?.rule.id ?? null; } catch { return null; }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only this extension's own pages may drive the relay.
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return;

    if (message.type === 'ba.ping') {
      const generating = adapter.isGenerating();
      sendResponse({ ...adapter.health(), label: provider.label, status: provider.status, active, paused, generating, blocking: generating ? null : blocking() });
      return;
    }
    if (message.type === 'ba.tick') {
      poll();
      // A blocking prompt only shows once the site stopped generating; skip the page scan while it streams.
      const scan = active && !paused && !adapter.isGenerating();
      sendResponse({ active, paused, composer: adapter.health().composer, loadedMs: Date.now() - loadedAt, blocking: scan ? blocking() : null });
      return;
    }
    if (message.type === 'ba.blocking.press') {
      // Press the one button the plugin's rule names (never an upgrade or billing control).
      if (paused) { sendResponse({ ok: false, code: 'PAUSED', error: 'relay paused (chat tab not focused)' }); return; }
      try {
        const pressed = adapter.pressBlockingPrompt(String(message.id ?? ''));
        sendResponse(pressed === null ? { ok: false, error: 'blocking prompt not found' } : { ok: true, button: pressed });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'ba.activate') {
      // The plugin's prepare hook first (close popups, pick a mode), so the
      // operating prompt lands in a page that is ready for it. Never throws;
      // a failed or slow hook is reported and the session goes on.
      void prepareFor(provider).then((prepare) => {
        // Replies already on the page belong to the past; only new ones are reported.
        tracker.reset(adapter.readLatestReply());
        failingSince = 0;
        active = true;
        paused = false;
        window.clearInterval(timer);
        timer = window.setInterval(poll, POLL_MS);
        sendResponse({ ok: true, prepare });
      });
      return true;
    }
    if (message.type === 'ba.pause') {
      // Hold: keep the tracker state, just stop reporting. The latest reply is
      // not discarded, so resuming picks it up if it is still new.
      paused = true;
      failingSince = 0;
      sendResponse({ ok: true, paused });
      return;
    }
    if (message.type === 'ba.resume') {
      paused = false;
      failingSince = 0;
      sendResponse({ ok: true, paused });
      return;
    }
    if (message.type === 'ba.transcript') {
      // Read-only: the conversation on the page, for the handoff snapshot.
      // Allowed while paused or inactive - it types nothing and reports nothing.
      try {
        sendResponse({ ok: true, messages: adapter.readConversation() });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'ba.deactivate') {
      stop();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'ba.send') {
      // A held relay must not type anything into the chat either.
      if (paused) { sendResponse({ ok: false, code: 'PAUSED', error: 'relay paused (chat tab not focused)' }); return; }
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

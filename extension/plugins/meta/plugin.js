// Meta AI web chat plugin hooks. See specs/09-WEBCHAT-PLUGINS.md §3.3.
BroAgentAI.registerPlugin('meta', {
  // A fenced ```json reply renders as an interactive viewer (.ur-code-block)
  // that opens in "Tree" view: expander glyphs (▶) sit inside the JSON text and
  // large values are abridged ("[1 item]"), so the reply cannot be parsed as a
  // command. Switch command-shaped viewers to "Raw" (the verbatim <pre>), once
  // now and again whenever React remounts one while the session streams.
  prepare() {
    if (globalThis.__baMetaRawViewer) return;
    globalThis.__baMetaRawViewer = true;
    const COMMAND_SHAPED = /"(?:command|tool)"\s*:/;
    const clickedAt = new WeakMap();
    const sweep = () => {
      for (const wrap of document.querySelectorAll('.ur-code-block')) {
        if (!COMMAND_SHAPED.test(wrap.textContent || '')) continue;
        if (wrap.querySelector('pre')) continue; // already showing Raw
        const now = Date.now();
        if (now - (clickedAt.get(wrap) || 0) < 1000) continue; // let React render
        const raw = [...wrap.querySelectorAll('button, [role="tab"]')].find(
          (control) => (control.textContent || '').trim().toLowerCase() === 'raw',
        );
        if (!raw) continue;
        clickedAt.set(wrap, now);
        raw.click();
      }
    };
    new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(sweep, 750);
    sweep();
  },
});

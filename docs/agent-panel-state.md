# Agent panel state: persistence and survival ("Option B")

Status: **open follow-up**. Option A (below) is already done; this note describes
what to build next if the panel still resets in some situations.

## What Option A already fixed

The agent session (`session`, `logs`, `queue`, `phase`) lives as module-level
variables in `extension/src/agent-panel.ts`, i.e. in the **side panel page's
memory**. The background used to call
`chrome.sidePanel.setOptions({ tabId, path, enabled })` for every tab, which gave
each tab its **own** panel page. Switching tabs therefore created a fresh panel
page with empty state and looked like a reset (`session = null`, logs empty,
Start button back).

Option A removes the per-tab override in `extension/src/background.ts` and keeps
one **global** side panel (`setOptions({ path, enabled })` without `tabId`). A
single panel survives tab switches, so the state no longer resets on switching
tabs.

## What is still not solved (the reason Option B exists)

Even with a global panel, the panel page can still be torn down by Chrome:
- Chrome may discard a side panel that has been closed/hidden for a while.
- Reloading the extension, reloading the panel, or closing the window drops it.
- A crash of the panel page loses everything.

When the panel page is recreated, all module-level state is gone again, and there
is currently **no rehydration**: the session and activity log are not persisted
anywhere. So a genuine teardown still looks like a reset.

## Option B: persist and rehydrate the session

Goal: a session that was running when the panel page died should come back (or
at least not silently vanish) when the panel loads again.

### Where to persist
- `chrome.storage.session` for per-window/browser-session data (cleared when the
  browser closes). Good fit for "a running session".
- `chrome.storage.local` only if a session should survive a browser restart
  (probably not desired: the chat tab and relay state are gone anyway).

### What to persist (minimal set)
From `Session` in `agent-panel.ts`:
- `tabId` (the chat tab it drives)
- `provider.id`
- `toolCalls`, `totalCalls`
- `lastSent`, `lastReplyText`, `resumeGuard`
- `paused`
- the `allowed` set (ask-once approvals) - serialize as an array
- the recent `logs` (cap it, e.g. last 200 entries)
- the current `phase` (kind/label) so the status line can be restored

Do **not** persist transient promises (`queue`, `pendingApproval`); a pending
approval is denied on teardown and must be re-asked.

### Rehydration flow (on panel load)
1. Read the persisted snapshot from `chrome.storage.session`.
2. If present, verify the chat tab still exists (`chrome.tabs.get(tabId)`); if
   not, drop the snapshot and show a toast that the previous session ended.
3. Verify the relay still answers (`ba.ping`) and re-activate it (`ba.activate`)
   if it lost its state (same guard as the existing `RESUME_AFTER_MS` path).
4. Rebuild `session`, restore `logs`, restore `phase`, then call
   `syncFocusWithSession()` so a backgrounded chat tab comes back paused.
5. Set `resumeGuard = lastReplyText` so the last handled reply is not acted on a
   second time.

### Critical guard: only one live panel drives a session
The panel is per-window, so two windows could both load and try to rehydrate the
same snapshot. Prevent a double loop:
- Store an `ownerPanelId` (a random id generated when a panel creates the session)
  with the snapshot.
- A panel only rehydrates if it is the owner, or if it can claim ownership with an
  atomic check-and-set (re-read storage, confirm still unowned/none-fresh, write
  own id). Keep the existing rule that a reply is only handled by the panel whose
  `session.tabId` matches the sender (already in `initAgent`).

### Persist points (where to write the snapshot)
- On session start / stop.
- On pause / resume.
- After each tool call and after each logged entry (debounced, e.g. 250 ms).
- On `visibilitychange`/`pagehide` of the panel page, flush the latest snapshot.

### Files likely touched
- `extension/src/agent-panel.ts` - snapshot read/write, rehydrate on `initAgent`,
  ownership guard, persist on the points above.
- `extension/src/background.ts` - only if ownership should be arbitrated in the
  service worker instead of per-panel storage checks.
- `extension/manifest.json` - no new permission needed (`storage` is already
  granted; `chrome.storage.session` uses it).

### Acceptance checks
- Start a session, switch tabs: still running, not reset (Option A).
- Close the panel, reopen it: session is restored, status shows the same phase,
  activity log is back, chat tab is still driven.
- Close the chat tab while the panel is closed: reopening the panel does NOT
  restore a phantom session; it reports that the previous session ended.
- Two windows open: only one drives the session; the other does not double-act.

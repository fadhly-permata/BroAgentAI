// Timing rules for the agent loop, kept pure so they can be unit tested.

/** How long the panel waits for an ordinary tool call before giving up. */
export const DEFAULT_TOOL_TIMEOUT_MS = 130_000;
/** Upper bound of a shell command's own timeout in the bridge (shell.ts MAX_SHELL_TIMEOUT_MS). */
export const MAX_TOOL_RUN_MS = 10 * 60_000;
/** Slack on top of a tool's own timeout, so the bridge reports first. */
const TOOL_TIMEOUT_SLACK_MS = 30_000;

/**
 * Panel-side timeout for one agent.callTool. A tool that brings its own
 * `timeoutMs` (shell.run allows up to 10 minutes) must not be cut off by the
 * panel first: the result would be lost while the command keeps running.
 */
export function toolTimeoutMs(params: Record<string, unknown>): number {
  const asked = params.timeoutMs;
  if (typeof asked !== 'number' || !Number.isFinite(asked) || asked <= 0) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.max(DEFAULT_TOOL_TIMEOUT_MS, Math.min(asked, MAX_TOOL_RUN_MS) + TOOL_TIMEOUT_SLACK_MS);
}

/** Longest delay the settings page accepts, in seconds. */
export const MAX_SEND_DELAY_S = 300;

/** Seconds typed in the settings page -> milliseconds; anything invalid is 0 (no delay). */
export function sendDelayMs(seconds: unknown): number {
  const value = typeof seconds === 'string' ? Number(seconds.trim() || NaN) : Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(Math.min(value, MAX_SEND_DELAY_S) * 1000);
}

/** Times a message is typed before the panel gives up and asks the user. */
export const SEND_ATTEMPTS = 3;
const RETRY_BASE_MS = 5_000;

/**
 * Wait before retry number `attempt` (1-based) after the chat page refused a
 * message, typically a provider rate limit. Grows linearly and never undercuts
 * the user's configured delay.
 */
export function retryBackoffMs(attempt: number, delayMs: number): number {
  return Math.max(delayMs, RETRY_BASE_MS) * Math.max(1, attempt);
}

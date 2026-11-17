// Parse one assistant reply into: a tool command, a final answer, or a format error.
// Pure functions (no DOM, no chrome.*) so they are unit-tested with node:test.

export interface ReplyInput {
  text: string;
  /** Code-block contents as extracted from the rendered DOM (fences are lost in innerText). */
  codeBlocks: string[];
}

export type ParsedReply =
  | { kind: 'command'; command: string; params: Record<string, unknown> }
  | { kind: 'final'; text: string }
  | { kind: 'error'; reason: string };

export const COMMAND_FORMAT = '```json\n{"command":"fs.readFile","params":{"path":"README.md"}}\n```';

function asCommand(value: unknown): { command: string; params: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.command === 'string' ? obj.command : typeof obj.tool === 'string' ? obj.tool : null;
  if (!name) return null;
  const rawParams = obj.params ?? obj.arguments ?? {};
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) return null;
  return { command: name.trim(), params: rawParams as Record<string, unknown> };
}

function tryJson(text: string): unknown {
  try { return JSON.parse(text.trim()); } catch { return undefined; }
}

/** Candidate JSON snippets: DOM code blocks, fenced blocks in the text, then the whole text. */
function candidates(reply: ReplyInput): string[] {
  const out = reply.codeBlocks.map((block) => block.trim()).filter((block) => block !== '');
  const fence = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(reply.text)) !== null) {
    const body = match[1].trim();
    if (body !== '' && !out.includes(body)) out.push(body);
  }
  const whole = reply.text.trim();
  if (out.length === 0 && whole.startsWith('{') && whole.endsWith('}')) out.push(whole);
  if (out.length === 0) out.push(...bareObjects(reply.text));
  return out;
}

/**
 * JSON objects that fill whole lines of the text, outside any code block. Some
 * pages drop the fence: Gemini sometimes shows its own placeholder line
 * ("[KONTAINER_KODE]json") where the ``` should be and renders no code block.
 */
function bareObjects(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('{')) continue;
    for (let j = i; j < lines.length && j < i + MAX_BARE_LINES; j++) {
      if (!lines[j].trimEnd().endsWith('}')) continue;
      const snippet = lines.slice(i, j + 1).join('\n').trim();
      const parsed = tryJson(snippet);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        found.push(snippet);
        i = j;
        break;
      }
    }
  }
  return found;
}
const MAX_BARE_LINES = 400;

export function parseReply(reply: ReplyInput): ParsedReply {
  const commands: { command: string; params: Record<string, unknown> }[] = [];
  let looksLikeCommand = false;

  for (const snippet of candidates(reply)) {
    const parsed = tryJson(snippet);
    if (parsed === undefined) {
      // Not JSON. Only complain when it was clearly meant to be a command.
      if (/"(command|tool)"\s*:/.test(snippet)) looksLikeCommand = true;
      continue;
    }
    const command = asCommand(parsed);
    if (command) commands.push(command);
    else if (parsed && typeof parsed === 'object' && ('command' in (parsed as object) || 'tool' in (parsed as object))) looksLikeCommand = true;
  }

  if (commands.length > 1) {
    return { kind: 'error', reason: `Found ${commands.length} commands in one reply. Send exactly ONE command per reply and wait for its result.` };
  }
  if (commands.length === 1) return { kind: 'command', ...commands[0] };
  if (looksLikeCommand) {
    return { kind: 'error', reason: 'The command block is not valid JSON or has the wrong shape. "command" must be a string and "params" an object.' };
  }
  if (/<\s*(tool_call|function_calls?|invoke)\b/i.test(reply.text)) {
    return { kind: 'error', reason: 'BroAgentAI cannot read native tool-call markup. Use the fenced JSON command format instead.' };
  }
  return { kind: 'final', text: reply.text.trim() };
}

/** First line of every tool result the agent types into the chat. */
export const TOOL_RESULT_TAG = '[BroAgentAI tool result]';
/** First token of every other note the agent types into the chat (format corrections). */
export const NOTE_TAG = '[BroAgentAI]';
/** Heading of the operating prompt (built by the bridge, agent.ts buildPrompt). */
export const PROMPT_HEADING = 'BroAgentAI operating instructions';

/** Message sent back to the chat after a tool ran or was refused. */
export function formatToolResult(command: string, ok: boolean, body: string, truncated = false): string {
  return `${TOOL_RESULT_TAG} ${command} ${ok ? 'OK' : 'ERROR'}\n\n${body}${truncated ? '\n\n[result truncated]' : ''}`;
}

/** Message sent when a reply could not be parsed. */
export function formatCorrection(reason: string): string {
  return `${NOTE_TAG} ${reason}\nExpected format (one block per reply):\n${COMMAND_FORMAT}\nWhen you are done, answer in plain prose without a JSON block.`;
}

export type AgentMessage =
  | { kind: 'prompt' }
  | { kind: 'result'; command: string; ok: boolean }
  | { kind: 'note' };

/**
 * Was this chat text typed by the agent rather than the user? Recognizes the
 * operating prompt (raw "# ..." or rendered as a heading), tool results and
 * format corrections by their fixed first line. Used to restyle those messages
 * on the chat page so they do not look like the user's own.
 */
export function agentMessageKind(text: string): AgentMessage | null {
  const head = text.trimStart();
  if (head.replace(/^#+\s*/, '').startsWith(PROMPT_HEADING)) return { kind: 'prompt' };
  if (head.startsWith(TOOL_RESULT_TAG)) {
    const m = /^(\S+)\s+(OK|ERROR)\b/.exec(head.slice(TOOL_RESULT_TAG.length).trimStart());
    return m ? { kind: 'result', command: m[1], ok: m[2] === 'OK' } : null;
  }
  if (head.startsWith(NOTE_TAG + ' ')) return { kind: 'note' };
  return null;
}

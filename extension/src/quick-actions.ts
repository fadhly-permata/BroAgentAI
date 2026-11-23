import { redactSecrets } from './agent-parser.ts';

export type QuickActionId = 'summarizeWorkspace' | 'runTests' | 'explainDiff' | 'fixLint';

export interface QuickAction {
  id: QuickActionId;
  labelKey: string;
  promptKey: string;
  toolHint: string;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: 'summarizeWorkspace', labelKey: 'quickActionSummarize', promptKey: 'quickActionSummarizePrompt', toolHint: 'fs.listTree, git.status, context.read' },
  { id: 'runTests', labelKey: 'quickActionRunTests', promptKey: 'quickActionRunTestsPrompt', toolHint: 'shell.run' },
  { id: 'explainDiff', labelKey: 'quickActionExplainDiff', promptKey: 'quickActionExplainDiffPrompt', toolHint: 'git.status, git.diff' },
  { id: 'fixLint', labelKey: 'quickActionFixLint', promptKey: 'quickActionFixLintPrompt', toolHint: 'shell.run, fs.readFile, fs.writeFile' },
];

export const MAX_QUICK_PROMPT_CHARS = 2000;

export function isQuickActionId(value: unknown): value is QuickActionId {
  return QUICK_ACTIONS.some((action) => action.id === value);
}

function clean(value: string, max: number): string {
  const body = redactSecrets(value).trim();
  return cap(body, max);
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function buildQuickActionPrompt(
  id: QuickActionId,
  translate: (key: string) => string = (key) => key,
  workspace?: string,
): string | null {
  const action = QUICK_ACTIONS.find((item) => item.id === id);
  if (!action) return null;
  const parts = [
    clean(translate('quickActionInstruction'), 700),
    clean(translate(action.promptKey), 700),
  ];
  if (typeof workspace === 'string' && workspace.trim()) {
    parts.push(cap(clean(translate('quickActionWorkspace'), 700).replace('{0}', clean(workspace, 200)), 700));
  }
  parts.push('Tools: ' + action.toolHint);
  return cap(parts.filter(Boolean).join('\n\n'), MAX_QUICK_PROMPT_CHARS);
}

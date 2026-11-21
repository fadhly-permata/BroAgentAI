// VS Code Dark+ / Light+ theme + language mapping for CodeMirror 6.
// Colors are vscode.css tokens (var(--syn-*), var(--editor-*)), so the editor
// follows the panel's data-theme without rebuilding the view.
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, LanguageSupport, type Language } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { shell } from '@codemirror/legacy-modes/mode/shell';

type Lang = LanguageSupport | StreamLanguage<unknown>;

function resolve(path: string): Lang | null {
  const name = (path.split(/[\\/]/).pop() || '').toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return StreamLanguage.define(shell);
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return javascript();
    case 'jsx': return javascript({ jsx: true });
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'html': case 'htm': return html();
    case 'css': case 'scss': case 'less': return css();
    case 'json': case 'jsonc': return json();
    case 'md': case 'markdown': return markdown();
    case 'py': case 'pyw': return python();
    case 'go': return go();
    case 'yml': case 'yaml': return yaml();
    case 'sql': return sql();
    case 'cs': return StreamLanguage.define(csharp);
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    default: return null;
  }
}

/** Language extension for a file path ([] when unknown). */
export function languageFor(path: string): Extension {
  return resolve(path) ?? [];
}

/** Parsed Language (for highlightToHtml); null when unknown. */
export function languageObjectFor(path: string): Language | null {
  const l = resolve(path);
  if (!l) return null;
  return l instanceof LanguageSupport ? l.language : (l as Language);
}

const C = {
  keyword: 'var(--syn-keyword)', control: 'var(--syn-control)', string: 'var(--syn-string)', comment: 'var(--syn-comment)',
  fn: 'var(--syn-fn)', type: 'var(--syn-type)', number: 'var(--syn-number)', variable: 'var(--syn-variable)',
  regexp: 'var(--syn-regexp)', plain: 'var(--syn-plain)',
};

export const vscodeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.definitionKeyword, t.self], color: C.keyword },
  { tag: [t.controlKeyword, t.moduleKeyword], color: C.control },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], color: C.string },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: C.comment, fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: C.fn },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: C.type },
  { tag: [t.number, t.integer, t.float], color: C.number },
  { tag: [t.bool, t.null, t.atom, t.constant(t.variableName)], color: C.keyword },
  { tag: [t.variableName, t.propertyName, t.labelName, t.definition(t.variableName), t.special(t.variableName)], color: C.variable },
  { tag: [t.regexp, t.escape], color: C.regexp },
  { tag: t.tagName, color: C.keyword },
  { tag: [t.attributeName], color: C.variable },
  { tag: t.angleBracket, color: 'var(--syn-punct)' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: C.keyword, fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--link)', textDecoration: 'underline' },
  { tag: t.quote, color: C.comment },
  { tag: t.meta, color: C.keyword },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.brace, t.paren, t.squareBracket, t.derefOperator], color: C.plain },
  { tag: t.invalid, color: 'var(--syn-invalid)' },
]);

export const vscodeTheme: Extension = [
  EditorView.theme({
    '&': { backgroundColor: 'var(--bg-editor)', color: 'var(--editor-fg)', height: '100%' },
    '.cm-content': { caretColor: 'var(--editor-cursor)', fontFamily: 'var(--font-mono)', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '13px', overflow: 'auto' },
    '&.cm-focused .cm-cursor, .cm-cursor': { borderLeftColor: 'var(--editor-cursor)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { backgroundColor: 'var(--bg-editor)', color: 'var(--editor-gutter-fg)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--editor-line)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--editor-gutter-active)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--selection)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--selection) 60%, transparent)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--editor-bracket)', outline: '1px solid var(--border-strong)' },
    '.cm-searchMatch': { backgroundColor: 'var(--match-bg)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--editor-find)' },
    '.cm-panels': { backgroundColor: 'var(--bg-widget)', color: 'var(--text)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-widget)', border: '1px solid var(--border-widget)', color: 'var(--text)' },
  }),
  syntaxHighlighting(vscodeHighlight),
];

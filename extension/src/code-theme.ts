// VS Code Dark Modern / Dark+ theme + language mapping for CodeMirror 6.
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
  keyword: '#569cd6', control: '#c586c0', string: '#ce9178', comment: '#6a9955', fn: '#dcdcaa',
  type: '#4ec9b0', number: '#b5cea8', variable: '#9cdcfe', regexp: '#d16969', plain: '#d4d4d4',
};

export const darkModernHighlight = HighlightStyle.define([
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
  { tag: t.angleBracket, color: '#808080' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: C.keyword, fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: '#3794ff', textDecoration: 'underline' },
  { tag: t.quote, color: C.comment },
  { tag: t.meta, color: C.keyword },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.brace, t.paren, t.squareBracket, t.derefOperator], color: C.plain },
  { tag: t.invalid, color: '#f44747' },
]);

export const darkModernTheme: Extension = [
  EditorView.theme({
    '&': { backgroundColor: '#1f1f1f', color: '#cccccc', height: '100%' },
    '.cm-content': { caretColor: '#aeafad', fontFamily: "Consolas, 'Courier New', monospace", fontSize: '13px' },
    '.cm-scroller': { fontFamily: "Consolas, 'Courier New', monospace", fontSize: '13px', overflow: 'auto' },
    '&.cm-focused .cm-cursor, .cm-cursor': { borderLeftColor: '#aeafad' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { backgroundColor: '#1f1f1f', color: '#6e7681', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#cccccc' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#264f78' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(38,79,120,0.5)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(0,100,0,0.4)', outline: '1px solid #888' },
    '.cm-searchMatch': { backgroundColor: '#613214' },
    '.cm-panels': { backgroundColor: '#252526', color: '#cccccc' },
    '.cm-tooltip': { backgroundColor: '#252526', border: '1px solid #454545' },
  }, { dark: true }),
  syntaxHighlighting(darkModernHighlight),
];

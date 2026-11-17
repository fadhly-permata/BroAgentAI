// Compact embeddable CodeMirror view + static highlighter (VS Code Dark Modern palette).
//
// createCodeView(parent, { path, content, readOnly?, onChange?, onSave?, tabSize?, wrap?, fontSize? })
//   -> { getValue, setValue, destroy, focus, gotoLine }
// highlightToHtml(code, path) -> escaped HTML with <span class="tok-..."> (styles in code-view.css)
import './code-view.css';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, indentUnit } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { darkModernTheme, languageFor, languageObjectFor } from './code-theme.js';

export interface CodeViewOptions {
  path: string;
  content: string;
  readOnly?: boolean;
  onChange?: (doc: string) => void;
  onSave?: () => void;
  tabSize?: number;
  wrap?: boolean;
  fontSize?: number;
}

export interface CodeView {
  getValue(): string;
  setValue(text: string): void;
  destroy(): void;
  focus(): void;
  gotoLine(n: number): void;
}

export function createCodeView(parent: HTMLElement, opts: CodeViewOptions): CodeView {
  let silent = false;
  const tab = opts.tabSize ?? 2;
  const extensions = [
    lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
    history(), bracketMatching(), highlightSelectionMatches(),
    EditorState.tabSize.of(tab), indentUnit.of(' '.repeat(tab)),
    EditorState.readOnly.of(!!opts.readOnly),
    darkModernTheme,
    languageFor(opts.path),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave?.(); return true; } },
      ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab,
    ]),
    EditorView.updateListener.of((u) => { if (u.docChanged && !silent) opts.onChange?.(u.state.doc.toString()); }),
    opts.fontSize ? EditorView.theme({ '.cm-content, .cm-scroller': { fontSize: `${opts.fontSize}px` } }) : [],
    opts.wrap ? EditorView.lineWrapping : [],
  ];
  const view = new EditorView({ state: EditorState.create({ doc: opts.content, extensions }), parent });
  view.dom.classList.add('bro-code-view');
  return {
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      silent = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); } finally { silent = false; }
    },
    destroy: () => view.destroy(),
    focus: () => view.focus(),
    gotoLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    },
  };
}

const classHighlighter = tagHighlighter([
  { tag: [t.controlKeyword, t.moduleKeyword], class: 'tok-ctl' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.definitionKeyword, t.self, t.bool, t.null, t.atom], class: 'tok-kw' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], class: 'tok-str' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote], class: 'tok-com' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'tok-fn' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
  { tag: [t.number, t.integer, t.float], class: 'tok-num' },
  { tag: [t.regexp, t.escape], class: 'tok-re' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName], class: 'tok-var' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: 'tok-head' },
  { tag: [t.link, t.url], class: 'tok-link' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], class: 'tok-op' },
]);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escaped HTML with <span class="tok-*"> wrappers; plain escaped text for unknown languages. */
export function highlightToHtml(code: string, path: string): string {
  const lang = languageObjectFor(path);
  if (!lang) return esc(code);
  let out = '';
  let pos = 0;
  try {
    const tree = lang.parser.parse(code);
    highlightTree(tree, classHighlighter, (from, to, cls) => {
      if (from > pos) out += esc(code.slice(pos, from));
      out += `<span class="${cls}">${esc(code.slice(from, to))}</span>`;
      pos = to;
    });
  } catch {
    return esc(code);
  }
  return out + esc(code.slice(pos));
}

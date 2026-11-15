/** CodeMirror look shared by the script editor and the visual script code view. */
import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const editorTheme = EditorView.theme(
  {
    '&': { color: '#e3e6ec', backgroundColor: '#11141a' },
    '.cm-content': { caretColor: '#4f8cff', paddingBottom: '40vh' },
    '.cm-cursor': { borderLeftColor: '#4f8cff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(79,140,255,0.28) !important' },
    '.cm-gutters': { backgroundColor: '#11141a', color: '#5b6372', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8b93a4' },
    '.cm-tooltip': { backgroundColor: '#1c212b', border: '1px solid #2a303c', color: '#e3e6ec' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(79,140,255,0.3)' },
    '.cm-completionDetail': { color: '#8b93a4', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-panels': { backgroundColor: '#161a22', color: '#e3e6ec' },
  },
  { dark: true },
);

export const editorHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#c792ea' },
  { tag: [t.typeName, t.className], color: '#ffcb6b' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.null], color: '#f78c6c' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#5f6b80', fontStyle: 'italic' },
  { tag: [t.propertyName], color: '#b2ccd6' },
  { tag: [t.definition(t.variableName)], color: '#e3e6ec' },
  { tag: [t.operator, t.punctuation], color: '#89ddff' },
]);

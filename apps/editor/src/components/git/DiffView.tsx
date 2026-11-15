/** A compact line diff of a project file against GitHub's version at the last synced commit. */
import { useEffect, useMemo, useState } from 'react';
import { diffHunks, localText } from '@gs/git';
import { useEditor } from '@editor/store/editor';
import { baseVersion } from '@editor/git/ops';
import { cx } from '../ui/primitives';
import { errMsg } from './common';

type Line = { kind: ' ' | '+' | '-' | '…'; text: string };

/** Unified diff lines with a little context around each change. */
export function diffLines(before: string, after: string, context = 2): Line[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const hunks = diffHunks(a, b);
  const out: Line[] = [];
  let pos = 0;
  for (const h of hunks) {
    const from = Math.max(pos, h.baseStart - context);
    if (from > pos) out.push({ kind: '…', text: '' });
    for (let i = from; i < h.baseStart; i++) out.push({ kind: ' ', text: a[i] });
    for (let i = h.baseStart; i < h.baseEnd; i++) out.push({ kind: '-', text: a[i] });
    for (const l of h.lines) out.push({ kind: '+', text: l });
    const to = Math.min(a.length, h.baseEnd + context);
    for (let i = h.baseEnd; i < to; i++) out.push({ kind: ' ', text: a[i] });
    pos = to;
  }
  if (pos < a.length && hunks.length) out.push({ kind: '…', text: '' });
  return out;
}

export function DiffView({ path }: { path: string }) {
  const project = useEditor((s) => s.project);
  const [base, setBase] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    baseVersion(path).then(setBase, (e) => setError(errMsg(e)));
  }, [path]);
  const mine = project ? localText(project, path) : null;
  const lines = useMemo(() => (base === undefined ? [] : diffLines(base ?? '', mine ?? '')), [base, mine]);
  if (error) return <div className="px-3 py-2 text-err">{error}</div>;
  if (base === undefined) return <div className="px-3 py-2 text-muted">Loading GitHub's version…</div>;
  if (mine === null && base === null) return <div className="px-3 py-2 text-muted">No text to compare (an asset).</div>;
  return (
    <pre className="max-h-72 overflow-auto bg-bg py-1 font-mono text-[11px] leading-[1.45]" data-testid="diff-view">
      {lines.map((l, i) => (
        <div key={i} className={cx('whitespace-pre px-2', l.kind === '+' && 'bg-ok/10 text-ok', l.kind === '-' && 'bg-err/10 text-err', l.kind === '…' && 'text-faint')}>
          {l.kind === '…' ? '⋯' : `${l.kind} ${l.text}`}
        </div>
      ))}
      {!lines.length && <div className="px-2 text-muted">Same text as on GitHub (only the asset hash bookkeeping differs).</div>}
    </pre>
  );
}

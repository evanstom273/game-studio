/** Project problems (broken references, configuration warnings) and script errors, with links. */
import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { projectDiagnostics, type Diagnostic } from '@gs/project';
import { useEditor } from '@editor/store/editor';
import { useConsole } from '@editor/store/console';
import { cx } from '../ui/primitives';

export function ProblemsView() {
  const project = useEditor((s) => s.project);
  const scriptDiags = useConsole((s) => s.scriptDiagnostics);
  const diags = useMemo<Diagnostic[]>(() => (project ? [...Object.values(scriptDiags).flat(), ...projectDiagnostics(project)] : []), [project, scriptDiags]);
  const go = (d: Diagnostic) => {
    const s = useEditor.getState();
    if (!d.file) return;
    if (project?.scenes[d.file]) {
      s.openDoc({ kind: 'scene', path: d.file });
      if (d.nodeId) s.select([d.nodeId]);
    } else if (project?.scripts[d.file] !== undefined) s.openDoc({ kind: 'script', path: d.file });
  };
  if (!diags.length)
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted" data-testid="problems">
        <CheckCircle2 size={14} className="text-ok" /> No problems found.
      </div>
    );
  return (
    <div className="h-full overflow-auto text-[12px]" data-testid="problems">
      {diags.map((d, i) => (
        <button key={i} onClick={() => go(d)} className="flex w-full items-start gap-2 border-b border-border/40 px-2 py-1 text-left hover:bg-panel-2">
          {d.severity === 'error' ? <XCircle size={13} className="mt-0.5 shrink-0 text-err" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />}
          <span className={cx('min-w-0 flex-1', d.severity === 'error' ? 'text-text' : 'text-muted')}>{d.message}</span>
          {d.file && (
            <span className="shrink-0 font-mono text-[11px] text-faint">
              {d.file}
              {d.line ? `:${d.line}` : ''}
              {d.nodePath && d.nodePath !== '.' ? ` · ${d.nodePath}` : ''}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

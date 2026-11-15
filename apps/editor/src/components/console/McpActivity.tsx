import { useBridge } from '@editor/bridge/client';
import { useUi } from '@editor/store/ui';

export function McpActivity() {
  const log = useBridge((s) => s.log);
  const status = useBridge((s) => s.statusText);
  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2 text-[11px] text-muted">
        <span>{status}</span>
        <button className="text-accent hover:underline" onClick={() => useUi.getState().set({ dialog: 'mcp' })}>
          Settings
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px]">
        {log.length === 0 && <div className="p-2 text-faint">Tool calls from AI assistants appear here.</div>}
        {[...log].reverse().map((e, i) => (
          <div key={i} className="flex gap-2 border-b border-border/40 px-2 py-0.5">
            <span className="text-faint">{new Date(e.at).toLocaleTimeString()}</span>
            <span className={e.ok ? 'text-ok' : 'text-err'}>{e.method}</span>
            <span className="text-faint">{e.ms} ms</span>
            <span className="truncate text-muted">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

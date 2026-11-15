/** Console, Problems and AI activity. */
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useUi, type BottomTab } from '@editor/store/ui';
import { useConsole } from '@editor/store/console';
import { useBridge } from '@editor/bridge/client';
import { IconButton, cx } from '../ui/primitives';
import { ConsoleView } from '../console/ConsoleView';
import { ProblemsView } from '../console/ProblemsView';
import { McpActivity } from '../console/McpActivity';

export function BottomPanel({ collapsed }: { collapsed?: boolean }) {
  const tab = useUi((s) => s.bottomTab);
  const open = useUi((s) => s.bottomOpen);
  const set = useUi((s) => s.set);
  const errors = useConsole((s) => s.entries.filter((e) => e.level === 'error').length);
  const aiCalls = useBridge((s) => s.log.length);
  const tabs: [BottomTab, string, number][] = [
    ['console', 'Console', errors],
    ['problems', 'Problems', 0],
    ['mcp', 'AI activity', aiCalls],
  ];
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center border-b border-border" role="tablist">
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id && open}
            onClick={() => set({ bottomTab: id, bottomOpen: true })}
            className={cx('touch-target flex h-full items-center gap-1.5 border-b-2 px-3 text-[12px]', tab === id && open ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}
            data-testid={`bottom-tab-${id}`}
          >
            {label}
            {count > 0 && <span className={cx('rounded-full px-1.5 text-[10px]', id === 'console' ? 'bg-err/20 text-err' : 'bg-panel-3 text-muted')}>{count}</span>}
          </button>
        ))}
        <div className="flex-1" />
        <IconButton label={open ? 'Hide panel' : 'Show panel'} onClick={() => set({ bottomOpen: !open })}>
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </IconButton>
      </div>
      {!collapsed && open && <div className="min-h-0 flex-1">{tab === 'console' ? <ConsoleView /> : tab === 'problems' ? <ProblemsView /> : <McpActivity />}</div>}
    </div>
  );
}

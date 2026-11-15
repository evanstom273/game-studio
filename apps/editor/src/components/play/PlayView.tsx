/** The running game: a sandboxed iframe with the shared runtime (see play/player-host.ts). */
import { useEffect, useRef } from 'react';
import { Bug, Maximize2, Square } from 'lucide-react';
import { attachFrame, stopGame, usePlay } from '@editor/play/player-host';
import { Button, IconButton } from '../ui/primitives';

export function PlayView() {
  const run = usePlay((s) => s.run);
  const status = usePlay((s) => s.status);
  const error = usePlay((s) => s.error);
  const scene = usePlay((s) => s.scene);
  const fps = usePlay((s) => s.fps);
  const debugShapes = usePlay((s) => s.debugShapes);
  const compiled = usePlay((s) => s.compiled);
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    attachFrame(ref.current);
    return () => attachFrame(null);
  }, [run, compiled]);
  return (
    <div className="flex h-full flex-col bg-black" data-testid="play-view" data-status={status}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 text-[12px]">
        <span className={status === 'failed' ? 'text-err' : 'text-ok'}>{status === 'starting' ? 'Starting…' : status === 'failed' ? 'Failed' : status === 'paused' ? 'Paused' : 'Running'}</span>
        <span className="truncate text-muted">{scene}</span>
        {status === 'running' && <span className="text-faint">{fps} fps</span>}
        <div className="flex-1" />
        <IconButton label="Show collision shapes (next run)" active={debugShapes} onClick={() => usePlay.setState({ debugShapes: !debugShapes })}>
          <Bug size={14} />
        </IconButton>
        <IconButton label="Fullscreen" onClick={() => void ref.current?.requestFullscreen?.()}>
          <Maximize2 size={14} />
        </IconButton>
        <Button variant="ghost" onClick={stopGame} data-testid="stop-game">
          <Square size={13} className="text-err" /> Stop
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {status === 'failed' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="max-w-lg whitespace-pre-wrap text-[13px] text-err" data-testid="play-error">
              {error}
            </div>
            <div className="text-[12px] text-muted">Details are in the Console.</div>
            <Button onClick={stopGame}>Back to the editor</Button>
          </div>
        ) : !compiled ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted">Compiling scripts…</div>
        ) : (
          <iframe key={run} ref={ref} title="Game" src="/player.html" sandbox="allow-scripts allow-pointer-lock" allow="autoplay; fullscreen; gamepad" className="absolute inset-0 h-full w-full border-0" data-testid="player-frame" />
        )}
      </div>
    </div>
  );
}

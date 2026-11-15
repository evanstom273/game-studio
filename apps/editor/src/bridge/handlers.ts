/**
 * Requests from the cloud for things only a browser can do: run the game, read its console,
 * build an export, ask the user to confirm. Everything else an AI assistant does is handled by the
 * cloud copy of the project (packages/mcp/src/cloud), with no editor needed.
 */
import { GameStudioError, errorMessage } from '@gs/shared';
import type { LogEntry } from '@gs/core';
import type { EditorRequest } from '@gs/mcp';
import { useEditor } from '@editor/store/editor';
import { useConsole } from '@editor/store/console';
import { usePlay, stopGame } from '@editor/play/player-host';
import { exportArchiveFile, exportWeb, openProjectById, runScene } from '@editor/services/editor-service';
import { confirmDialog } from '@editor/components/ui/feedback';
import { deployOpen } from '@editor/git/deploy';
import type { CloudSync } from './sync';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function consoleEntries(entries: { level: LogEntry['level']; message: string; source?: string; origin: string; repeat: number }[]) {
  return entries.map((e) => ({ level: e.level, from: e.origin, message: e.message, ...(e.source ? { at: e.source } : {}), ...(e.repeat > 1 ? { repeated: e.repeat } : {}) }));
}

/** Brings the project the AI is working on up to date and opens it. */
async function prepare(sync: CloudSync | null, params: Record<string, unknown>) {
  const id = str(params.project);
  const revision = str(params.revision);
  if (!id) return;
  if (sync && revision) await sync.ensure(id, revision);
  if (useEditor.getState().project?.id !== id) await openProjectById(id);
}

export async function handleEditorRequest(method: EditorRequest, params: Record<string, unknown>, sync: CloudSync | null): Promise<unknown> {
  switch (method) {
    case 'confirm':
      return confirmDialog({ title: str(params.title) ?? 'Confirm', message: str(params.message) ?? '', confirm: 'Allow', danger: true });
    case 'run_scene': {
      await prepare(sync, params);
      const seconds = Math.min(30, Math.max(0.5, Number(params.seconds ?? 3)));
      const before = useConsole.getState().entries.at(-1)?.id ?? 0;
      let started = true;
      let scene = '';
      let startError: string | undefined;
      try {
        scene = await runScene(str(params.scene));
        await wait(seconds * 1000);
      } catch (e) {
        started = false;
        startError = errorMessage(e);
      }
      const play = usePlay.getState();
      const entries = useConsole.getState().entries.filter((e) => e.id > before);
      const result = {
        scene,
        started,
        ...(startError ? { error: startError } : {}),
        status: play.status,
        ranFor: started ? `${seconds}s` : undefined,
        fps: play.fps,
        nodes: play.nodes,
        errors: entries.filter((e) => e.level === 'error').length,
        console: consoleEntries(entries.slice(-150)),
        note: document.hidden ? 'The editor tab is in the background, so the browser may have slowed the game down.' : undefined,
      };
      if (params.keepRunning !== true) stopGame();
      return result;
    }
    case 'stop_game':
      stopGame();
      return { stopped: true };
    case 'get_console': {
      const level = str(params.level);
      const limit = Number(params.limit ?? 100);
      return { entries: consoleEntries(useConsole.getState().entries.filter((e) => !level || e.level === level).slice(-limit)) };
    }
    case 'export_project':
      await prepare(sync, params);
      return (str(params.format) ?? 'web') === 'archive' ? exportArchiveFile() : exportWeb();
    case 'git_deploy':
      // Building the web export needs a browser; the cloud asks the open editor (see cloud/git.ts).
      await prepare(sync, params);
      return deployOpen(params.target === 'cloudflare' ? 'cloudflare' : 'github-pages', { branch: str(params.branch), workerName: str(params.worker_name) });
    default:
      throw new GameStudioError('E_UNKNOWN_METHOD', `The editor doesn't handle "${String(method)}"`);
  }
}

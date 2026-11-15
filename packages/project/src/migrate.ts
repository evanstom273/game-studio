/**
 * Loading stored/imported projects: migrate forward, then validate.
 *
 * Rules (same as GUI Studio / Coding Studio): migrations only go forward, never edit an old
 * step, and a document from a newer version of the editor is refused rather than guessed at.
 */
import { GameStudioError, isPlainObject } from '@gs/shared';
import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION, ProjectDocSchema, type ProjectDoc } from './schema';
import { validateProjectReferences } from './validate';

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** MIGRATIONS[n] upgrades a version-n document to n+1. */
const MIGRATIONS: Record<number, Migration> = {};

export interface LoadedProject {
  doc: ProjectDoc;
  migratedFrom?: number;
  /** Problems that were repaired or that need the user's attention. */
  issues: string[];
}

export function loadProjectDoc(raw: unknown): LoadedProject {
  if (!isPlainObject(raw) || raw.format !== PROJECT_FORMAT) throw new GameStudioError('E_BAD_PROJECT', 'This is not a Game Studio project');
  const version = raw.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new GameStudioError('E_BAD_PROJECT', 'The project has no valid format version');
  if (version > PROJECT_FORMAT_VERSION) throw new GameStudioError('E_NEWER_FORMAT', `This project was saved by a newer version of Game Studio (format ${version}; this editor reads up to ${PROJECT_FORMAT_VERSION}). Update the editor to open it.`);
  let doc: Record<string, unknown> = structuredClone(raw);
  for (let v = version; v < PROJECT_FORMAT_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new GameStudioError('E_BAD_PROJECT', `No migration from format ${v}`);
    doc = { ...step(doc), formatVersion: v + 1 };
  }
  const parsed = ProjectDocSchema.safeParse(doc);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new GameStudioError('E_BAD_PROJECT', `The project file is damaged: ${first.path.join('.') || '(root)'}: ${first.message}`, parsed.error.issues.slice(0, 10));
  }
  const project = parsed.data as unknown as ProjectDoc;
  const issues = validateProjectReferences(project);
  return { doc: project, ...(version !== PROJECT_FORMAT_VERSION ? { migratedFrom: version } : {}), issues };
}

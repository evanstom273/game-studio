import { lazy, Suspense, useEffect, useRef } from 'react';
import { useRoute } from './lib/router';
import { observeLayoutRoot } from './lib/layout';
import { Dashboard } from './components/dashboard/Dashboard';
import { ConfirmHost, Toasts } from './components/ui/feedback';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { startAutosave } from './services/autosave';

const EditorShell = lazy(() => import('./components/shell/EditorShell'));

export function App() {
  const route = useRoute();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => observeLayoutRoot(root.current), []);
  useEffect(() => startAutosave(), []);
  return (
    <div ref={root} className="h-full w-full">
      <ErrorBoundary label="Game Studio">
        {route.name === 'project' ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">Loading editor…</div>}>
            <EditorShell projectId={route.id} />
          </Suspense>
        ) : (
          <Dashboard />
        )}
      </ErrorBoundary>
      <ConfirmHost />
      <Toasts />
    </div>
  );
}

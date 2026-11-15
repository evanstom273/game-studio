/** Hash routing: #/ (projects) and #/project/<id>. Works on static hosting and offline. */
import { useSyncExternalStore } from 'react';

export type Route = { name: 'dashboard' } | { name: 'project'; id: string };

function parse(hash: string): Route {
  const m = /^#\/project\/([A-Za-z0-9_-]+)/.exec(hash);
  return m ? { name: 'project', id: m[1] } : { name: 'dashboard' };
}

let current = parse(location.hash);
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse(location.hash);
  for (const l of listeners) l();
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function navigate(route: Route) {
  location.hash = route.name === 'project' ? `#/project/${route.id}` : '#/';
}

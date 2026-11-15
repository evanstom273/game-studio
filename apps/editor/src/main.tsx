import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { registerSW } from 'virtual:pwa-register';
import { initBridge } from './bridge/client';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
initBridge();

// Offline support without stale code: when a new version is deployed, the new service worker
// takes over and the page reloads itself once (it also checks for updates every 10 minutes).
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration) setInterval(() => void registration.update(), 10 * 60 * 1000);
  },
});

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './global.css';

createRoot(document.getElementById('platter')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline after the first visit — on a real HTTPS host only: not in
// development (stale caches), and not inside a sandboxed viewer.
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol === 'https:' && !('claude' in window)) {
  void navigator.serviceWorker.register('./sw.js').catch(() => {});
}

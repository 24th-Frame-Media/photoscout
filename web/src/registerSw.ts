/**
 * Install the service worker (public/sw.js) that lets the installed app open
 * offline. Production builds only: in development it would keep serving an
 * old build over Vite's live one.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* no worker, no offline launch; the app is unaffected */ }); });
}

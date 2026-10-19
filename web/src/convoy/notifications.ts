/** Mobile browsers require persistent notifications through a service worker. */
export async function showConvoyNotification(notice: { room: string; text: string }): Promise<boolean> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const options: NotificationOptions = {
    body: notice.text,
    tag: `convoy-${notice.room}`,
    icon: '/icons/icon-192.png',
    data: { url: `/convoy?room=${encodeURIComponent(notice.room)}` },
  };
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.active) { await registration.showNotification('PhotoScout convoy', options); return true; }
    } catch { /* No active worker in development, or delivery is unavailable. */ }
  }
  try {
    const notification = new Notification('PhotoScout convoy', options);
    notification.onclick = () => { window.focus(); notification.close(); };
    setTimeout(() => notification.close(), 10_000);
    return true;
  } catch { return false; }
}

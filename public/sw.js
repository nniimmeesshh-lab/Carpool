// Receives Web Push messages and shows them as system notifications, even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Carpool', {
    body: d.body, tag: d.tag, renotify: !!d.tag,
    icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) =>
    wins.length ? wins[0].focus() : self.clients.openWindow(e.notification.data?.url || '/')));
});

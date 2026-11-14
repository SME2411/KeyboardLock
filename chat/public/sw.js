// Service worker: принимает push и показывает уведомление, даже когда приложение закрыто.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data.json(); } catch { d = { title: 'DuoVerse', body: 'Новое сообщение' }; }
  // iOS требует показывать уведомление на каждый push
  event.waitUntil(self.registration.showNotification(d.title || 'DuoVerse', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
    tag: 'msg-' + (d.from || 'x'), renotify: true, data: { from: d.from },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('/');
  })());
});

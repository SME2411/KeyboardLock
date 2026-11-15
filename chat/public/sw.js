// Service worker: принимает push и показывает уведомление, даже когда приложение закрыто.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data.json(); } catch { d = { title: 'DuoVerse', body: 'Новое сообщение' }; }
  event.waitUntil((async () => {
    // число непрочитанных на значке иконки (iOS 16.4+ и Android поддерживают)
    if (typeof d.badge === 'number') { try { await (d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()); } catch {} }
    // iOS требует показывать уведомление на каждый push
    await self.registration.showNotification(d.title || 'DuoVerse', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
      tag: 'msg-' + (d.from || 'x'), renotify: true, data: { from: d.from },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const from = event.notification.data?.from;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) { const c = all[0]; await c.focus(); if (from) c.postMessage({ type: 'open', from }); return; }
    return self.clients.openWindow(from ? '/?c=' + from : '/');   // приложение было закрыто: откроем сразу нужный чат
  })());
});

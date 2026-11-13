/*
 * Bodhinox service worker: browser push only (no caching, no fetch handler).
 *
 * Pushes carry no payload, so nothing about a conversation passes through the
 * browser vendor's push service. The alert text is the translated label the
 * app passed in this script's URL when it registered (?title=&body=), and a
 * click opens the in-app notification list, which needs a signed-in session.
 */
const params = new URL(self.location.href).searchParams;
const TITLE = (params.get('title') || 'Bodhinox').slice(0, 80);
const BODY = (params.get('body') || '').slice(0, 160);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification(TITLE, {
    body: BODY,
    tag: 'bodhinox-notification',
    renotify: true,
    icon: '/brand/khaga-mark-sun-orange.webp',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL('/notifications', self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ('navigate' in client) await client.navigate(target).catch(() => undefined);
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});

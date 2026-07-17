// sw.js — Service Worker
// Handles Web Push notifications and offline caching
const CACHE_NAME = 'budget-tracker-v19';
const STATIC_ASSETS = ['/', '/app.js', '/style.css', '/manifest.json'];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    fetch(event.request)
    .then((response) => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      return response;
    })
    .catch(() => caches.match(event.request))
  );
});
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'New Transaction';
  const url = data.url || '/?pending=1';
  const options = {
    body: data.body || 'Tap to categorize',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'transaction-' + (data.transactionId || Date.now()),
                      data: { transactionId: data.transactionId, url },
                      actions: [{ action: 'categorize', title: data.actionLabel || 'Categorize Now' }],
                      requireInteraction: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'OPEN_PENDING' });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

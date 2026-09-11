const CACHE = 'survivor-v3';
const SHELL = ['/', '/app.js', '/crowd.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return; // network only
  // Offline: serve the cached response if we have one. Only *navigations* fall back to the app
  // shell — an uncached sub-resource (logo, icon) must fail cleanly, not resolve to index HTML.
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && e.request.method === 'GET') caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request).then((m) => m || (e.request.mode === 'navigate' ? caches.match('/') : new Response('', { status: 504, statusText: 'offline' })))));
});
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Survivor', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Survivor', { body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || 'survivor', data: { url: d.url || '/' }, requireInteraction: true }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => { const c = cs.find((x) => 'focus' in x); return c ? c.focus() : self.clients.openWindow(e.notification.data?.url || '/'); }));
});

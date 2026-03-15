const CACHE_NAME = 'mdr-v135';
const CACHE_URLS = [
  '/icon-192.png',
  '/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('push', e => {
  let data = { title: 'My Daily Reports', body: 'New notification' };
  try { if (e.data) data = e.data.json(); } catch (err) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title || 'My Daily Reports', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
    tag: data.tag || 'mdr-notification', data: data.url || '/', vibrate: [200, 100, 200],
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
    for (const w of wins) { if (w.url.includes('mydailyreports') && 'focus' in w) return w.focus(); }
    return clients.openWindow(url);
  }));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(fetch(e.request).then(resp => { const clone = resp.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)); return resp; }).catch(() => caches.match(e.request)));
    return;
  }
  if (url.hostname.includes('supabase') || url.pathname.startsWith('/functions/')) { e.respondWith(fetch(e.request)); return; }
  e.respondWith(caches.match(e.request).then(cached => {
    if (cached) return cached;
    return fetch(e.request).then(resp => { if (resp.ok) { const clone = resp.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)); } return resp; });
  }));
});

const CACHE_NAME = 'mdr-1774137977';

// Static assets to pre-cache for offline app shell launch
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

// ── Install — pre-cache static assets ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Use Promise.allSettled to cache URLs individually.
        // If any URL fails, continue instead of blocking the install.
        const promises = CACHE_URLS.map(url =>
          cache.add(url).catch(err => {
            console.warn(`[SW] Failed to cache ${url}:`, err.message);
          })
        );
        return Promise.allSettled(promises);
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activate — clean ALL old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Push notifications ──
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

// ── Fetch handler ──
// RULE: Supabase traffic (API, edge functions, storage, auth) is NEVER intercepted.
// iOS Safari strips Authorization headers when a service worker clones cross-origin requests.
// The SW only handles: app shell (HTML), JS/CSS bundles, and static assets (icons, CDN libs).
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Supabase — never touch. Let the browser handle it directly.
  if (url.hostname.includes('supabase')) return;

  // HTML pages — network-first, fall back to cache (offline app launch)
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // App JS/CSS bundles (Vite-hashed) — network-first so deploys take effect immediately
  if (url.pathname.startsWith('/assets/') && /\.(js|css)$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then(cached => cached || new Response('', { status: 503 })))
    );
    return;
  }

  // Static assets (icons, fonts, CDN libs) — cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      });
    })
  );
});

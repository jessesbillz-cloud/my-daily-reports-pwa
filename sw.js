const CACHE_NAME = 'mdr-1774123295';
const API_CACHE = 'mdr-api-v1';
const OFFLINE_QUEUE = 'mdr-offline-queue';

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

// Supabase REST endpoints we want to cache for offline reading
const CACHEABLE_API_PATTERNS = [
  '/rest/v1/jobs',
  '/rest/v1/reports',
  '/rest/v1/profiles',
  '/rest/v1/templates',
  '/rest/v1/saved_templates',
  '/rest/v1/company_templates',
  '/rest/v1/contacts',
  '/rest/v1/inspection_requests'
];

// ── Install ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate — clean old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== API_CACHE).map(k => caches.delete(k)))
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

// ── Helper: is this a cacheable GET API request? ──
function isCacheableAPI(url) {
  if (url.method && url.method !== 'GET') return false;
  const u = typeof url === 'string' ? url : url.url || '';
  return CACHEABLE_API_PATTERNS.some(p => u.includes(p));
}

// ── Helper: is this a write (POST/PATCH/DELETE) to Supabase? ──
function isAPIWrite(request) {
  const method = request.method.toUpperCase();
  return (method === 'POST' || method === 'PATCH' || method === 'DELETE') &&
    (request.url.includes('supabase') || request.url.includes('/rest/v1/'));
}

// ── Offline queue: store failed writes for later replay ──
async function queueOfflineWrite(request) {
  try {
    const body = await request.clone().text();
    const entry = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
      timestamp: Date.now()
    };
    // Store in IndexedDB via a simple key-value approach
    const cache = await caches.open(OFFLINE_QUEUE);
    const queueKey = new Request('/__offline_queue');
    const existing = await cache.match(queueKey);
    let queue = [];
    if (existing) {
      try { queue = await existing.json(); } catch (e) { queue = []; }
    }
    queue.push(entry);
    await cache.put(queueKey, new Response(JSON.stringify(queue), {
      headers: { 'Content-Type': 'application/json' }
    }));
    console.log('[SW] Queued offline write:', request.method, request.url);
  } catch (e) {
    console.error('[SW] Failed to queue offline write:', e);
  }
}

// ── Replay queued writes when back online ──
async function replayOfflineQueue() {
  try {
    const cache = await caches.open(OFFLINE_QUEUE);
    const queueKey = new Request('/__offline_queue');
    const existing = await cache.match(queueKey);
    if (!existing) return;
    const queue = await existing.json();
    if (!queue || queue.length === 0) return;

    console.log('[SW] Replaying', queue.length, 'offline writes');
    const failed = [];
    for (const entry of queue) {
      try {
        const resp = await fetch(entry.url, {
          method: entry.method,
          headers: entry.headers,
          body: entry.method !== 'GET' ? entry.body : undefined
        });
        if (!resp.ok) {
          console.warn('[SW] Replay failed:', resp.status, entry.url);
          failed.push(entry);
        } else {
          console.log('[SW] Replayed:', entry.method, entry.url);
        }
      } catch (e) {
        failed.push(entry); // Still offline for this one
      }
    }
    // Update queue with only failed items
    if (failed.length > 0) {
      await cache.put(queueKey, new Response(JSON.stringify(failed), {
        headers: { 'Content-Type': 'application/json' }
      }));
    } else {
      await cache.delete(queueKey);
    }
    // Notify the app that sync happened
    const allClients = await clients.matchAll({ type: 'window' });
    for (const client of allClients) {
      client.postMessage({ type: 'offline-sync-complete', remaining: failed.length });
    }
  } catch (e) {
    console.error('[SW] Replay error:', e);
  }
}

// ── Fetch handler ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 1. HTML pages — network-first, fall back to cache
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

  // 2. Supabase API writes (POST/PATCH/DELETE) — try network, queue if offline
  if (isAPIWrite(e.request)) {
    e.respondWith(
      fetch(e.request.clone()).catch(async () => {
        await queueOfflineWrite(e.request);
        // Return a fake success so the app doesn't break
        return new Response(JSON.stringify([{ id: 'offline-' + Date.now(), _offline: true }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' }
        });
      })
    );
    return;
  }

  // 3. Supabase API reads (GET) — network-first, cache the response, serve cache if offline
  if (isCacheableAPI(e.request)) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(API_CACHE).then(cache => cache.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then(cached => {
          if (cached) return cached;
          // Return empty array as fallback
          return new Response('[]', {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' }
          });
        }))
    );
    return;
  }

  // 4. App JS/CSS bundles (hashed by Vite) — network-first so deploys take effect immediately
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

  // 5. Other static assets (icons, fonts, CDN libs) — cache-first
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

// ── Sync: replay offline queue when connectivity returns ──
self.addEventListener('message', e => {
  if (e.data === 'replay-offline-queue') {
    replayOfflineQueue();
  }
});

// Background sync (if supported)
self.addEventListener('sync', e => {
  if (e.tag === 'offline-sync') {
    e.waitUntil(replayOfflineQueue());
  }
});

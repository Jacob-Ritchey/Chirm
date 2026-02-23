// sw.js — Chirm Service Worker v4
// Handles: static asset caching and background push notifications.
// CRITICAL: We do NOT cache HTML or intercept navigation requests.
//           This prevents login redirect loops on mobile / self-signed certs.

const SW_VERSION = 'chirm-sw-v5';

// ── Per-user notification preferences ────────────────────────────────────────
// The SW cannot read localStorage, so the main thread sends these via postMessage.
// Keyed by user ID so account-switching on the same browser doesn't bleed over.
let _suppressOsNotifications = false; // mirrors ChirmSettings.inBrowserOnly

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (msg.type === 'set-notification-prefs') {
    // { type, inBrowserOnly: bool }
    _suppressOsNotifications = !!msg.inBrowserOnly;
  }
});

// Only truly-static, content-hashed assets — NO HTML, NO '/' navigation.
const STATIC_ASSETS = [
  '/css/app.css',
  '/js/ws.js',
  '/js/app.js',
  '/js/emoji-data.js',
  '/js/voice.js',
  '/js/cache.js',
  '/js/notifications.js',
  '/js/mentions.js',
  '/js/user-settings.js',
  '/manifest.json',
];

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing', SW_VERSION);
  event.waitUntil(
    caches.open(SW_VERSION).then((cache) =>
      Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] skip cache:', url, err.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SW_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/ws')) return;

  // ── HTML / navigation — ALWAYS network, NEVER serve stale cached HTML ───────
  // Critically: we do NOT provide a .catch() fallback here.
  // If the network fails (including self-signed TLS rejection), the browser
  // handles the error natively — which means it shows its own cert warning page
  // with the "Accept risk and continue" button intact.
  // A custom offline HTML response would replace that native UI and trap the user.
  const isNavigation = event.request.mode === 'navigate';
  const isHtmlPath = ['/', '/login', '/setup'].includes(url.pathname) || url.pathname.endsWith('.html');
  if (isNavigation || isHtmlPath) {
    // Network only — no fallback, no custom error page.
    event.respondWith(fetch(event.request));
    return;
  }

  // ── API / uploads — network only ─────────────────────────────────────────────
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // ── Static assets — cache-first, refresh in background ───────────────────────
  event.respondWith(
    caches.open(SW_VERSION).then(async (cache) => {
      const cached = await cache.match(event.request);
      const networkPromise = fetch(event.request).then(res => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      }).catch(() => null);
      return cached || await networkPromise;
    })
  );
});

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  // Respect the inBrowserOnly preference set from the main thread.
  // This is the only reliable gate for mobile — subscription removal can fail
  // if the browser kills the page mid-flight on a background tab.
  if (_suppressOsNotifications) return;

  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { body: event.data?.text() }; }

  const title = data.title || 'Chirm';
  const options = {
    body: data.body || 'New message',
    icon: '/assets/jenn-circle.png',
    tag: data.tag || `chirm-${data.channel_id || 'msg'}`,
    renotify: true,
    data: { url: '/', channel_id: data.channel_id },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── NOTIFICATION CLICK ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        try {
          if (new URL(client.url).origin === self.location.origin) {
            client.focus();
            client.postMessage({ type: 'notification.clicked', channel_id: event.notification.data?.channel_id });
            return;
          }
        } catch {}
      }
      return self.clients.openWindow('/');
    })
  );
});

// ─── PERIODIC BACKGROUND SYNC ─────────────────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'chirm-check-messages') {
    event.waitUntil(
      fetch('/api/push/poll', { credentials: 'include' })
        .then(r => r.json())
        .then(data => Promise.all((data.notifications || []).map(n =>
          self.registration.showNotification(n.title || 'Chirm', {
            body: n.body,
            icon: '/assets/jenn-circle.png',
            tag: `chirm-poll-${n.channel_id}`,
            data: { url: '/', channel_id: n.channel_id },
          })
        )))
        .catch(() => {})
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

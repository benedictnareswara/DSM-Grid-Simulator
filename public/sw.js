/*
 * DSM Consumer — service worker
 *
 * Exists for two reasons only:
 *   1. Installability. A registered service worker plus app/manifest.ts is
 *      what makes browsers offer "Add to Home Screen".
 *   2. registration.showNotification(). Android Chrome refuses the bare
 *      `new Notification()` constructor, so alerts need this to appear.
 *
 * There is deliberately NO 'push' handler. Push would require VAPID keys and
 * a sender in the FastAPI backend, and would create a second path by which an
 * alert could reach a phone — the ESP32 broker is meant to be the only one.
 * See docs/ARCHITECTURE.md section 4.
 */

const CACHE = "dsm-shell-v1";

// Enough to render the shell offline. Live telemetry needs the WebSocket, so
// an offline launch shows the app frame and an "Offline" badge, nothing more.
const SHELL = ["/consumer", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one 404 does not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/*
 * Network-first for navigations. The dashboard is a live telemetry view, so a
 * stale cached page is worse than a slow one — the cache is a last resort for
 * a cold offline launch. Everything else (API calls, the WebSocket upgrade,
 * Next's own chunks) is left entirely alone.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(request).then((hit) => hit || caches.match("/consumer"))
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes("/consumer") && "focus" in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow("/consumer");
      })
  );
});

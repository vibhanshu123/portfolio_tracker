// Minimal service worker — enables "Add to Home Screen" on Android.
// All requests pass through to the network; no caching (app needs live data).
self.addEventListener('install',  e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',    e => e.respondWith(fetch(e.request)));

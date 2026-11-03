// Minimal service worker: caches the static shell only (hashed build assets + brand icons + the
// manifest). Pages and data always go to the network. No dependencies, no build tooling.
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon.png", "/apple-icon.png", "/favicon.ico"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("tongxing-shell-v1").then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path)))),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== "tongxing-shell-v1").map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    url.pathname.startsWith("/assets/")
      ? caches.match(request).then((hit) => hit || fetch(request))
      : fetch(request).catch(() => caches.match(request)),
  );
});

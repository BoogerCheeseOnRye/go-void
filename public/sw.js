/* GO/VOID service worker — offline shell for local and AI duels. */

const VERSION = 'go-void-v2';
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/manifest.webmanifest',
  '/js/main.js',
  '/js/audio.js',
  '/js/impact.js',
  '/js/net.js',
  '/js/core/go.js',
  '/js/core/ai.js',
  '/js/render/math.js',
  '/js/render/gl.js',
  '/js/render/camera.js',
  '/js/render/shaders.js',
  '/js/render/renderer.js',
  '/js/workers/ai-worker.js',
  '/fonts/chakra-petch-500.woff2',
  '/fonts/chakra-petch-600.woff2',
  '/fonts/chakra-petch-700.woff2',
  '/fonts/space-grotesk-400.woff2',
  '/fonts/space-grotesk-500.woff2',
  '/fonts/space-grotesk-600.woff2',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(SHELL);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/ws' || url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(VERSION);
          cache.put('/index.html', fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cached = await caches.match('/index.html');
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(request, { ignoreSearch: false });
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => null);
      if (cached) {
        network.catch(() => {});
        return cached;
      }
      const fresh = await network;
      return fresh || Response.error();
    })(),
  );
});

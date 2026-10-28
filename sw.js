// Service Worker — кэширует файлы приложения, чтобы оно открывалось мгновенно
// и работало как настоящее приложение на Android.
const CACHE = 'erudit-v5';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/cloud-config.js',
  './js/app.js',
  './data/words.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // words.json проверяем по сети с запасным кэшем — так обновления базы приходят сами
  const url = new URL(e.request.url);
  if (url.pathname.endsWith('words.json')) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => {
      return cached || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

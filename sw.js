/* 앱 셸 캐시. 한 번 열어두면 인터넷 없이도 켜집니다.
   전략은 stale-while-revalidate — 캐시를 즉시 내주고 뒤에서 갱신합니다.
   그래서 새 버전을 올려도 "한 번 더 열면" 반영됩니다. */

const CACHE = 'mdpencil-v5';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './lib/markdown-it.min.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 외부에서 md 를 가져오는 요청은 건드리지 않습니다

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });

    const net = fetch(req)
      .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => null);

    if (hit) return hit;
    const res = await net;
    if (res) return res;
    return (await cache.match('./index.html')) || Response.error();
  })());
});

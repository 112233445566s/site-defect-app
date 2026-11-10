// Offline support: app files are served from cache (refreshed in the background),
// CDN libraries are cached on first use. Bump VERSION when deploying changes.
const VERSION = 'v0.2.1';
const SHELL_CACHE = 'shell-' + VERSION;
const LIB_CACHE = 'libs-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/db.js', './js/util.js', './js/annotate.js', './js/defect.js',
  './js/plan.js', './js/export.js', './js/backup.js', './js/libs.js', './js/types.js', './js/record.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CDN_HOSTS.includes(url.hostname)) {
    // versioned library URLs: cache first
    e.respondWith(caches.open(LIB_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // app shell: stale-while-revalidate (works offline, updates on next launch)
  e.respondWith(caches.open(SHELL_CACHE).then(async (c) => {
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res.ok) c.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (await c.match('./index.html')) || Response.error();
  }));
});

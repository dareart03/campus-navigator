// Service worker: приложение открывается и без сети (C6).
// Стратегия «сначала сеть, при неудаче — кеш»: онлайн всегда свежие файлы (на разработке не мешает правкам),
// офлайн — последняя удачно загруженная копия. Всё, что успешно загрузилось, кладём в кеш по ходу работы,
// а основные файлы кешируем сразу при установке.
const CACHE = 'navigator-v1';
const CORE = [
    './', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
    'data/data.json', 'maps/map1.svg', 'maps/map2.svg', 'maps/map3.svg',
    'src/app.js', 'src/gestures.js', 'src/graph.js', 'src/heap.js', 'src/culling.js', 'src/nav.js', 'src/session.js', 'src/compass.js',
    'src/search.js', 'src/signs.js', 'src/ocr.js', 'src/share.js', 'src/viewmath.js', 'src/vendor/qrcode.js',
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // по одному: если какого-то файла нет, остальные всё равно закешируются
        await Promise.all(CORE.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);   // старые версии кеша
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        try {
            const res = await fetch(req, { cache: 'no-cache' });
            if (res.ok) cache.put(req, res.clone());
            return res;
        } catch {
            // Страницу с параметрами (?from=…&to=…) тоже отдаём из кеша: ищем без строки запроса
            const hit = await cache.match(req, { ignoreSearch: true });
            if (hit) return hit;
            if (req.mode === 'navigate') return (await cache.match('index.html')) ?? Response.error();
            return Response.error();
        }
    })());
});

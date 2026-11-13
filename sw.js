// Service worker: приложение открывается и без сети (C6).
// Стратегия «сначала сеть, при неудаче — кеш»: онлайн всегда свежие файлы (на разработке не мешает правкам),
// офлайн — последняя удачно загруженная копия. Всё, что успешно загрузилось, кладём в кеш по ходу работы,
// а основные файлы кешируем сразу при установке.
// При выпуске новой версии меняйте номер в имени кеша: старый кеш целиком удалится (activate), и страница с кодом не разойдутся по версиям.
const CACHE = 'navigator-v2';
const CORE = [
    './', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
    'data/data.json', 'maps/map1.svg', 'maps/map2.svg', 'maps/map3.svg',
    'src/app.js', 'src/gestures.js', 'src/graph.js', 'src/heap.js', 'src/culling.js', 'src/nav.js', 'src/session.js', 'src/compass.js',
    'src/search.js', 'src/signs.js', 'src/names.js', 'src/ocr.js', 'src/share.js', 'src/viewmath.js', 'src/vendor/qrcode.js',
];

// Страница открывается с разными адресами: «/», «/index.html», «/?from=…&to=…». Хранить её под каждым адресом нельзя:
// онлайн обновлялась бы только та копия, с которой открыли, а офлайн (по ярлыку, без параметров) отдавалась бы
// старая копия рядом с новым app.js, и приложение падало («нет элемента на странице»). Поэтому страница всегда под одним ключом.
const PAGE = new URL('./', self.registration.scope).href;
const keyFor = req => (req.mode === 'navigate' ? PAGE : req);

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
            if (res.ok) cache.put(keyFor(req), res.clone());
            return res;
        } catch {
            const hit = await cache.match(keyFor(req), { ignoreSearch: true });      // файлы с параметрами (?v=…) тоже находим
            return hit ?? Response.error();
        }
    })());
});

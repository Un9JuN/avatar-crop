/* 截图头像工坊 · Service Worker
 * - 离线缓存应用外壳
 * - 处理 Android「分享到应用」传来的截图
 */
'use strict';

const VERSION = '0.9.0';
const SHELL_CACHE = 'avatar-shell-' + VERSION;
const SHARED_CACHE = 'avatar-shared';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './src/auto-crop.js',
  './src/zip.js',
  './src/app.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('avatar-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const file = form.get('image');
    if (!file || typeof file === 'string') {
      return Response.redirect(new URL('./index.html?share=empty', self.registration.scope).href, 303);
    }
    const key = '/__shared__/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const cache = await caches.open(SHARED_CACHE);
    await cache.put(
      new Request(key),
      new Response(file, {
        headers: {
          'Content-Type': file.type || 'image/jpeg',
          'X-File-Name': encodeURIComponent(file.name || 'shared.jpg')
        }
      })
    );
    // 只保留最近 5 个分享缓存
    const keys = await cache.keys();
    if (keys.length > 5) {
      await Promise.all(keys.slice(0, keys.length - 5).map((k) => cache.delete(k)));
    }
    return Response.redirect(
      new URL('./index.html?shared=' + encodeURIComponent(key), self.registration.scope).href,
      303
    );
  } catch (err) {
    return Response.redirect(new URL('./index.html?share=error', self.registration.scope).href, 303);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Android 分享目标：POST 表单里带图片
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// fixture service worker
const CACHE = 'nofetch-v1';
const PRECACHE = ["/","/index.html","/about.html","/manifest.webmanifest","/icon-192.png","/icon-512.png"];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

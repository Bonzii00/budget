// Service worker: l'app funziona offline e si aggiorna con il tasto "Aggiorna".
// VERSION va aumentata a ogni pubblicazione (insieme ad APP_VERSION in app.js):
// il telefono vede il file cambiato, scarica la nuova versione e mostra l'avviso.
const VERSION = '1.2.0';
const CACHE = `budget-${VERSION}`;
const FILES = [
  './', 'index.html', 'style.css', 'ios27.css', 'savings.js', 'backend.js', 'report.js', 'app.js',
  'manifest.webmanifest', 'icons/icon-32.png', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // non si attiva da solo: aspetta che l'utente tocchi "Aggiorna"
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('budget-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Prima la cache (veloce e offline); i dati non passano mai di qui, stanno nel telefono
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE)
      .then((c) => c.match(e.request, { ignoreSearch: true }))
      .then((hit) => hit || fetch(e.request)),
  );
});

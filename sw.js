// sw.js – gör att appen fungerar utan internet (bara när den ligger på en https-adress).
const NAMN = 'lopkoll-1';
const FILER = ['./', 'index.html', 'stil.css', 'app.js', 'manifest.json', 'ikon-180.png', 'ikon-192.png', 'ikon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(NAMN).then(c => c.addAll(FILER))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== NAMN).map(n => caches.delete(n))))));
// Försök hämta det nyaste först, och använd den sparade kopian om det inte finns internet
self.addEventListener('fetch', e => e.respondWith(
  fetch(e.request).then(svar => { const kopia = svar.clone(); caches.open(NAMN).then(c => c.put(e.request, kopia)); return svar; })
    .catch(() => caches.match(e.request))
));

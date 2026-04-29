const CACHE_NAME = 'suncat-audio-v2';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 1. INSTALL: Cache the core App Shell
self.addEventListener('install', event => {
  self.skipWaiting(); // Force the waiting service worker to become the active service worker
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Suncat SW: Caching App Shell');
      return cache.addAll(urlsToCache);
    })
  );
});

// 2. ACTIVATE: Clean up old caches (like v1)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Suncat SW: Clearing old cache', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim()) // Take control of all open pages immediately
  );
});

// 3. MESSAGE: Handle the Bulk Download Request
self.addEventListener('message', async event => {
  if (event.data.action === 'START_BULK_DOWNLOAD') {
    const tracks = event.data.tracks;
    const cache = await caches.open(CACHE_NAME);
    let count = 0;

    for (const track of tracks) {
      try {
        // Encode the URI to handle spaces in filenames like "Baby Boy.mp3"
        const cleanUrl = encodeURI(track);
        
        // Check if we already cached it dynamically to save bandwidth
        const existingResponse = await cache.match(cleanUrl);
        
        if (!existingResponse) {
          const networkResponse = await fetch(cleanUrl);
          if (networkResponse.ok) {
            await cache.put(cleanUrl, networkResponse.clone());
          }
        }
        
        count++;
        
        // Report progress back to the frontend
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
          client.postMessage({
            action: 'DOWNLOAD_PROGRESS',
            current: count,
            total: tracks.length,
            track: track
          });
        });

      } catch (err) {
        console.error(`Suncat SW: Failed to cache track ${track}`, err);
        // We purposefully don't break the loop here. If one fails, keep going.
      }
    }
  }
});

// 4. FETCH: Dynamic Caching & Offline Routing
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      // Return from cache if we have it
      if (cachedResponse) {
        return cachedResponse;
      }

      // Otherwise, fetch from the network
      return fetch(event.request).then(networkResponse => {
        // DYNAMIC CACHING: If it's an MP3 that isn't cached yet, save a copy silently
        if (networkResponse.ok && event.request.url.endsWith('.mp3')) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Optional: Return a specific offline fallback page/audio if the network is totally dead
        console.log('Suncat SW: Network request failed and not in cache.');
      });
    })
  );
});

const CACHE_NAME = 'suncat-audio-v5';
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
self.addEventListener('message', event => {
    if (event.data.action === 'START_BULK_DOWNLOAD') {
        const tracks = event.data.tracks;
        const client = event.source;

        event.waitUntil((async () => {
            const cache = await caches.open(CACHE_NAME);
            let count = 0;

            for (const track of tracks) {
                try {
                    const cleanUrl = encodeURI(track);
                    const existingResponse = await cache.match(cleanUrl);

                    // THE FIX: Only skip if it's already cached AND it's a full 200 file
                    if (!existingResponse || existingResponse.status !== 200) {
                        const networkResponse = await fetch(cleanUrl);
                        // Only cache if the network gives us the full file
                        if (networkResponse.status === 200) {
                            await cache.put(cleanUrl, networkResponse.clone());
                        }
                    }
                } catch (err) {
                    console.error(`Suncat SW: Failed to cache ${track}`, err);
                } finally {
                    count++;
                    if (client) {
                        client.postMessage({
                            action: 'DOWNLOAD_PROGRESS',
                            current: count,
                            total: tracks.length,
                            track: track
                        });
                    }
                }
            }
        })());
    }
});

// 4. FETCH: Dynamic Caching & Offline Routing
self.addEventListener('fetch', event => {
    // Is this an audio file?
    if (event.request.url.includes('.mp3')) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cachedResponse = await cache.match(event.request, { ignoreSearch: true });

            if (cachedResponse) {
                // Slice the cache for Range requests so Android doesn't panic
                const rangeHeader = event.request.headers.get('range');
                if (rangeHeader) {
                    const blob = await cachedResponse.blob();
                    const size = blob.size;
                    
                    const parts = rangeHeader.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
                    
                    const chunk = blob.slice(start, end + 1);

                    return new Response(chunk, {
                        status: 206,
                        statusText: 'Partial Content',
                        headers: new Headers({
                            'Content-Type': 'audio/mpeg',
                            'Content-Range': `bytes ${start}-${end}/${size}`,
                            'Content-Length': chunk.size,
                            'Accept-Ranges': 'bytes'
                        })
                    });
                }
                return cachedResponse;
            }

            // IF NOT CACHED: Fetch from network
            try {
                const networkResponse = await fetch(event.request);
                
                // THE FIX: NEVER dynamically cache a 206 Partial Chunk! 
                // Only cache full 200 OK responses.
                if (networkResponse.status === 200) {
                    cache.put(event.request, networkResponse.clone());
                }
                return networkResponse;
            } catch (err) {
                console.log('Suncat SW: Network fetch failed for audio', err);
            }
        })());
    } else {
        // Standard caching for HTML, CSS, JS
        event.respondWith(
            caches.match(event.request).then(cachedResponse => {
                return cachedResponse || fetch(event.request);
            })
        );
    }
});

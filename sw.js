const CACHE_NAME = 'suncat-audio-v7';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 1. INSTALL: Cache the core App Shell
self.addEventListener('install', event => {
  self.skipWaiting(); 
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Suncat SW: Caching App Shell');
      return cache.addAll(urlsToCache);
    })
  );
});

// 2. ACTIVATE: Clean up old caches
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
    }).then(() => self.clients.claim()) 
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
                    // THE CRITICAL FIX: Convert relative paths ("Baby Boy.mp3") 
                    // to absolute URLs so the fetch event can find them in the cache later!
                    const absoluteUrl = new URL(track, self.location.href).href;
                    
                    const existingResponse = await cache.match(absoluteUrl);

                    // Only skip if it's already cached AND it's a full 200 file
                    if (!existingResponse || existingResponse.status !== 200) {
                        const networkResponse = await fetch(absoluteUrl);
                        if (networkResponse.status === 200) {
                            await cache.put(absoluteUrl, networkResponse.clone());
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
            
            // Match against the exact absolute URL the browser is requesting
            const cachedResponse = await cache.match(event.request.url, { ignoreSearch: true });

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
                
                // NEVER dynamically cache a 206 Partial Chunk! 
                // Only cache full 200 OK responses.
                if (networkResponse.status === 200) {
                    cache.put(event.request.url, networkResponse.clone());
                }
                return networkResponse;
            } catch (err) {
                console.log('Suncat SW: Network fetch failed for audio (Offline)', err);
                // Return a graceful 503 so the audio engine knows it's offline rather than hanging
                return new Response("Offline", { status: 503 });
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

const CACHE_NAME = 'suncat-audio-v4';
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
        const client = event.source; // Grab the specific browser tab talking to us, much faster than matchAll()

        // Tell the browser NOT to kill the Service Worker until this promise resolves
        event.waitUntil((async () => {
            const cache = await caches.open(CACHE_NAME);
            let count = 0;

            for (const track of tracks) {
                try {
                    const cleanUrl = encodeURI(track);
                    const existingResponse = await cache.match(cleanUrl);

                    // Only fetch if it's genuinely missing
                    if (!existingResponse) {
                        const networkResponse = await fetch(cleanUrl);
                        if (networkResponse.ok) {
                            await cache.put(cleanUrl, networkResponse.clone());
                        }
                    }
                } catch (err) {
                    console.error(`Suncat SW: Failed to cache ${track}`, err);
                } finally {
                    // FINALLY block: ALWAYS increment the count, even if a fetch fails.
                    // This guarantees your UI progress bar never permanently hangs.
                    count++;
                    
                    // Talk directly to the tab instantly
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
    // 1. Is this an audio file?
    if (event.request.url.endsWith('.mp3')) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            
            // Look for the file in the cache (ignoring any weird URL parameters)
            const cachedResponse = await cache.match(event.request, { ignoreSearch: true });

            if (cachedResponse) {
                // THE FIX: Does the browser want a specific chunk? (Range request)
                const rangeHeader = event.request.headers.get('range');
                if (rangeHeader) {
                    const blob = await cachedResponse.blob();
                    const size = blob.size;
                    
                    // Parse the range header (e.g., "bytes=0-1000")
                    const parts = rangeHeader.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
                    
                    // Slice the cached blob into the exact chunk requested
                    const chunk = blob.slice(start, end + 1);

                    // Send back a "206 Partial Content" response so Android doesn't freak out
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
                
                // If it didn't ask for a range, just return the whole file
                return cachedResponse;
            }

            // IF NOT CACHED: Fetch from network and save a copy silently
            try {
                const networkResponse = await fetch(event.request);
                if (networkResponse.ok) {
                    cache.put(event.request, networkResponse.clone());
                }
                return networkResponse;
            } catch (err) {
                console.log('Suncat SW: Network fetch failed for audio', err);
            }
        })());
    } else {
        // 2. For everything else (HTML, CSS, App Shell), do standard caching
        event.respondWith(
            caches.match(event.request).then(cachedResponse => {
                return cachedResponse || fetch(event.request);
            })
        );
    }
});

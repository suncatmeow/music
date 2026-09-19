const CACHE_NAME = 'suncat-music-shell-v1';
const AUDIO_CACHE = 'suncat-audio-v9';
const LEGACY_CACHE = 'suncat-audio-v91.0613';
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
    event.waitUntil((async () => {
        const names = await caches.keys();
        const audioCache = await caches.open(AUDIO_CACHE);

        // Preserve full songs downloaded by the old bulk downloader.
        if (names.includes(LEGACY_CACHE)) {
            const legacy = await caches.open(LEGACY_CACHE);

            for (const request of await legacy.keys()) {
                const url = new URL(request.url);
                if (!url.pathname.toLowerCase().endsWith('.mp3')) continue;

                const existing = await audioCache.match(request);
                if (existing?.status === 200) continue;

                const response = await legacy.match(request);
                if (response?.status === 200) {
                    await audioCache.put(request, response);
                }
            }
        }

        // Delete only this app's obsolete shell caches.
        await Promise.all(
            names
                .filter(name =>
                    name.startsWith('suncat-music-shell-') &&
                    name !== CACHE_NAME
                )
                .map(name => caches.delete(name))
        );

        await self.clients.claim();
    })());
});

// 3. MESSAGE: Handle the Bulk Download Request
self.addEventListener('message', event => {
    if (event.data.action === 'START_BULK_DOWNLOAD') {
        const tracks = event.data.tracks;
        const client = event.source;

        event.waitUntil((async () => {
            const cache = await caches.open(AUDIO_CACHE);
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
                        if (networkResponse.status !== 200) {
                            throw new Error(`Download failed: HTTP ${networkResponse.status}`);
                        }
                        await cache.put(absoluteUrl, networkResponse);
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
async function cachedAudioResponse(request, cachedResponse) {
    const range = request.headers.get('range');

    // A complete response is safe when conditional range validation
    // isn't implemented.
    if (!range || request.headers.has('if-range')) {
        return cachedResponse;
    }

    // Handle one byte range. For malformed or multiple ranges,
    // ignore Range and return the complete cached 200 response.
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());

    if (!match || (!match[1] && !match[2])) {
        return cachedResponse;
    }

    const first = match[1] ? Number(match[1]) : null;
    const last = match[2] ? Number(match[2]) : null;

    if ([first, last].some(value =>
        value !== null && !Number.isSafeInteger(value)
    )) {
        return cachedResponse;
    }

    const blob = await cachedResponse.blob();
    const size = blob.size;

    let start;
    let end;

    if (first === null) {
        // bytes=-500 means the final 500 bytes.
        start = Math.max(0, size - last);
        end = size - 1;
    } else {
        start = first;
        end = last === null
            ? size - 1
            : Math.min(last, size - 1);
    }

    if (size === 0 || start >= size || start > end) {
        return new Response(null, {
            status: 416,
            headers: {
                'Content-Range': `bytes */${size}`,
                'Accept-Ranges': 'bytes'
            }
        });
    }

    const chunk = blob.slice(start, end + 1);

    return new Response(chunk, {
        status: 206,
        headers: {
            'Content-Type':
                cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(chunk.size),
            'Accept-Ranges': 'bytes'
        }
    });
}
// 4. FETCH: Dynamic Caching & Offline Routing
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
    // Is this an audio file?
    if (event.request.url.includes('.mp3')) {
        event.respondWith((async () => {
            const cache = await caches.open(AUDIO_CACHE);
            
            // Match against the exact absolute URL the browser is requesting
            const cachedResponse = await cache.match(event.request.url, { ignoreSearch: true });

            if (cachedResponse?.status === 200) {
                return cachedAudioResponse(event.request, cachedResponse);
            }

            // IF NOT CACHED: Fetch from network
            try {
                // BUG FIX: Return the fetch directly without auto-caching to preserve user storage
                return await fetch(event.request);
            } catch (err) {
                console.log('Suncat SW: Network fetch failed for audio (Offline)', err);
                // Return a graceful 503 so the audio engine knows it's offline rather than hanging
                return new Response("Offline", { status: 503 });
            }
        })());
    } else {
        // Standard caching for HTML, CSS, JS
        event.respondWith(
            caches.match(event.request, { ignoreSearch: true }).then(cachedResponse => {
                // 1. If we found a match (ignoring query strings like ?track=), return it!
                if (cachedResponse) {
                    return cachedResponse;
                }
                
                // 2. If not in cache, try the network
                return fetch(event.request).catch(() => {
                    // 3. If the network fails (offline) AND the user is trying to load a webpage
                    // Force the service worker to serve the cached App Shell
                    if (event.request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                });
            })
        );
    }
});

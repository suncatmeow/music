/* Suncat Archive 2.3.2 — scope-safe shell updates, explicit audio downloads,
   full/range offline playback, and compatibility with the previous player. */
const SCOPE = new URL(self.registration.scope);
const CACHE_NAME = 'suncat-music-shell-v2.4-' + encodeURIComponent(SCOPE.pathname);
const AUDIO_CACHE = 'suncat-audio-v9';
const LEGACY_CACHE = 'suncat-audio-v91.0613';
const SHELL = ['index.html','manifest.json','assets/suncat-og-image.jpg','icon-192.png','icon-512.png'];
const urlFor = path => new URL(path, SCOPE).href;
function normalized(url) { const u = new URL(url, SCOPE); try { return u.origin + decodeURIComponent(u.pathname); } catch { return u.origin + u.pathname; } }
function isFullAudio(response) { return response?.status === 200 && !/text\/html|application\/json/i.test(response.headers.get('content-type') || ''); }
self.addEventListener('install', event => {
 event.waitUntil((async () => {
  const cache = await caches.open(CACHE_NAME);
  // A failed deployment never replaces an already working offline shell.
  await cache.addAll(SHELL.map(path => new Request(urlFor(path), {cache:'reload'})));
  await self.skipWaiting();
 })());
});
self.addEventListener('activate', event => {
 event.waitUntil((async () => {
  const suffix = '-' + encodeURIComponent(SCOPE.pathname);
  for (const name of await caches.keys()) {
   if (name.startsWith('suncat-music-shell-v2.') && name.endsWith(suffix) && name !== CACHE_NAME) await caches.delete(name);
  }
  // Both generations of downloaded audio remain in place; no costly copying.
  await self.clients.claim();
 })());
});
async function findAudio(request) {
 const names = await caches.keys();
 for (const name of [AUDIO_CACHE, LEGACY_CACHE]) {
  if (!names.includes(name)) continue;
  const cache = await caches.open(name);
  const direct = await cache.match(request.url, {ignoreSearch:true});
  if (isFullAudio(direct)) return direct;
  // Previous versions encoded apostrophes differently. Match the decoded path.
  const key = normalized(request.url);
  for (const stored of await cache.keys()) if (normalized(stored.url) === key) {
   const response = await cache.match(stored);
   if (isFullAudio(response)) return response;
  }
 }
 return null;
}
let bulkRunning = false;
self.addEventListener('message', event => {
 if (event.data?.action !== 'START_BULK_DOWNLOAD' || !Array.isArray(event.data.tracks) || bulkRunning) return;
 const tracks = event.data.tracks.slice(0,1000).filter(x => typeof x === 'string');
 event.waitUntil((async () => {
  bulkRunning = true;
  try {
   const cache = await caches.open(AUDIO_CACHE); let current = 0;
   for (const track of tracks) {
    let success = false;
    try {
     const url = new URL(track, SCOPE);
     if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname) || !url.pathname.toLowerCase().endsWith('.mp3')) throw Error('Invalid track');
     if (!await findAudio(new Request(url))) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
      try { const response = await fetch(url, {signal:controller.signal}); if (!isFullAudio(response)) throw Error('Incomplete audio'); await cache.put(url, response); }
      finally { clearTimeout(timer); }
     }
     success = true;
    } catch (error) { console.warn('Track not saved:', track, error.name); }
    event.source?.postMessage({action:'DOWNLOAD_PROGRESS',current:++current,total:tracks.length,track,success});
   }
  } finally { bulkRunning = false; }
 })());
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

self.addEventListener('fetch', event => {
 const request = event.request, url = new URL(request.url);
 if (request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
 if (url.pathname.toLowerCase().endsWith('.mp3')) {
  event.respondWith((async () => {
   const cached = await findAudio(request);
   if (cached) return cachedAudioResponse(request, cached);
   try { return await fetch(request); } catch { return new Response('Audio is not saved on this device.', {status:503,headers:{'Content-Type':'text/plain'}}); }
  })());
  return;
 }
 const isAppPage = request.mode === 'navigate' && (url.pathname === SCOPE.pathname || url.pathname === new URL('index.html', SCOPE).pathname);
 if (isAppPage) {
  event.respondWith((async () => {
   const cache = await caches.open(CACHE_NAME);
   const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
   try {
    const response = await fetch(request, {signal:controller.signal,cache:'no-cache'});
    if (response.ok && /text\/html/i.test(response.headers.get('content-type') || '')) {
     // Cache writes must not turn successful online navigation into a failure.
     try { await cache.put(urlFor('index.html'), response.clone()); } catch {}
     return response;
    }
    return (await cache.match(urlFor('index.html'))) || response;
   } catch { return (await cache.match(urlFor('index.html'))) || new Response('Connect to the internet to open Suncat for the first time.',{status:503,headers:{'Content-Type':'text/plain'}}); }
   finally { clearTimeout(timer); }
  })());
  return;
 }
 // Cache only this app's known assets; analytics and unrelated pages pass through.
 if (SHELL.some(path => new URL(path, SCOPE).pathname === url.pathname)) {
  event.respondWith((async () => { const cache=await caches.open(CACHE_NAME); return (await cache.match(request,{ignoreSearch:true})) || fetch(request); })());
 }
});

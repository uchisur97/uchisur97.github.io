/*
 * Feelings, by Me. — service worker for the public reading app.
 *
 * Generated at build time from scripts/service-worker.template.js; the build
 * replaces CONFIG below with this release's exact list of public files.
 *
 * Rules:
 *  • It only ever handles GET requests for this journal's own pages and files on
 *    its own origin. Anything else (other sites, the writing studio, GitHub,
 *    other projects on the same domain) passes straight through, untouched.
 *  • Pages always come from the network when there is one. Offline, a piece is
 *    served only if the reader explicitly saved it; otherwise a gentle offline
 *    page is shown.
 *  • Saving is only possible for pieces listed in the published index, and
 *    saved copies are re-checked against it: a piece that changed is refreshed,
 *    one that is no longer published is removed from the device, and copies
 *    saved under an older release are refreshed to the current design.
 *  • Caches from older releases are deleted when a new release activates.
 */

const CONFIG = {
  "version": "10a71746f681",
  "base": "/",
  "roots": [
    "404.html",
    "_astro",
    "about",
    "apple-touch-icon.png",
    "archive",
    "brand",
    "favicon-32.png",
    "favicon.ico",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-192.png",
    "icon-maskable-512.png",
    "index.html",
    "library",
    "offline",
    "og",
    "reader-index.json",
    "robots.txt",
    "rss.xml",
    "site.webmanifest",
    "sitemap-0.xml",
    "sitemap-index.xml",
    "splash",
    "writings"
  ],
  "shell": [
    "/_astro/BaseLayout.BZOKO6Iy.css",
    "/_astro/BaseLayout.astro_astro_type_script_index_0_lang.Db4yOFyz.js",
    "/_astro/cormorant-garamond-latin-wght-italic.C-nL33vl.woff2",
    "/_astro/cormorant-garamond-latin-wght-normal.CUoBjw-S.woff2",
    "/_astro/eb-garamond-latin-wght-italic.AvGrCMCN.woff2",
    "/_astro/eb-garamond-latin-wght-normal.CRpggXlh.woff2",
    "/_astro/jost-latin-wght-normal.ObQm3Zd1.woff2",
    "/brand/emblem-112.webp",
    "/brand/emblem-36.webp",
    "/brand/emblem-56.webp",
    "/brand/emblem-72.webp",
    "/icon-192.png",
    "/library/",
    "/offline/"
  ],
  "fonts": [
    "/_astro/cormorant-garamond-latin-wght-italic.C-nL33vl.woff2",
    "/_astro/cormorant-garamond-latin-wght-normal.CUoBjw-S.woff2",
    "/_astro/eb-garamond-latin-wght-italic.AvGrCMCN.woff2",
    "/_astro/eb-garamond-latin-wght-normal.CRpggXlh.woff2",
    "/_astro/jost-latin-wght-normal.ObQm3Zd1.woff2"
  ],
  "offline": "/offline/",
  "library": "/library/",
  "index": "/reader-index.json"
};

const SHELL_CACHE = `fbm-shell-${CONFIG.version}`;
const SAVED_CACHE = 'fbm-saved-v1';
const RECORDS_KEY = new URL(`${CONFIG.base}__fbm/saved.json`, self.location.origin).href; // never on the network
const SYNC_KEY = new URL(`${CONFIG.base}__fbm/last-sync.json`, self.location.origin).href;
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const PREFERRED_IMAGE_WIDTH = 1080;

/* ───────────── install & activate ───────────── */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(CONFIG.shell.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('fbm-') && name !== SHELL_CACHE && name !== SAVED_CACHE) await caches.delete(name);
      }
      await pruneSavedAssets();
      await self.clients.claim();
    })(),
  );
  // A new release may have changed or unpublished pieces: re-check saved copies.
  sync({ force: true }).catch(() => {});
});

/* ───────────── requests ───────────── */

const sameOrigin = (url) => url.origin === self.location.origin;

/** True only for paths that belong to this journal (see CONFIG.roots). */
function inJournal(pathname) {
  if (!pathname.startsWith(CONFIG.base)) return false;
  const rest = pathname.slice(CONFIG.base.length);
  if (rest === '') return true;
  return CONFIG.roots.includes(rest.split('/')[0]);
}

const isAsset = (pathname) =>
  pathname.startsWith(`${CONFIG.base}_astro/`) || pathname.startsWith(`${CONFIG.base}brand/`);

/** Saved copies are keyed by the page's address without query or fragment. */
function pageKey(url) {
  const u = new URL(url, self.location.origin);
  let path = u.pathname;
  if (!path.endsWith('/') && !/\.[a-z0-9]+$/i.test(path)) path += '/';
  return u.origin + path;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!sameOrigin(url) || !inJournal(url.pathname)) return; // not ours: leave it alone
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
  } else if (isAsset(url.pathname)) {
    event.respondWith(asset(request, url));
  }
  // Everything else (feeds, sitemap, sharing images, the index…) goes to the network as usual.
});

async function navigate(request) {
  try {
    const response = await fetch(request);
    if (response.status === 404 || response.status === 410) {
      // A saved piece that no longer exists is removed from this device.
      const records = await readRecords();
      if (records[pageKey(request.url)]) await removeArticle(pageKey(request.url));
    }
    return response;
  } catch {
    const key = pageKey(request.url);
    const saved = await (await caches.open(SAVED_CACHE)).match(key, { ignoreVary: true });
    if (saved) return saved;
    const fallback = key === new URL(CONFIG.library, self.location.origin).href ? CONFIG.library : CONFIG.offline;
    return (await caches.match(fallback, { ignoreVary: true })) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function asset(request, url) {
  // Build files are immutable and named by their content, so headers such as
  // Vary: Origin (sent with scripts and fonts) must not prevent a match.
  const cached = await caches.match(request, { ignoreVary: true, ignoreSearch: false });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    if (/\.(webp|avif|png|jpe?g|gif|svg)$/i.test(url.pathname)) return imageFallback(url);
    return Response.error();
  }
}

/** Offline, show another saved size of the same picture, or a quiet placeholder. */
async function imageFallback(url) {
  const file = url.pathname.split('/').pop() || '';
  const stem = file.slice(0, file.indexOf('.') + 1);
  if (stem.length > 1) {
    const cache = await caches.open(SAVED_CACHE);
    for (const request of await cache.keys()) {
      const name = new URL(request.url).pathname.split('/').pop() || '';
      if (name.startsWith(stem) && name !== file) return (await cache.match(request)) || placeholder();
    }
  }
  return placeholder();
}

function placeholder() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240" role="img" aria-label="Image not available offline"><rect width="400" height="240" fill="#FCE8EF"/><text x="200" y="128" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="18" fill="#7A5A6B">image not saved for offline reading</text></svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
}

/* ───────────── saved articles ───────────── */

async function readRecords() {
  const response = await (await caches.open(SAVED_CACHE)).match(RECORDS_KEY);
  return response ? response.json() : {};
}

async function writeRecords(records) {
  await (await caches.open(SAVED_CACHE)).put(
    RECORDS_KEY,
    new Response(JSON.stringify(records), { headers: { 'Content-Type': 'application/json' } }),
  );
}

async function fetchIndex() {
  const response = await fetch(new URL(CONFIG.index, self.location.origin), { cache: 'no-store' });
  if (!response.ok) throw new Error('index-unavailable');
  const { articles } = await response.json();
  const index = {};
  for (const article of articles) index[new URL(article.url, self.location.origin).href] = article;
  return index;
}

/** Image URLs in a page that a saved copy should keep: the chosen size of each picture. */
function chooseImages(html, requested) {
  const found = new Set();
  const inPage = (u) => html.includes(new URL(u, self.location.origin).pathname);
  for (const u of requested || []) {
    const url = new URL(u, self.location.origin);
    if (sameOrigin(url) && isAsset(url.pathname) && inPage(url.href)) found.add(url.href);
  }
  if (requested && requested.length) return [...found];
  // No preference given (a background refresh): take the size nearest a phone/tablet screen.
  for (const tag of html.match(/<img\b[^>]*>/g) || []) {
    const srcset = (tag.match(/\ssrcset="([^"]+)"/) || [])[1];
    const src = (tag.match(/\ssrc="([^"]+)"/) || [])[1];
    let pick = src;
    if (srcset) {
      const candidates = srcset.split(',').map((c) => c.trim().split(/\s+/)).map(([u, w]) => ({ u, w: parseInt(w, 10) || 0 }));
      candidates.sort((a, b) => Math.abs(a.w - PREFERRED_IMAGE_WIDTH) - Math.abs(b.w - PREFERRED_IMAGE_WIDTH));
      pick = candidates[0] ? candidates[0].u : src;
    }
    if (pick) {
      const url = new URL(pick.replace(/&amp;/g, '&'), self.location.origin);
      if (sameOrigin(url) && isAsset(url.pathname)) found.add(url.href);
    }
  }
  return [...found];
}

/** Stylesheets, scripts and fonts a saved page needs to look right offline. */
function pageAssets(html) {
  const found = new Set(CONFIG.fonts.map((u) => new URL(u, self.location.origin).href));
  for (const m of html.matchAll(/(?:href|src)="([^"]+\.(?:css|js))"/g)) {
    const url = new URL(m[1], self.location.origin);
    if (sameOrigin(url) && isAsset(url.pathname)) found.add(url.href);
  }
  return [...found];
}

async function saveArticle(pageUrl, requestedImages, index) {
  const key = pageKey(pageUrl);
  index = index || (await fetchIndex());
  const article = index[key];
  if (!article) throw new Error('not-published'); // only published pieces can be saved
  const response = await fetch(key, { cache: 'no-cache' });
  const type = response.headers.get('Content-Type') || '';
  if (!response.ok || !type.includes('text/html')) throw new Error('page-unavailable');
  const html = await response.text();

  const cache = await caches.open(SAVED_CACHE);
  const wanted = [...pageAssets(html), ...chooseImages(html, requestedImages)];
  const stored = [];
  await Promise.all(
    wanted.map(async (url) => {
      try {
        const existing = await caches.match(url, { ignoreVary: true });
        const res = existing || (await fetch(url));
        if (res.ok) {
          await cache.put(url, res.clone());
          stored.push(url);
        }
      } catch {
        /* an image that cannot be fetched now shows a placeholder offline */
      }
    }),
  );
  const savedAt = new Date().toISOString();
  await cache.put(key, new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Saved-At': savedAt } }));
  const records = await readRecords();
  records[key] = { url: key, title: article.title, date: article.date, category: article.category, hash: article.hash, release: CONFIG.version, savedAt, assets: stored };
  await writeRecords(records);
  return records[key];
}

async function removeArticle(key) {
  const records = await readRecords();
  delete records[key];
  await writeRecords(records);
  await (await caches.open(SAVED_CACHE)).delete(key);
  await pruneSavedAssets(records);
}

/** Delete saved files no longer needed by any saved piece. */
async function pruneSavedAssets(records) {
  records = records || (await readRecords());
  const keep = new Set([RECORDS_KEY, SYNC_KEY]);
  for (const record of Object.values(records)) {
    keep.add(record.url);
    for (const url of record.assets) keep.add(url);
  }
  const cache = await caches.open(SAVED_CACHE);
  for (const request of await cache.keys()) {
    if (!keep.has(request.url)) await cache.delete(request);
  }
}

/** Re-check saved copies against what is published now. */
async function sync({ force = false } = {}) {
  const cache = await caches.open(SAVED_CACHE);
  const last = await cache.match(SYNC_KEY);
  if (!force && last && Date.now() - (await last.json()).at < SYNC_INTERVAL_MS) return { removed: [], refreshed: 0, skipped: true };
  const records = await readRecords();
  if (!Object.keys(records).length) return { removed: [], refreshed: 0 };
  const index = await fetchIndex(); // throws when offline: nothing changes
  const removed = [];
  let refreshed = 0;
  for (const record of Object.values(records)) {
    const current = index[record.url];
    if (!current) {
      removed.push(record.title);
      await removeArticle(record.url);
    } else if (current.hash !== record.hash || record.release !== CONFIG.version) {
      // The piece changed, or the site's design did (new styles, fonts or scripts).
      try {
        await saveArticle(record.url, null, index);
        refreshed++;
      } catch {
        /* keep the older copy until the next check */
      }
    }
  }
  await pruneSavedAssets();
  await cache.put(SYNC_KEY, new Response(JSON.stringify({ at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
  if (removed.length) {
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'saved-removed', titles: removed });
  }
  return { removed, refreshed };
}

/* ───────────── messages from the reading app ───────────── */

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port || !event.data || typeof event.data.type !== 'string') return;
  const { type, url, images, force } = event.data;
  const reply = (promise) =>
    event.waitUntil(
      promise.then(
        (result) => port.postMessage({ ok: true, result }),
        (error) => port.postMessage({ ok: false, error: String((error && error.message) || error) }),
      ),
    );
  switch (type) {
    case 'save':
      reply(saveArticle(url, Array.isArray(images) ? images : []));
      break;
    case 'remove':
      reply(removeArticle(pageKey(url)));
      break;
    case 'list':
      reply(readRecords().then((records) => Object.values(records).map(({ assets, ...rest }) => rest)));
      break;
    case 'sync':
      reply(sync({ force: force === true }));
      break;
    case 'remove-all':
      reply(caches.delete(SAVED_CACHE).then(() => true));
      break;
  }
});

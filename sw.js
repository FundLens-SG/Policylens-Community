// ═══════════════════════════════════════════════════════════════
// PolicyLens Service Worker
// ───────────────────────────────────────────────────────────────
// Does three things:
//   1. OFFLINE CACHE — precache shell assets, serve them offline
//   2. EXTRACTION DISPATCH — receive batch requests from the page,
//      run them via Background Fetch API when available so they
//      survive tab closure / screen lock on Chrome Android
//   3. RESULT BRIDGE — store extraction results in IndexedDB so
//      the page can pick them up on next mount even if it was
//      killed while extraction was running
//
// Architectural notes:
//   • The page prepares files (compression, PDF unlock, base64) and
//     hands a finished POST Request to this SW. The SW doesn't know
//     about files, only about HTTP requests.
//   • Only the Gemini call runs via Background Fetch. Claude (if
//     configured) runs in the page on result receipt — keeps the SW
//     simple and avoids cross-context schema duplication.
//   • On iOS Safari, Background Fetch is unsupported. The page
//     detects this and skips the SW path entirely, falling back to
//     the Tier 1 in-page extraction with batch-level resume.
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'policylens-v1.0.3-tier2-multi';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
];

// IndexedDB configuration — SW uses its OWN database to avoid any
// version contention with the page's 'PolicyLensV4' database. The
// page explicitly reads from this DB via the same name/version when
// polling for SW-queued extraction results.
//
// Stores:
//   swExtractResults — final extraction results, keyed by sessionId
//   swBatchQueues    — in-progress multi-batch queues, sequential
//                      chain state for EXTRACT_RUN_MULTI sessions
const DB_NAME = 'PolicyLensSW';
const DB_VERSION = 2;
const EXTRACT_RESULTS_STORE = 'swExtractResults';
const BATCH_QUEUE_STORE = 'swBatchQueues';

// Maximum body size for Background Fetch. Chrome's documented quota
// is ~400MB but we cap lower to leave headroom for protocol overhead
// and to fail fast on pathological portfolios.
const MAX_BG_FETCH_BODY_BYTES = 200 * 1024 * 1024; // 200 MB

// ═══════════════════════════════════════════════════════════════
// LIFECYCLE: install / activate / fetch
// ═══════════════════════════════════════════════════════════════

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network-first for HTML (always get latest), cache-first for assets.
  // Same policy as before — we don't touch API calls to Gemini/Claude;
  // those are never intercepted because they're cross-origin and
  // never match a cached entry.
  if (e.request.mode === 'navigate' || e.request.url.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return r;
      }).catch(() => caches.match(e.request))
    );
  } else if (new URL(e.request.url).origin === self.location.origin) {
    // Only cache-first for same-origin assets. Cross-origin (API calls,
    // CDN libs) passes through to the network untouched.
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
  // else: let the browser handle it (no respondWith) — cross-origin,
  // non-cacheable, passes straight through
});

// ═══════════════════════════════════════════════════════════════
// IDB HELPERS
// ═══════════════════════════════════════════════════════════════

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Create stores if missing. This runs on first install (version
      // 0 → DB_VERSION) and on every version bump. We use IF NOT EXISTS
      // pattern so each bump only creates what's new.
      if (!db.objectStoreNames.contains(EXTRACT_RESULTS_STORE)) {
        db.createObjectStore(EXTRACT_RESULTS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(BATCH_QUEUE_STORE)) {
        db.createObjectStore(BATCH_QUEUE_STORE, { keyPath: 'sessionId' });
      }
    };
  });
}

async function idbPut(storeName, value) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[SW] idbPut failed:', storeName, e);
    return null;
  }
}

async function idbGet(storeName, key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[SW] idbGet failed:', storeName, e);
    return null;
  }
}

async function idbDelete(storeName, key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[SW] idbDelete failed:', storeName, e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE PROTOCOL
// ═══════════════════════════════════════════════════════════════
//
// page → sw:  { type: 'CHECK_SUPPORT' }
// sw → page:  { type: 'SUPPORT_RESULT', bgFetch: bool, version: string }
//
// page → sw:  { type: 'EXTRACT_RUN', sessionId, request: {url, body, headers} }
// sw → page:  { type: 'EXTRACT_PROGRESS', sessionId, phase: 'registered'|'fetching'|'parsing'|'done' }
// sw → page:  { type: 'EXTRACT_DONE', sessionId, result: [...policies], raw: geminiResponse }
// sw → page:  { type: 'EXTRACT_ERROR', sessionId, error: string }
//
// page → sw:  { type: 'EXTRACT_POLL', sessionId }
// sw → page:  { type: 'EXTRACT_STATE', sessionId, state: 'pending'|'done'|'error'|'missing', result? }
//
// ═══════════════════════════════════════════════════════════════

// Broadcast a message to every open client (page). Used for
// extraction progress and completion notifications. If no clients
// are open (page was killed), the message is dropped — the result
// still lives in IDB for the page to pick up on next mount.
async function broadcast(msg) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach(c => c.postMessage(msg));
  } catch (e) {
    console.warn('[SW] broadcast failed:', e);
  }
}

self.addEventListener('message', async (e) => {
  const data = e.data || {};
  const reply = (msg) => { try { e.source && e.source.postMessage(msg); } catch (_) {} };

  switch (data.type) {
    case 'CHECK_SUPPORT': {
      reply({
        type: 'SUPPORT_RESULT',
        bgFetch: 'BackgroundFetchManager' in self.registration,
        version: CACHE_NAME,
      });
      break;
    }

    case 'EXTRACT_RUN': {
      const { sessionId, request } = data;
      if (!sessionId || !request) {
        reply({ type: 'EXTRACT_ERROR', sessionId, error: 'Missing sessionId or request' });
        return;
      }
      runExtraction(sessionId, request);
      break;
    }

    case 'EXTRACT_RUN_MULTI': {
      // Multi-batch extraction: page sends all batch bodies upfront,
      // SW stores the queue and processes sequentially via chained
      // Background Fetch registrations. Critical survivability win:
      // even if the page dies between batches, the SW's queue lives
      // on and the next batch fires as soon as the previous finishes.
      const { sessionId, url, headers, bodies } = data;
      if (!sessionId || !url || !Array.isArray(bodies) || bodies.length === 0) {
        reply({ type: 'EXTRACT_MULTI_ERROR', sessionId, error: 'Invalid EXTRACT_RUN_MULTI payload' });
        return;
      }
      // Initialize queue in IDB
      await idbPut(BATCH_QUEUE_STORE, {
        sessionId,
        url,
        headers: headers || { 'Content-Type': 'application/json' },
        pendingBodies: bodies.slice(), // defensive copy
        completedResults: [],
        totalBatches: bodies.length,
        completedBatches: 0,
        createdAt: Date.now(),
      });
      // Also mark pending in extract results store so polling works
      await idbPut(EXTRACT_RESULTS_STORE, {
        sessionId,
        state: 'pending',
        kind: 'multi',
        totalBatches: bodies.length,
        completedBatches: 0,
        startedAt: Date.now(),
      });
      broadcast({ type: 'EXTRACT_MULTI_PROGRESS', sessionId, completedBatches: 0, totalBatches: bodies.length, phase: 'queued' });
      // Kick off first batch
      runNextBatch(sessionId);
      break;
    }

    case 'EXTRACT_POLL': {
      const { sessionId } = data;
      const stored = await idbGet(EXTRACT_RESULTS_STORE, sessionId);
      if (!stored) {
        reply({ type: 'EXTRACT_STATE', sessionId, state: 'missing' });
      } else if (stored.state === 'done') {
        // Multi-batch completion returns an array of rawTexts
        if (stored.kind === 'multi') {
          reply({
            type: 'EXTRACT_STATE', sessionId,
            state: 'done',
            kind: 'multi',
            multiResults: stored.multiResults || [],
            totalBatches: stored.totalBatches,
          });
        } else {
          reply({ type: 'EXTRACT_STATE', sessionId, state: 'done', rawText: stored.rawText, fullResponse: stored.fullResponse });
        }
      } else if (stored.state === 'error') {
        reply({ type: 'EXTRACT_STATE', sessionId, state: 'error', error: stored.error });
      } else {
        // Still pending — for multi sessions include progress
        const queue = stored.kind === 'multi' ? await idbGet(BATCH_QUEUE_STORE, sessionId) : null;
        reply({
          type: 'EXTRACT_STATE',
          sessionId,
          state: 'pending',
          kind: stored.kind || 'single',
          completedBatches: queue?.completedBatches || 0,
          totalBatches: queue?.totalBatches || stored.totalBatches || 1,
          partialResults: queue?.completedResults || [],
        });
      }
      break;
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// EXTRACTION ORCHESTRATION
// ═══════════════════════════════════════════════════════════════
//
// Two paths:
//   A. Background Fetch (Chrome Android, some desktop) — registers
//      the request with the browser's download manager which
//      survives tab death. Result comes back via
//      `backgroundfetchsuccess` event.
//   B. Plain fetch (iOS, older browsers) — runs in the SW context
//      while the page is alive. Same reliability as a regular
//      in-page fetch but at least isolated from the React render
//      loop.
//
// Path A is attempted first. If it fails to register (unsupported,
// quota exceeded, permission denied), we fall back to path B.

async function runExtraction(sessionId, requestSpec) {
  // Mark pending state in IDB so poll returns something useful
  await idbPut(EXTRACT_RESULTS_STORE, {
    sessionId,
    state: 'pending',
    startedAt: Date.now(),
  });

  broadcast({ type: 'EXTRACT_PROGRESS', sessionId, phase: 'registered' });

  // Compute body size for routing decision. The body is always a
  // JSON string at this point (the page serializes before sending).
  const bodyBytes = typeof requestSpec.body === 'string'
    ? new Blob([requestSpec.body]).size
    : 0;

  // Path A: Background Fetch
  if ('BackgroundFetchManager' in self.registration && bodyBytes < MAX_BG_FETCH_BODY_BYTES) {
    try {
      const request = new Request(requestSpec.url, {
        method: 'POST',
        headers: requestSpec.headers || { 'Content-Type': 'application/json' },
        body: requestSpec.body,
      });
      const bgFetch = await self.registration.backgroundFetch.fetch(
        'extract-' + sessionId,
        [request],
        {
          title: 'PolicyLens — extracting policies',
          icons: [{ src: './icon-192.png', sizes: '192x192', type: 'image/png' }],
          downloadTotal: 0, // unknown upload size
        }
      );
      console.log('[SW] Background Fetch registered:', bgFetch.id, '(' + Math.round(bodyBytes/1024/1024) + ' MB)');
      return;
    } catch (e) {
      console.warn('[SW] BG fetch registration failed, falling back:', e);
      // Fall through to path B
    }
  } else if (bodyBytes >= MAX_BG_FETCH_BODY_BYTES) {
    console.warn('[SW] Body too large for BG fetch:', Math.round(bodyBytes/1024/1024), 'MB > 200 MB — using plain fetch fallback');
  }

  // Path B: Plain fetch in SW context
  try {
    broadcast({ type: 'EXTRACT_PROGRESS', sessionId, phase: 'fetching' });
    const response = await fetch(requestSpec.url, {
      method: 'POST',
      headers: requestSpec.headers || { 'Content-Type': 'application/json' },
      body: requestSpec.body,
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ': ' + response.statusText);
    }
    broadcast({ type: 'EXTRACT_PROGRESS', sessionId, phase: 'parsing' });
    const json = await response.json();
    await finalizeExtraction(sessionId, json);
  } catch (e) {
    await idbPut(EXTRACT_RESULTS_STORE, {
      sessionId, state: 'error',
      error: e.message || String(e),
      failedAt: Date.now(),
    });
    broadcast({ type: 'EXTRACT_ERROR', sessionId, error: e.message || String(e) });
  }
}

// Called from both paths once we have a Gemini response JSON.
// Stores the result in a shape that matches what the page's
// geminiStructuredExtract returns (raw text from candidates[0]) so
// the existing downstream pipeline (JSON repair, dedup, etc.) can
// consume it without a shape translation layer.
async function finalizeExtraction(sessionId, geminiResponse) {
  try {
    const rawText = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('Gemini returned empty response');
    await idbPut(EXTRACT_RESULTS_STORE, {
      sessionId,
      state: 'done',
      rawText,
      fullResponse: geminiResponse,
      finishedAt: Date.now(),
    });
    broadcast({ type: 'EXTRACT_DONE', sessionId, rawText, fullResponse: geminiResponse });
  } catch (e) {
    await idbPut(EXTRACT_RESULTS_STORE, {
      sessionId, state: 'error', error: e.message || String(e), failedAt: Date.now(),
    });
    broadcast({ type: 'EXTRACT_ERROR', sessionId, error: e.message || String(e) });
  }
}

// ═══════════════════════════════════════════════════════════════
// MULTI-BATCH SEQUENTIAL ORCHESTRATION (Fix #1)
// ───────────────────────────────────────────────────────────────
// The page sends all batches upfront via EXTRACT_RUN_MULTI. We
// register them one at a time as Background Fetches, chained
// through backgroundfetchsuccess events. This means:
//   • Only one BG fetch is active at a time (respects Chrome quota)
//   • If page dies between batches, SW continues the chain
//   • Progress broadcasts let the live page update UI incrementally
//   • Sequential order matches what the current page-driven loop
//     already does, so downstream processing behavior is unchanged
// ═══════════════════════════════════════════════════════════════

async function runNextBatch(sessionId) {
  const queue = await idbGet(BATCH_QUEUE_STORE, sessionId);
  if (!queue) {
    console.warn('[SW Multi] runNextBatch: no queue for', sessionId);
    return;
  }
  if (queue.pendingBodies.length === 0) {
    // All batches done — finalize
    return finalizeMultiExtraction(sessionId);
  }
  const body = queue.pendingBodies[0];
  const batchIndex = queue.completedBatches;
  const bodyBytes = new Blob([body]).size;

  // Body size gate — fall through to plain fetch in SW context
  if (bodyBytes >= MAX_BG_FETCH_BODY_BYTES) {
    console.warn('[SW Multi] Batch', batchIndex, 'too large for BG fetch:', Math.round(bodyBytes/1024/1024), 'MB — using plain fetch');
    try {
      const resp = await fetch(queue.url, {
        method: 'POST',
        headers: queue.headers,
        body,
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      await recordMultiBatchResult(sessionId, batchIndex, json);
      runNextBatch(sessionId); // chain continues
    } catch (err) {
      await recordMultiBatchError(sessionId, batchIndex, err.message || String(err));
      runNextBatch(sessionId); // skip failed, try next
    }
    return;
  }

  // BG fetch path
  try {
    const request = new Request(queue.url, {
      method: 'POST',
      headers: queue.headers,
      body,
    });
    await self.registration.backgroundFetch.fetch(
      'multi-' + sessionId + '-batch-' + batchIndex,
      [request],
      {
        title: `PolicyLens — batch ${batchIndex + 1} of ${queue.totalBatches}`,
        icons: [{ src: './icon-192.png', sizes: '192x192', type: 'image/png' }],
        downloadTotal: 0,
      }
    );
    console.log('[SW Multi] Registered batch', batchIndex + 1, 'of', queue.totalBatches);
  } catch (regErr) {
    console.warn('[SW Multi] BG fetch registration failed for batch', batchIndex, ':', regErr);
    // Fall back to plain fetch for this batch
    try {
      const resp = await fetch(queue.url, {
        method: 'POST',
        headers: queue.headers,
        body,
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      await recordMultiBatchResult(sessionId, batchIndex, json);
      runNextBatch(sessionId);
    } catch (err) {
      await recordMultiBatchError(sessionId, batchIndex, err.message || String(err));
      runNextBatch(sessionId);
    }
  }
}

// Called from either BG fetch success handler or plain-fetch fallback.
// Mutates the queue state (shift body off pending, add to results),
// then triggers broadcasts. Does NOT trigger the next batch — caller
// must do that explicitly so the chain can be paused for error paths.
async function recordMultiBatchResult(sessionId, batchIndex, geminiJson) {
  const queue = await idbGet(BATCH_QUEUE_STORE, sessionId);
  if (!queue) return;
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  queue.pendingBodies.shift();
  queue.completedBatches++;
  queue.completedResults.push({
    batchIndex,
    rawText,
    completedAt: Date.now(),
  });
  await idbPut(BATCH_QUEUE_STORE, queue);

  // Update the extract results store's pending-state progress
  const stored = await idbGet(EXTRACT_RESULTS_STORE, sessionId);
  if (stored && stored.state === 'pending') {
    stored.completedBatches = queue.completedBatches;
    await idbPut(EXTRACT_RESULTS_STORE, stored);
  }

  // Broadcast to live clients
  broadcast({
    type: 'EXTRACT_MULTI_PROGRESS',
    sessionId,
    completedBatches: queue.completedBatches,
    totalBatches: queue.totalBatches,
    latestBatchIndex: batchIndex,
    latestRawText: rawText,
    phase: 'batch_complete',
  });
}

async function recordMultiBatchError(sessionId, batchIndex, errorMsg) {
  const queue = await idbGet(BATCH_QUEUE_STORE, sessionId);
  if (!queue) return;
  queue.pendingBodies.shift();
  queue.completedBatches++; // count as "processed" even though failed
  queue.completedResults.push({
    batchIndex,
    rawText: '',
    error: errorMsg,
    completedAt: Date.now(),
  });
  await idbPut(BATCH_QUEUE_STORE, queue);
  broadcast({
    type: 'EXTRACT_MULTI_PROGRESS',
    sessionId,
    completedBatches: queue.completedBatches,
    totalBatches: queue.totalBatches,
    latestBatchIndex: batchIndex,
    latestError: errorMsg,
    phase: 'batch_error',
  });
}

async function finalizeMultiExtraction(sessionId) {
  const queue = await idbGet(BATCH_QUEUE_STORE, sessionId);
  if (!queue) return;
  // Store final aggregated result
  await idbPut(EXTRACT_RESULTS_STORE, {
    sessionId,
    state: 'done',
    kind: 'multi',
    multiResults: queue.completedResults,
    totalBatches: queue.totalBatches,
    completedBatches: queue.completedBatches,
    finishedAt: Date.now(),
  });
  broadcast({
    type: 'EXTRACT_MULTI_DONE',
    sessionId,
    results: queue.completedResults,
    totalBatches: queue.totalBatches,
  });
  // Clean up the queue — no longer needed once final result is stored
  await idbDelete(BATCH_QUEUE_STORE, sessionId);

  // ── PROACTIVE NOTIFICATION (Fix #3) ──
  // Show a user-visible notification if permission was granted.
  // Background Fetch's built-in notification shows while the fetch
  // is in flight, but once all batches complete (especially the
  // last plain-fetch fallback batch), that notification may already
  // be dismissed. A separate Notifications API ping gives the user
  // a persistent actionable signal.
  try {
    if (self.registration.showNotification && Notification.permission === 'granted') {
      // Count policies across all successful batches
      let totalPolicies = 0;
      for (const r of queue.completedResults) {
        if (r.rawText) {
          try {
            const parsed = JSON.parse(r.rawText);
            if (Array.isArray(parsed)) totalPolicies += parsed.length;
          } catch (_) {}
        }
      }
      await self.registration.showNotification('PolicyLens', {
        body: totalPolicies > 0
          ? `${totalPolicies} polic${totalPolicies === 1 ? 'y' : 'ies'} extracted across ${queue.totalBatches} batch${queue.totalBatches === 1 ? '' : 'es'}. Tap to review.`
          : `Extraction complete across ${queue.totalBatches} batch${queue.totalBatches === 1 ? '' : 'es'}. Tap to review.`,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'policylens-extract-' + sessionId,
        data: { sessionId, url: self.registration.scope },
      });
    }
  } catch (notifErr) {
    console.warn('[SW Multi] Notification failed:', notifErr);
  }
}

// ═══════════════════════════════════════════════════════════════
// BG FETCH EVENT HANDLERS — route between single and multi-batch
// ═══════════════════════════════════════════════════════════════

// Background Fetch completion handler. Routes on the registration
// ID prefix: 'extract-*' for legacy single-batch, 'multi-*-batch-N'
// for multi-batch sequential chain.
self.addEventListener('backgroundfetchsuccess', (e) => {
  const id = e.registration.id;
  console.log('[SW] backgroundfetchsuccess:', id);

  if (id.startsWith('multi-')) {
    // Multi-batch: parse sessionId and batch index
    const match = id.match(/^multi-(.+)-batch-(\d+)$/);
    if (!match) {
      console.warn('[SW] Unparseable multi BG fetch id:', id);
      return;
    }
    const sessionId = match[1];
    const batchIndex = parseInt(match[2], 10);
    e.waitUntil((async () => {
      try {
        const records = await e.registration.matchAll();
        if (records.length === 0) throw new Error('No records in registration');
        const resp = await records[0].responseReady;
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        await recordMultiBatchResult(sessionId, batchIndex, json);
        // Update the Chrome BG fetch notification
        try {
          if (e.updateUI) {
            const queue = await idbGet(BATCH_QUEUE_STORE, sessionId);
            if (queue && queue.pendingBodies.length > 0) {
              await e.updateUI({
                title: `PolicyLens — batch ${queue.completedBatches} of ${queue.totalBatches} done, continuing…`,
              });
            } else {
              await e.updateUI({ title: 'PolicyLens — all batches extracted' });
            }
          }
        } catch (_) {}
        // Trigger next batch in the chain
        runNextBatch(sessionId);
      } catch (err) {
        console.warn('[SW Multi] batch', batchIndex, 'processing failed:', err);
        await recordMultiBatchError(sessionId, batchIndex, err.message || String(err));
        runNextBatch(sessionId); // keep chain moving
      }
    })());
    return;
  }

  // Single-batch (legacy EXTRACT_RUN)
  const sessionId = id.replace(/^extract-/, '');
  e.waitUntil((async () => {
    try {
      const records = await e.registration.matchAll();
      if (records.length === 0) throw new Error('No records in registration');
      const resp = await records[0].responseReady;
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      await finalizeExtraction(sessionId, json);
      try {
        if (e.updateUI) {
          const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          let count = 0;
          try {
            const parsed = JSON.parse(rawText);
            count = Array.isArray(parsed) ? parsed.length : (parsed?.policies?.length || 0);
          } catch (_) {}
          await e.updateUI({
            title: count > 0
              ? `PolicyLens — ${count} polic${count === 1 ? 'y' : 'ies'} extracted`
              : 'PolicyLens — extraction complete',
          });
        }
      } catch (_) {}
      // Proactive notification for single-batch too
      try {
        if (self.registration.showNotification && Notification.permission === 'granted') {
          const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          let count = 0;
          try {
            const parsed = JSON.parse(rawText);
            count = Array.isArray(parsed) ? parsed.length : 0;
          } catch (_) {}
          await self.registration.showNotification('PolicyLens', {
            body: count > 0
              ? `${count} polic${count === 1 ? 'y' : 'ies'} extracted. Tap to review.`
              : 'Extraction complete. Tap to review.',
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: 'policylens-extract-' + sessionId,
            data: { sessionId, url: self.registration.scope },
          });
        }
      } catch (_) {}
    } catch (err) {
      console.warn('[SW] backgroundfetchsuccess processing failed:', err);
      await idbPut(EXTRACT_RESULTS_STORE, {
        sessionId, state: 'error', error: err.message || String(err), failedAt: Date.now(),
      });
      broadcast({ type: 'EXTRACT_ERROR', sessionId, error: err.message || String(err) });
      try {
        if (e.updateUI) await e.updateUI({ title: 'PolicyLens — extraction failed, tap to retry' });
      } catch (_) {}
    }
  })());
});

self.addEventListener('backgroundfetchfail', (e) => {
  const id = e.registration.id;
  console.warn('[SW] backgroundfetchfail:', id, e.registration.failureReason);

  if (id.startsWith('multi-')) {
    const match = id.match(/^multi-(.+)-batch-(\d+)$/);
    if (!match) return;
    const sessionId = match[1];
    const batchIndex = parseInt(match[2], 10);
    e.waitUntil((async () => {
      await recordMultiBatchError(sessionId, batchIndex, 'BG fetch failed: ' + (e.registration.failureReason || 'unknown'));
      runNextBatch(sessionId); // skip and continue chain
    })());
    return;
  }

  const sessionId = id.replace(/^extract-/, '');
  e.waitUntil((async () => {
    await idbPut(EXTRACT_RESULTS_STORE, {
      sessionId,
      state: 'error',
      error: 'Background fetch failed: ' + (e.registration.failureReason || 'unknown'),
      failedAt: Date.now(),
    });
    broadcast({
      type: 'EXTRACT_ERROR',
      sessionId,
      error: 'Background fetch failed: ' + (e.registration.failureReason || 'unknown'),
    });
  })());
});

self.addEventListener('backgroundfetchabort', (e) => {
  const id = e.registration.id;
  console.warn('[SW] backgroundfetchabort:', id);

  if (id.startsWith('multi-')) {
    const match = id.match(/^multi-(.+)-batch-(\d+)$/);
    if (!match) return;
    const sessionId = match[1];
    e.waitUntil((async () => {
      // User cancelled via notification UI. Abandon the whole multi
      // session — don't silently continue pulling more batches after
      // they explicitly said stop.
      const queue = await idbGet(BATCH_QUEUE_STORE, sessionId);
      if (queue) {
        await idbPut(EXTRACT_RESULTS_STORE, {
          sessionId,
          state: 'error',
          kind: 'multi',
          error: 'Cancelled by user',
          multiResults: queue.completedResults,
          completedBatches: queue.completedBatches,
          totalBatches: queue.totalBatches,
          failedAt: Date.now(),
        });
        await idbDelete(BATCH_QUEUE_STORE, sessionId);
      }
      broadcast({ type: 'EXTRACT_MULTI_ERROR', sessionId, error: 'Cancelled by user' });
    })());
    return;
  }

  const sessionId = id.replace(/^extract-/, '');
  e.waitUntil((async () => {
    await idbPut(EXTRACT_RESULTS_STORE, {
      sessionId, state: 'error',
      error: 'Extraction cancelled by user',
      failedAt: Date.now(),
    });
    broadcast({ type: 'EXTRACT_ERROR', sessionId, error: 'Extraction cancelled by user' });
  })());
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION CLICK HANDLER (Fix #3)
// ───────────────────────────────────────────────────────────────
// When the user taps a PolicyLens notification, focus an existing
// tab if one is open, or open a fresh tab to the app scope. Gives
// the notification a purpose — without this handler, tapping does
// nothing on Chrome Android.
// ═══════════════════════════════════════════════════════════════
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const scope = self.registration.scope;
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    // Prefer focusing an existing window
    for (const client of allClients) {
      if (client.url.startsWith(scope) && 'focus' in client) {
        return client.focus();
      }
    }
    // Otherwise open a new one
    if (self.clients.openWindow) {
      return self.clients.openWindow(scope);
    }
  })());
});

console.log('[SW] PolicyLens v1.0.3-tier2-multi loaded');

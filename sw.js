const SW_VERSION = 'v2.3.0-rc2d.15';
const DB_NAME = 'PolicyLensSW';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'sessionId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

async function putSession(session) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    tx.objectStore(SESSION_STORE).put({ ...session, updatedAt: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('IndexedDB put failed'));
  });
  db.close();
}

async function getSession(sessionId) {
  const db = await openDB();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readonly');
    const req = tx.objectStore(SESSION_STORE).get(sessionId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
  });
  db.close();
  return value;
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

function reply(event, payload) {
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(payload);
}

function extractGeminiText(payload) {
  if (!payload) return '';
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts.map((part) => part && typeof part.text === 'string' ? part.text : '').join('');
    if (text.trim()) return text;
  }
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.rawText === 'string') return payload.rawText;
  return JSON.stringify(payload);
}

async function postGemini(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers || { 'Content-Type': 'application/json' },
    body,
    mode: 'cors',
    cache: 'no-store',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ': ' + text.slice(0, 600));
  }
  let json;
  try { json = JSON.parse(text); }
  catch (_) { return text; }
  return extractGeminiText(json);
}

async function fetchJSON(url, request) {
  const response = await fetch(url, {
    method: request.method || 'POST',
    headers: request.headers || { 'Content-Type': 'application/json' },
    body: request.body,
    mode: 'cors',
    cache: 'no-store',
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    json,
    text: json ? null : text,
  };
}

async function runJSONFetch(sessionId, request) {
  try {
    const result = await fetchJSON(request.url, request);
    await broadcast({ type: 'FETCH_JSON_DONE', sessionId, result });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await broadcast({ type: 'FETCH_JSON_ERROR', sessionId, error: message });
  }
}

async function runSingle(sessionId, request) {
  const base = { sessionId, kind: 'single', state: 'pending', startedAt: Date.now() };
  await putSession(base);
  await broadcast({ type: 'EXTRACT_PROGRESS', sessionId, phase: 'started' });
  try {
    const rawText = await postGemini(request.url, request.headers, request.body);
    await putSession({ ...base, state: 'done', rawText, completedAt: Date.now() });
    await broadcast({ type: 'EXTRACT_DONE', sessionId, rawText });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await putSession({ ...base, state: 'error', error: message, completedAt: Date.now() });
    await broadcast({ type: 'EXTRACT_ERROR', sessionId, error: message });
  }
}

async function runMulti(sessionId, url, headers, bodies) {
  const totalBatches = Array.isArray(bodies) ? bodies.length : 0;
  const results = [];
  const base = {
    sessionId,
    kind: 'multi',
    state: 'pending',
    totalBatches,
    completedBatches: 0,
    multiResults: results,
    startedAt: Date.now(),
  };
  await putSession(base);
  await broadcast({ type: 'EXTRACT_MULTI_PROGRESS', sessionId, phase: 'started', completedBatches: 0, totalBatches });

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    try {
      await putSession({ ...base, completedBatches: batchIndex, multiResults: results, activeBatchIndex: batchIndex });
      await broadcast({ type: 'EXTRACT_MULTI_PROGRESS', sessionId, phase: 'batch_started', latestBatchIndex: batchIndex, completedBatches: batchIndex, totalBatches });
      const rawText = await postGemini(url, headers, bodies[batchIndex]);
      results[batchIndex] = { batchIndex, rawText };
      await putSession({ ...base, completedBatches: batchIndex + 1, multiResults: results });
      await broadcast({
        type: 'EXTRACT_MULTI_PROGRESS',
        sessionId,
        phase: 'batch_complete',
        latestBatchIndex: batchIndex,
        latestRawText: rawText,
        completedBatches: batchIndex + 1,
        totalBatches,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      results[batchIndex] = { batchIndex, error: message };
      await putSession({ ...base, completedBatches: batchIndex + 1, multiResults: results });
      await broadcast({
        type: 'EXTRACT_MULTI_PROGRESS',
        sessionId,
        phase: 'batch_error',
        latestBatchIndex: batchIndex,
        latestError: message,
        completedBatches: batchIndex + 1,
        totalBatches,
      });
    }
  }

  await putSession({ ...base, state: 'done', completedBatches: totalBatches, multiResults: results, completedAt: Date.now() });
  await broadcast({ type: 'EXTRACT_MULTI_DONE', sessionId, results, completedBatches: totalBatches, totalBatches });
}

async function pollSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return { sessionId, state: 'missing' };
  if (session.kind === 'multi') {
    return {
      sessionId,
      kind: 'multi',
      state: session.state,
      totalBatches: session.totalBatches || 0,
      completedBatches: session.completedBatches || 0,
      multiResults: session.multiResults || [],
      error: session.error || null,
    };
  }
  return {
    sessionId,
    kind: 'single',
    state: session.state,
    rawText: session.rawText || '',
    error: session.error || null,
  };
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (data.type === 'CHECK_SUPPORT') {
    reply(event, {
      version: SW_VERSION,
      bgFetch: !!(self.registration && self.registration.backgroundFetch),
      relayFetch: true,
      plainFetch: true,
    });
    return;
  }
  if (data.type === 'EXTRACT_POLL') {
    event.waitUntil((async () => {
      try { reply(event, await pollSession(data.sessionId)); }
      catch (error) { reply(event, { sessionId: data.sessionId, state: 'error', error: error.message || String(error) }); }
    })());
    return;
  }
  if (data.type === 'FETCH_JSON_RUN') {
    event.waitUntil(runJSONFetch(data.sessionId, data.request || {}));
    return;
  }
  if (data.type === 'EXTRACT_RUN') {
    event.waitUntil(runSingle(data.sessionId, data.request || {}));
    return;
  }
  if (data.type === 'EXTRACT_RUN_MULTI') {
    event.waitUntil(runMulti(data.sessionId, data.url, data.headers || { 'Content-Type': 'application/json' }, data.bodies || []));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) return clients[0].focus();
    return self.clients.openWindow('./');
  })());
});

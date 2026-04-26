// PolicyLens Document AI proxy for Cloudflare Workers.
//
// Google Document AI requires a service-account private key. GitHub Pages
// cannot keep that key secret, so the browser calls this Worker instead.
// This Worker is intentionally Document-AI-only for now. Gemini and Claude
// still use the existing PolicyLens per-user key path.
//
// Required Worker environment variables/secrets:
//   DOCUMENT_AI_PROJECT_ID=policylens-493014
//   DOCUMENT_AI_LOCATION=asia-southeast1
//   DOCUMENT_AI_PROCESSOR_ID=5cd43d57e6998638
//   DOCUMENT_AI_SERVICE_ACCOUNT_JSON=<full service account JSON as a secret>
//
// Optional hardening:
//   POLICYLENS_ALLOWED_ORIGIN=https://fundlens-sg.github.io
//   SUPABASE_URL=https://mgbxxwoasrwlraffcvab.supabase.co
//   SUPABASE_ANON_KEY=<PolicyLens Supabase anon key>

let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

function getAllowedOrigin(request, env) {
  const origin = request.headers.get('origin') || '*';
  const configured = (env.POLICYLENS_ALLOWED_ORIGIN || '*').trim();
  if (!configured || configured === '*') return '*';
  const allowed = configured.split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : allowed[0];
}

function corsHeaders(request, env) {
  return {
    'access-control-allow-origin': getAllowedOrigin(request, env),
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
  };
}

function jsonResponse(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {...JSON_HEADERS, ...corsHeaders(request, env)},
  });
}

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function requireAuthenticatedUser(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const auth = request.headers.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) throw new Error('Authentication required');

  const supabaseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const userResp = await fetch(supabaseUrl + '/auth/v1/user', {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: auth,
    },
  });
  const user = await userResp.json().catch(() => ({}));
  if (!userResp.ok || !user.id) throw new Error('Invalid PolicyLens session');

  const profileResp = await fetch(supabaseUrl + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=approved', {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: auth,
    },
  });
  if (profileResp.ok) {
    const profiles = await profileResp.json().catch(() => []);
    if (profiles.length && profiles[0].approved === false) {
      throw new Error('PolicyLens account is not approved');
    }
  }
  return user;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessTokenExp - 60 > now) return cachedAccessToken;

  if (!env.DOCUMENT_AI_SERVICE_ACCOUNT_JSON) {
    throw new Error('DOCUMENT_AI_SERVICE_ACCOUNT_JSON secret is not configured');
  }

  const serviceAccount = JSON.parse(env.DOCUMENT_AI_SERVICE_ACCOUNT_JSON);
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key');
  }

  const header = {alg: 'RS256', typ: 'JWT'};
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const unsigned = base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key.replace(/\\n/g, '\n')),
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    {name: 'RSASSA-PKCS1-v1_5'},
    key,
    new TextEncoder().encode(unsigned)
  );
  const assertion = unsigned + '.' + base64UrlEncode(signature);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok) {
    throw new Error('Google OAuth token exchange failed: ' + (tokenData.error_description || tokenData.error || tokenResp.status));
  }

  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenExp = now + (tokenData.expires_in || 3600);
  return cachedAccessToken;
}

function textFromAnchor(fullText, anchor) {
  const segments = anchor?.textSegments || [];
  if (!fullText || !segments.length) return '';
  return segments.map(seg => {
    const start = Number(seg.startIndex || 0);
    const end = Number(seg.endIndex || start);
    return fullText.slice(start, end);
  }).join('').replace(/\s+/g, ' ').trim();
}

function trimText(value, max) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) + '\n[truncated]' : text;
}

function normalizeDocument(document, fileName) {
  const fullText = document?.text || '';
  const pages = document?.pages || [];
  const entities = (document?.entities || []).map(e => ({
    type: e.type || '',
    mentionText: e.mentionText || textFromAnchor(fullText, e.textAnchor),
    confidence: e.confidence || null,
    normalizedText: e.normalizedValue?.text || '',
  })).filter(e => e.type || e.mentionText);

  const formFields = [];
  const tables = [];

  pages.forEach((page, pageIndex) => {
    (page.formFields || []).forEach(field => {
      const name = textFromAnchor(fullText, field.fieldName?.textAnchor);
      const value = textFromAnchor(fullText, field.fieldValue?.textAnchor);
      if (name || value) formFields.push({page: pageIndex + 1, name, value});
    });

    (page.tables || []).forEach((table, tableIndex) => {
      const toRows = rows => (rows || []).map(row => (row.cells || []).map(cell =>
        textFromAnchor(fullText, cell.layout?.textAnchor)
      ));
      tables.push({
        page: pageIndex + 1,
        index: tableIndex + 1,
        headers: toRows(table.headerRows),
        rows: toRows(table.bodyRows),
      });
    });
  });

  const lines = [];
  lines.push('[Google Document AI Form Parser: ' + (fileName || 'uploaded document') + ']');
  lines.push('');
  if (fullText.trim()) {
    lines.push('FULL OCR TEXT');
    lines.push(trimText(fullText.trim(), 90000));
    lines.push('');
  }
  if (entities.length) {
    lines.push('DOCUMENT AI ENTITIES');
    for (const e of entities.slice(0, 200)) {
      lines.push('- ' + [e.type, e.mentionText, e.normalizedText].filter(Boolean).join(': '));
    }
    lines.push('');
  }
  if (formFields.length) {
    lines.push('FORM FIELDS');
    for (const f of formFields.slice(0, 300)) {
      lines.push('- Page ' + f.page + ': ' + (f.name || '(blank)') + ' = ' + (f.value || '(blank)'));
    }
    lines.push('');
  }
  if (tables.length) {
    lines.push('TABLES');
    for (const t of tables.slice(0, 40)) {
      lines.push('Table ' + t.index + ' on page ' + t.page);
      const rows = [...(t.headers || []), ...(t.rows || [])].slice(0, 80);
      for (const row of rows) lines.push(row.map(cell => String(cell || '').replace(/\|/g, '/')).join(' | '));
      lines.push('');
    }
  }

  return {
    text: trimText(lines.join('\n').trim(), 120000),
    rawTextLength: fullText.length,
    pageCount: pages.length,
    entityCount: entities.length,
    formFieldCount: formFields.length,
    tableCount: tables.length,
    entities,
    formFields,
    tables,
  };
}

async function processWithDocumentAI(request, env) {
  await requireAuthenticatedUser(request, env);
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== 'object') throw new Error('Expected JSON body');

  const fileName = String(payload.fileName || 'document').slice(0, 180);
  const mimeType = String(payload.mimeType || '').trim();
  const content = String(payload.content || '').trim();
  if (!mimeType || !content) throw new Error('Missing mimeType or base64 content');

  const projectId = env.DOCUMENT_AI_PROJECT_ID;
  const location = env.DOCUMENT_AI_LOCATION;
  const processorId = env.DOCUMENT_AI_PROCESSOR_ID;
  if (!projectId || !location || !processorId) {
    throw new Error('Document AI project/location/processor env vars are not configured');
  }

  const accessToken = await getAccessToken(env);
  const endpoint = 'https://' + location + '-documentai.googleapis.com/v1/projects/' +
    encodeURIComponent(projectId) + '/locations/' + encodeURIComponent(location) +
    '/processors/' + encodeURIComponent(processorId) + ':process';

  const aiResp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + accessToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      rawDocument: {content, mimeType},
    }),
  });
  const aiData = await aiResp.json().catch(() => ({}));
  if (!aiResp.ok) {
    const detail = aiData.error?.message || aiData.error?.status || aiResp.statusText || aiResp.status;
    throw new Error('Document AI process failed (' + aiResp.status + '): ' + detail);
  }

  const normalized = normalizeDocument(aiData.document || {}, fileName);
  return {
    ok: true,
    processor: {
      projectId,
      location,
      processorId,
      type: 'form-parser',
    },
    fileName,
    mimeType,
    ...normalized,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: corsHeaders(request, env)});
    }
    if (request.method === 'GET') {
      return jsonResponse(request, env, {
        ok: true,
        service: 'policylens-document-ai-proxy',
        configured: !!(env.DOCUMENT_AI_PROJECT_ID && env.DOCUMENT_AI_LOCATION && env.DOCUMENT_AI_PROCESSOR_ID && env.DOCUMENT_AI_SERVICE_ACCOUNT_JSON),
        documentAI: !!(env.DOCUMENT_AI_PROJECT_ID && env.DOCUMENT_AI_LOCATION && env.DOCUMENT_AI_PROCESSOR_ID && env.DOCUMENT_AI_SERVICE_ACCOUNT_JSON),
        authRequired: !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
      });
    }
    if (request.method !== 'POST') {
      return jsonResponse(request, env, {ok: false, error: 'Method not allowed'}, 405);
    }
    try {
      const result = await processWithDocumentAI(request, env);
      return jsonResponse(request, env, result);
    } catch (err) {
      console.error('[DocumentAIProxy]', err);
      return jsonResponse(request, env, {ok: false, error: err?.message || String(err)}, 500);
    }
  },
};

import { createServer } from 'node:http';
import { getImportEvent } from './imports.js';
import { identifyPushOwner, receivePush } from './push-credentials.js';
import { handleAdmin } from './admin-ui.js';
import { localSnapshot, acceptLocalTransaction } from './local-sync.js';
import { readFileSync } from 'node:fs';

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16_384) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON'); }
}

export function createImportApi(book, { auth } = {}) {
  return createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const assets = new Map([
      ['/app', ['../public/index.html', 'text/html; charset=utf-8']],
      ['/app/', ['../public/index.html', 'text/html; charset=utf-8']],
      ['/app/app.js', ['../public/app.js', 'text/javascript; charset=utf-8']],
      ['/app/sw.js', ['../public/sw.js', 'text/javascript; charset=utf-8']],
      ['/app/manifest.json', ['../public/manifest.json', 'application/manifest+json']],
      ['/app/icon.svg', ['../public/icon.svg', 'image/svg+xml']],
      ['/app/icon-192.png', ['../public/icon-192.png', 'image/png']],
      ['/app/icon-512.png', ['../public/icon-512.png', 'image/png']],
    ]);
    if (req.method === 'GET' && assets.has(pathname)) {
      const [path, contentType] = assets.get(pathname);
      res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(readFileSync(new URL(path, import.meta.url))); return;
    }
    if (pathname === '/healthz' && req.method === 'GET') {
      try {
        book.db.prepare('SELECT 1').get();
        res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end();
      } catch { json(res, 503, { error: 'Unavailable' }); }
      return;
    }
    if (auth) {
      try { if (await handleAdmin(book, auth, req, res, pathname)) return; }
      catch { return json(res, 503, { error: 'Login temporarily unavailable' }); }
    }
    if (pathname === '/api/v1/local/state' && req.method === 'GET') {
      const session = auth?.session(req);
      if (!session) return json(res, 401, { error: 'Login required' });
      return json(res, 200, { ...localSnapshot(book, session.sub), csrf: session.csrf });
    }
    if (pathname === '/api/v1/local/transactions' && req.method === 'POST') {
      const session = auth?.session(req);
      if (!session) return json(res, 401, { error: 'Login required' });
      if (!req.headers['content-type']?.startsWith('application/json')) {
        return json(res, 415, { error: 'JSON required' });
      }
      if (req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'CSRF failed' });
      try {
        const { entry, duplicate } = acceptLocalTransaction(book, session.sub, await readBody(req));
        return json(res, duplicate ? 200 : 201, { id: entry.id, duplicate });
      } catch (error) {
        return json(res, /reload before editing/.test(error.message) ? 409 : 400,
          { error: error.message });
      }
    }
    if (pathname.startsWith('/admin/') || pathname.startsWith('/auth/')) {
      return json(res, 503, { error: 'Pocket ID login is not configured' });
    }
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    if (pathname === '/api/v1/push-events' && req.method === 'POST') {
      const apiKey = match?.[1];
      if (!apiKey) return json(res, 401, { error: 'Unauthorized' });
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }
      try {
        const body = await readBody(req);
        const owner = identifyPushOwner(book, apiKey, body?.accountKey);
        if (!owner) return json(res, 401, { error: 'Unauthorized' });
        const { event, duplicate } = await receivePush(book, owner, body, req.headers['idempotency-key']);
        return json(res, duplicate ? 200 : 202, { id: event.id, status: event.status, duplicate,
          ...(event.parseError ? { parseError: event.parseError } : {}),
        }, { Location: `/api/v1/push-events/${event.id}` });
      } catch (error) {
        const conflict = error.message === 'Duplicate key with different payload';
        return json(res, conflict ? 409 : 400, { error: conflict ? error.message : 'Invalid request' });
      }
    }
    const pushId = /^\/api\/v1\/push-events\/([0-9a-f-]{36})$/.exec(pathname)?.[1];
    if (pushId && req.method === 'GET') {
      const owner = identifyPushOwner(book, match?.[1], req.headers['x-account-key']);
      if (!owner) return json(res, 401, { error: 'Unauthorized' });
      const event = getImportEvent(book, { id: `push:${owner.keyId}` }, pushId);
      return event ? json(res, 200, event) : json(res, 404, { error: 'Not found' });
    }
    return json(res, 404, { error: 'Not found' });
  });
}

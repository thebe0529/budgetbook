import { createServer } from 'node:http';
import { authenticateImportChannel, getImportEvent, receiveImport } from './imports.js';

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

export function createImportApi(book) {
  return createServer(async (req, res) => {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    const channel = authenticateImportChannel(book, match?.[1]);
    if (!channel) return json(res, 401, { error: 'Unauthorized' });
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'POST' && pathname === '/api/v1/import-events') {
        if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          return json(res, 415, { error: 'Content-Type must be application/json' });
        }
        const { event, duplicate } = receiveImport(book, channel, await readBody(req),
          req.headers['idempotency-key']);
        return json(res, duplicate ? 200 : 202,
          { id: event.id, status: event.status, duplicate }, { Location: `/api/v1/import-events/${event.id}` });
      }
      const eventId = /^\/api\/v1\/import-events\/([0-9a-f-]{36})$/.exec(pathname)?.[1];
      if (req.method === 'GET' && eventId) {
        const event = getImportEvent(book, channel, eventId);
        return event ? json(res, 200, event) : json(res, 404, { error: 'Not found' });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error.message === 'Duplicate key with different payload') return json(res, 409, { error: error.message });
      if (['Valid Idempotency-Key required', 'rawText and optional externalId required',
        'Request body too large', 'Invalid JSON'].includes(error.message)) return json(res, 400, { error: error.message });
      return json(res, 500, { error: 'Internal server error' });
    }
  });
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function createImportChannel(book, { id = randomUUID(), name, accountId }) {
  if (!name?.trim() || !book.accounts().has(accountId)) throw new Error('Channel needs name and known account');
  const token = randomBytes(32).toString('base64url');
  book.db.prepare(`INSERT INTO import_channels (id, account_id, token_hash, name)
    VALUES (?, ?, ?, ?)`).run(id, accountId, sha256(token), name);
  return { id, name, accountId, token }; // Display token once; database holds only its digest.
}

export function revokeImportChannel(book, id) {
  return book.db.prepare('UPDATE import_channels SET revoked = 1 WHERE id = ?').run(id).changes === 1;
}

export function authenticateImportChannel(book, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = Buffer.from(sha256(token), 'hex');
  // Compare the candidate against every active digest in constant time per digest.
  for (const row of book.db.prepare('SELECT * FROM import_channels WHERE revoked = 0').all()) {
    if (timingSafeEqual(hash, Buffer.from(row.token_hash, 'hex'))) {
      return { id: row.id, name: row.name, accountId: row.account_id };
    }
  }
  return null;
}

export function receiveImport(book, channel, input, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128 ||
    !/^[\x21-\x7e]+$/.test(idempotencyKey)) throw new Error('Valid Idempotency-Key required');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    typeof input.rawText !== 'string' || input.rawText.length < 1 || input.rawText.length > 10_000 ||
    (input.externalId !== undefined && (typeof input.externalId !== 'string' ||
      input.externalId.length < 1 || input.externalId.length > 200))) {
    throw new Error('rawText and optional externalId required');
  }
  const payload = { rawText: input.rawText, externalId: input.externalId ?? null };
  const payloadHash = sha256(JSON.stringify(payload));
  const existing = book.db.prepare(`SELECT data, payload_hash FROM import_events
    WHERE channel_id = ? AND (idempotency_key = ? OR (external_id IS NOT NULL AND external_id = ?))`)
    .get(channel.id, idempotencyKey, payload.externalId);
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new Error('Duplicate key with different payload');
    return { event: JSON.parse(existing.data), duplicate: true };
  }
  const event = { id: randomUUID(), channelId: channel.id, accountId: channel.accountId,
    status: 'pending-review', receivedAt: new Date().toISOString(), ...payload };
  try {
    book.db.prepare(`INSERT INTO import_events
      (id, channel_id, idempotency_key, external_id, payload_hash, data)
      VALUES (?, ?, ?, ?, ?, ?)`).run(event.id, channel.id, idempotencyKey,
        payload.externalId, payloadHash, JSON.stringify(event));
  } catch (error) {
    // Handles concurrent retries: reread the row after a unique-key collision.
    if (!String(error.code).startsWith('SQLITE_CONSTRAINT')) throw error;
    const raced = book.db.prepare(`SELECT data, payload_hash FROM import_events
      WHERE channel_id = ? AND (idempotency_key = ? OR (external_id IS NOT NULL AND external_id = ?))`)
      .get(channel.id, idempotencyKey, payload.externalId);
    if (!raced || raced.payload_hash !== payloadHash) throw new Error('Duplicate key with different payload');
    return { event: JSON.parse(raced.data), duplicate: true };
  }
  return { event, duplicate: false };
}

export function getImportEvent(book, channel, id) {
  const row = book.db.prepare('SELECT data FROM import_events WHERE id = ? AND channel_id = ?')
    .get(id, channel.id);
  return row ? JSON.parse(row.data) : null;
}

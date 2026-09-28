import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { validatePatterns, parsePush } from './push-parser.js';
import { receiveImport } from './imports.js';

const digest = secret => createHash('sha256').update(secret).digest('hex');
const randomKey = () => randomBytes(32).toString('base64url');

export function issueApiKey(book, userSub) {
  if (!userSub || typeof userSub !== 'string') throw new Error('User subject is required');
  const id = randomUUID();
  const key = randomKey();
  book.db.prepare('INSERT INTO user_api_keys (id, user_sub, token_hash) VALUES (?, ?, ?)')
    .run(id, userSub, digest(key));
  return { id, key };
}

export function issueAccountKey(book, userSub, accountId) {
  if (!userSub || !book.accounts().has(accountId)) throw new Error('Unknown user or account');
  const id = randomUUID();
  const key = randomKey();
  book.db.prepare('INSERT INTO account_keys (id, user_sub, account_id, token_hash) VALUES (?, ?, ?, ?)')
    .run(id, userSub, accountId, digest(key));
  return { id, key, accountId };
}

function matchSecret(book, table, key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const supplied = Buffer.from(digest(key), 'hex');
  for (const row of book.db.prepare(`SELECT * FROM ${table} WHERE revoked = 0`).all()) {
    if (timingSafeEqual(supplied, Buffer.from(row.token_hash, 'hex'))) return row;
  }
  return null;
}

export function identifyPushOwner(book, apiKey, accountKey) {
  const user = matchSecret(book, 'user_api_keys', apiKey);
  const account = matchSecret(book, 'account_keys', accountKey);
  return user && account?.user_sub === user.user_sub ?
    { userSub: user.user_sub, accountId: account.account_id, keyId: account.id } : null;
}

export function saveParserRules(book, userSub, accountId, patterns) {
  if (!userSub || !book.accounts().has(accountId)) throw new Error('Unknown user or account');
  validatePatterns(patterns);
  book.db.prepare(`INSERT INTO parser_rules (user_sub, account_id, patterns) VALUES (?, ?, ?)
    ON CONFLICT(user_sub, account_id) DO UPDATE SET patterns=excluded.patterns`)
    .run(userSub, accountId, JSON.stringify(patterns));
}

export function getParserRules(book, userSub, accountId) {
  const row = book.db.prepare('SELECT patterns FROM parser_rules WHERE user_sub = ? AND account_id = ?')
    .get(userSub, accountId);
  return row ? JSON.parse(row.patterns) : null;
}

export async function receivePush(book, owner, { accountKey, rawText, externalId }, idempotencyKey) {
  if (!accountKey || typeof rawText !== 'string' || rawText.length < 1 || rawText.length > 10_000) {
    throw new Error('accountKey and rawText required');
  }
  const channel = { id: `push:${owner.keyId}`, accountId: owner.accountId };
  const result = receiveImport(book, channel, { rawText, externalId }, idempotencyKey);
  if (result.duplicate) return result;
  const patterns = getParserRules(book, owner.userSub, owner.accountId);
  const event = result.event;
  try {
    if (!patterns) throw new Error('No parser rules configured');
    event.parsed = await parsePush(patterns, rawText);
    event.status = 'parsed-pending-review';
  } catch (error) {
    event.parseError = error.message;
    event.status = 'parse-error';
  }
  book.db.prepare('UPDATE import_events SET data = ? WHERE id = ?')
    .run(JSON.stringify(event), event.id);
  return { event, duplicate: false };
}

export function revokeKey(book, type, id, userSub) {
  const table = type === 'api' ? 'user_api_keys' : type === 'account' ? 'account_keys' : null;
  if (!table) throw new Error('Unknown key type');
  return book.db.prepare(`UPDATE ${table} SET revoked = 1 WHERE id = ? AND user_sub = ?`)
    .run(id, userSub).changes === 1;
}

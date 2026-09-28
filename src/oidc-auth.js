import * as oidc from 'openid-client';
import { createHash, randomBytes } from 'node:crypto';
import { ensureOwner, member } from './members.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const cookieValue = (req, name) => (req.headers.cookie ?? '').split('; ')
  .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);

export function createOidcAuth(book, { issuer, clientId, clientSecret, redirectUri, ownerSub }) {
  if (![issuer, clientId, clientSecret, redirectUri, ownerSub].every(Boolean)) {
    throw new Error('OIDC issuer, client ID, secret, redirect URI and owner subject required');
  }
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost' && redirect.hostname !== '127.0.0.1') {
    throw new Error('OIDC redirect must use HTTPS');
  }
  ensureOwner(book, ownerSub);
  let configuration;
  const config = () => configuration ??= oidc.discovery(new URL(issuer), clientId, clientSecret);
  const secure = redirect.protocol === 'https:' ? '; Secure' : '';
  const cookie = (name, value, maxAge, path = '/') =>
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`;
  return {
    ownerSub,
    async start(res) {
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const binding = secret();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      book.db.prepare(`INSERT INTO oidc_pending (state, binding_hash, verifier, nonce, expires_at)
        VALUES (?, ?, ?, ?, ?)`).run(state, hash(binding), verifier, nonce, Date.now() + 300_000);
      const url = oidc.buildAuthorizationUrl(await config(), { redirect_uri: redirectUri,
        scope: 'openid profile', state, nonce, code_challenge: challenge,
        code_challenge_method: 'S256' });
      res.writeHead(302, { Location: url.href,
        'Set-Cookie': cookie('bb_login', binding, 300, '/auth/callback'), 'Cache-Control': 'no-store' });
      res.end();
    },
    async callback(req, res) {
      const current = new URL(req.url, redirectUri);
      const state = current.searchParams.get('state');
      const pending = state && book.db.prepare('SELECT * FROM oidc_pending WHERE state = ?').get(state);
      book.db.prepare('DELETE FROM oidc_pending WHERE state = ?').run(state ?? '');
      if (!pending || pending.expires_at < Date.now() ||
        hash(cookieValue(req, 'bb_login') ?? '') !== pending.binding_hash) throw new Error('Invalid login state');
      const tokens = await oidc.authorizationCodeGrant(await config(), current, {
        pkceCodeVerifier: pending.verifier, expectedState: state,
        expectedNonce: pending.nonce, idTokenExpected: true });
      const sub = tokens.claims()?.sub;
      if (!sub || !member(book, sub)) throw new Error('User is not authorized for this book');
      const token = secret();
      book.db.prepare(`INSERT INTO user_sessions (token_hash, user_sub, csrf, expires_at)
        VALUES (?, ?, ?, ?)`).run(hash(token), sub, secret(), Date.now() + 12 * 60 * 60 * 1000);
      res.writeHead(302, { Location: '/admin/regex', 'Set-Cookie': [
        cookie('bb_login', '', 0, '/auth/callback'), cookie('bb_session', token, 12 * 60 * 60)],
        'Cache-Control': 'no-store' });
      res.end();
    },
    session(req) {
      const value = cookieValue(req, 'bb_session');
      if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
      const session = book.db.prepare('SELECT * FROM user_sessions WHERE token_hash = ?').get(hash(value));
      const person = session && member(book, session.user_sub);
      return session?.expires_at > Date.now() && person ?
        { sub: session.user_sub, role: person.role, csrf: session.csrf } : null;
    },
    logout(req, res) {
      const value = cookieValue(req, 'bb_session');
      if (value) book.db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hash(value));
      res.writeHead(302, { Location: '/auth/login',
        'Set-Cookie': cookie('bb_session', '', 0), 'Cache-Control': 'no-store' });
      res.end();
    },
  };
}

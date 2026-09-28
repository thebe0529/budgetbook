import { Book } from '../src/book.js';
import { createImportApi } from '../src/import-api.js';
import { createOidcAuth } from '../src/oidc-auth.js';

const filename = process.env.BUDGETBOOK_DB;
if (!filename) throw new Error('BUDGETBOOK_DB must point to an existing configured ledger database');
const book = new Book(filename);
const host = process.env.BUDGETBOOK_HOST ?? '127.0.0.1';
const port = Number(process.env.BUDGETBOOK_PORT ?? 38181);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BUDGETBOOK_PORT');
const oidcSettings = ['BUDGETBOOK_OIDC_ISSUER', 'BUDGETBOOK_OIDC_CLIENT_ID',
  'BUDGETBOOK_OIDC_CLIENT_SECRET', 'BUDGETBOOK_OIDC_REDIRECT_URI', 'BUDGETBOOK_OWNER_SUB'];
const configured = oidcSettings.map(name => Boolean(process.env[name]));
if (configured.some(Boolean) && !configured.every(Boolean)) {
  throw new Error(`Incomplete Pocket ID settings: ${oidcSettings.join(', ')}`);
}
const auth = configured.every(Boolean) ? createOidcAuth(book, {
  issuer: process.env.BUDGETBOOK_OIDC_ISSUER,
  clientId: process.env.BUDGETBOOK_OIDC_CLIENT_ID,
  clientSecret: process.env.BUDGETBOOK_OIDC_CLIENT_SECRET,
  redirectUri: process.env.BUDGETBOOK_OIDC_REDIRECT_URI,
  ownerSub: process.env.BUDGETBOOK_OWNER_SUB,
}) : null;
const server = createImportApi(book, { auth });
server.listen(port, host, () => console.log(`Import API listening at ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { book.close(); process.exit(0); }));
}

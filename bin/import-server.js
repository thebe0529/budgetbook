import { Book } from '../src/book.js';
import { createImportApi } from '../src/import-api.js';

const filename = process.env.BUDGETBOOK_DB;
if (!filename) throw new Error('BUDGETBOOK_DB must point to an existing configured ledger database');
const book = new Book(filename);
const host = process.env.BUDGETBOOK_HOST ?? '127.0.0.1';
const port = Number(process.env.BUDGETBOOK_PORT ?? 38181);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BUDGETBOOK_PORT');
const server = createImportApi(book);
server.listen(port, host, () => console.log(`Import API listening at ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { book.close(); process.exit(0); }));
}

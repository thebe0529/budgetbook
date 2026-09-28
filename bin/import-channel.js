import { Book } from '../src/book.js';
import { createImportChannel, revokeImportChannel } from '../src/imports.js';

const filename = process.env.BUDGETBOOK_DB;
if (!filename) throw new Error('BUDGETBOOK_DB is required');
const book = new Book(filename);
try {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'create' && first && second) {
    const channel = createImportChannel(book, { accountId: first, name: second });
    console.log(JSON.stringify(channel)); // Copy token securely; it cannot be retrieved later.
  } else if (command === 'revoke' && first) {
    if (!revokeImportChannel(book, first)) throw new Error('Channel not found');
    console.log('Revoked');
  } else {
    throw new Error('Usage: import-channel.js create ACCOUNT_ID NAME | revoke CHANNEL_ID');
  }
} finally { book.close(); }

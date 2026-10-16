import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { forecast, saveSchedule, linkOccurrence, linkedOccurrences, disableSchedule, listSchedules } from '../src/forecast.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner'); setMember(book, 'owner', 'viewer', 'viewer', []);
  book.createAccount({ id: 'bank', name: '은행', type: 'asset', cash: true });
  book.createAccount({ id: 'income', name: '수입', type: 'income' });
  return book;
}
const schedule = (book, startDate, overrides = {}) => saveSchedule(book, 'owner', { accountId: 'bank', name: '<월급 & 예상>', amountExpression: '1000', startDate, frequency: 'once', ...overrides });
const args = { asOf: '2026-10-01', throughDate: '2027-01-31' };
function actual(book, date = '2026-10-16') {
  return book.record({ id: randomUUID(), date, postings: [{ accountId: 'bank', side: 'debit', amount: 1000 }, { accountId: 'income', side: 'credit', amount: 1000 }] });
}

test('one-time offsets include dates crossing forecast boundaries and combine with amount simulations without writes', () => {
  const book = setup();
  try {
    const delayed = schedule(book, '2026-09-30'); const advanced = schedule(book, '2026-11-02');
    const unchanged = schedule(book, '2026-10-15'); const before = listSchedules(book, 'owner');
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const result = forecast(book, 'owner', { asOf: '2026-10-01', throughDate: '2026-10-31', dayOffsets: { [delayed.id]: '2', [advanced.id]: -2 }, overrides: { [delayed.id]: '2000+500' } });
    assert.deepEqual(result.events.map(row => [row.date, row.originalDate, row.amount]), [['2026-10-02', '2026-09-30', 2500], ['2026-10-15', undefined, 1000], ['2026-10-31', '2026-11-02', 1000]]);
    assert.equal(result.projectedTotal, 4500); assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.deepEqual(listSchedules(book, 'owner'), before); assert.equal(book.entries().length, 0);
    const excluded = forecast(book, 'owner', { asOf: '2026-10-01', throughDate: '2026-10-31', dayOffsets: { [unchanged.id]: -14 } });
    assert.equal(excluded.events.length, 0); // A shifted occurrence on asOf is outside the projected window.
  } finally { book.close(); }
});

test('monthly offsets preserve original month-end recurrence and end date while shifting into later months', () => {
  const book = setup();
  try {
    const source = schedule(book, '2028-01-31', { frequency: 'monthly', endDate: '2028-04-30' });
    const result = forecast(book, 'owner', { asOf: '2028-02-01', throughDate: '2028-05-10', dayOffsets: { [source.id]: 3 } });
    assert.deepEqual(result.events.map(row => [row.originalDate, row.date]), [['2028-01-31', '2028-02-03'], ['2028-02-29', '2028-03-03'], ['2028-03-31', '2028-04-03'], ['2028-04-30', '2028-05-03']]);
    assert.equal(listSchedules(book, 'owner')[0].endDate, '2028-04-30');
  } finally { book.close(); }
});

test('maximum advances and delays cover all monthly occurrences across the full ten-year forecast horizon', () => {
  const book = setup();
  try {
    const source = schedule(book, '2020-01-15', { frequency: 'monthly' });
    for (const days of [-366, 366]) {
      const expected = [];
      for (let index = 0; index < 220; index++) {
        const original = new Date(Date.UTC(2020, index, 15)); const shifted = new Date(original.getTime() + days * 86400000);
        const date = shifted.toISOString().slice(0, 10);
        if (date > '2026-10-31' && date <= '2036-10-31') expected.push([date, original.toISOString().slice(0, 10)]);
      }
      const result = forecast(book, 'owner', { asOf: '2026-10-31', throughDate: '2036-10-31', dayOffsets: { [source.id]: days } });
      assert.deepEqual(result.events.map(row => [row.date, row.originalDate]), expected);
      assert.equal(result.projectedTotal, expected.length * 1000);
    }
  } finally { book.close(); }
});

test('actual links suppress the original occurrence regardless of simulated date or amount and booked dates stay fixed', () => {
  const book = setup();
  try {
    const source = schedule(book, '2026-10-15'); const entry = actual(book);
    const options = { ...args, dayOffsets: { [source.id]: 90 }, overrides: { [source.id]: '5000' } };
    const before = forecast(book, 'owner', options);
    assert.deepEqual(before.events.map(row => [row.type, row.date, row.amount]), [['booked', '2026-10-16', 1000], ['schedule', '2027-01-13', 5000]]);
    linkOccurrence(book, 'owner', { scheduleId: source.id, date: '2026-10-15', entryId: entry.id });
    const after = forecast(book, 'owner', options);
    assert.equal(after.events.length, 1); assert.equal(after.events[0].type, 'booked'); assert.equal(after.events[0].date, '2026-10-16');
    assert.equal(linkedOccurrences(book, 'owner')[0].occurrence_date, '2026-10-15');
  } finally { book.close(); }
});

test('offset validation rejects unknown or inactive schedules, fractional days and unsupported ranges', () => {
  const book = setup();
  try {
    const source = schedule(book, '2026-10-15');
    for (const days of [367, -367, 0.5, true, null, [1], {}, '01', '1e2', '1.0', '']) assert.throws(() => forecast(book, 'owner', { ...args, dayOffsets: { [source.id]: days } }), /offset/);
    for (const dayOffsets of [null, [], { unknown: 0 }]) assert.throws(() => forecast(book, 'owner', { ...args, dayOffsets }), /offset/);
    assert.throws(() => forecast(book, 'viewer', { ...args, dayOffsets: { [source.id]: 2 } }), /Owner/);
    disableSchedule(book, 'owner', source.id);
    assert.throws(() => forecast(book, 'owner', { ...args, dayOffsets: { [source.id]: 0 } }), /offset/);
    assert.equal(forecast(book, 'owner', args).events.length, 0);
  } finally { book.close(); }
});

test('HTTP simulation shows original dates, links and auto-matches original occurrences and preserves offsets after actions', async () => {
  const book = setup(); const source = schedule(book, '2026-10-15'); const entry = actual(book); let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/forecast`;
  const context = { ...args, cardMode: 'exclude', [`amount_${source.id}`]: '1000', [`offset_${source.id}`]: '90' };
  const input = { ...context, csrf: 'token', scheduleId: source.id, date: '2026-10-15', entryId: entry.id };
  const post = (path, values) => fetch(base + path, { method: 'POST', body: new URLSearchParams(values) });
  try {
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const html = await (await fetch(`${base}?${new URLSearchParams(context)}`)).text();
    assert.match(html, /&lt;월급 &amp; 예상&gt;/); assert.match(html, /원래 예정일 2026-10-15/); assert.match(html, /2027-01-13/);
    assert.match(html, /name="date" value="2026-10-15"/); assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.equal((await post('/link', { ...input, [`offset_${source.id}`]: '999' })).status, 400); assert.equal(linkedOccurrences(book, 'owner').length, 0);
    assert.equal((await post('/link', { ...input, csrf: 'bad' })).status, 403);
    sub = 'viewer'; assert.equal((await fetch(`${base}?${new URLSearchParams(context)}`)).status, 400); sub = 'owner';
    const linked = await post('/link', input); assert.equal(linked.status, 200);
    assert.ok((await linked.text()).includes(`name="offset_${source.id}" min="-366" max="366" step="1" value="90"`));
    assert.equal(linkedOccurrences(book, 'owner')[0].occurrence_date, '2026-10-15');
    const unlinked = await post('/unlink', input); assert.equal(unlinked.status, 200); assert.match(await unlinked.text(), /원래 예정일 2026-10-15/);
    const automatic = await post('/auto-link', input); assert.equal(automatic.status, 200);
    assert.ok((await automatic.text()).includes(`name="offset_${source.id}" min="-366" max="366" step="1" value="90"`));
    assert.equal(linkedOccurrences(book, 'owner')[0].entry_id, entry.id);
    assert.equal(listSchedules(book, 'owner')[0].startDate, '2026-10-15');
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

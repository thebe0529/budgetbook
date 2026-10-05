import test from 'node:test';
import assert from 'node:assert/strict';
import { setupManualEntry } from '../src/manual-entry-ui.js';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createImportApi } from '../src/import-api.js';

function target() {
  const listeners = new Map();
  return { addEventListener(name, fn) { listeners.set(name, fn); }, emit(name, event = {}) { listeners.get(name)?.(event); } };
}
function fixture(onBudget = true) {
  const fields = Object.fromEntries(['kind', 'counterId', 'categoryId', 'amountExpression', 'memo'].map(name => [name,
    { ...target(), value: '', disabled: false, focused: 0, focus() { this.focused++; } }]));
  fields.kind.value = 'expense'; fields.categoryId.value = 'food'; fields.counterId.value = 'salary';
  fields.counterId.options = [['expense', 'expense'], ['salary', 'income'], ['other', 'asset'], ['card', 'liability'], ['equity', 'equity']]
    .map(([value, counterType]) => ({ value, dataset: { counterType } }));
  const button = { textContent: '거래 저장', disabled: false };
  const surface = target();
  const form = { ...target(), dataset: { onBudget: String(onBudget), focusAfterSave: 'true' },
    elements: { namedItem: name => fields[name] }, querySelector: () => button, requests: 0,
    requestSubmit() { this.requests++; } };
  setupManualEntry(form, surface);
  return { form, fields, surface, button };
}
function key(target, values = {}) {
  return { key: 'Enter', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
}

test('manual entry shortcuts move to memo and request native validation without affecting unrelated inputs', () => {
  const { form, fields } = fixture();
  assert.equal(fields.amountExpression.focused, 1);
  const amount = key(fields.amountExpression); form.emit('keydown', amount);
  assert.equal(fields.memo.focused, 1); assert.equal(form.requests, 0); assert.equal(amount.defaultPrevented, true);
  form.emit('keydown', key(fields.memo)); assert.equal(form.requests, 1);
  form.emit('keydown', key(fields.kind, { ctrlKey: true })); assert.equal(form.requests, 2);
  form.emit('keydown', key(fields.kind, { metaKey: true })); assert.equal(form.requests, 3);
  const select = key(fields.kind); form.emit('keydown', select); assert.equal(select.defaultPrevented, false);
  form.emit('keydown', key(fields.memo, { shiftKey: true })); assert.equal(form.requests, 3);
});

test('IME composition, held keys and prevented events never trigger shortcut saves', () => {
  const { form, fields } = fixture();
  for (const overrides of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true },
    { ctrlKey: true, altKey: true }, { key: 'Tab' }]) form.emit('keydown', key(fields.memo, overrides));
  assert.equal(form.requests, 0);
  form.emit('compositionstart'); form.emit('keydown', key(fields.memo, { ctrlKey: true })); assert.equal(form.requests, 0);
  form.emit('compositionend'); form.emit('keydown', key(fields.memo)); assert.equal(form.requests, 1);
});

test('type changes limit counterpart options and clear inapplicable categories without losing valid defaults', () => {
  const { fields } = fixture();
  assert.equal(fields.counterId.value, 'expense'); assert.equal(fields.categoryId.disabled, false); assert.equal(fields.categoryId.value, 'food');
  for (const [kind, expected] of [['income', 'salary'], ['transfer', 'other'], ['opening', 'equity'], ['expense', 'expense']]) {
    fields.kind.value = kind; fields.kind.emit('change'); assert.equal(fields.counterId.value, expected);
    assert.ok(fields.counterId.options.find(option => option.value === expected).disabled === false);
  }
  assert.equal(fields.categoryId.value, ''); assert.equal(fixture(false).fields.categoryId.disabled, true);
});

test('duplicate submit is blocked until browser back restores the form, while canceled submit remains usable', () => {
  const { form, fields, surface, button } = fixture();
  form.emit('submit', { defaultPrevented: true }); assert.equal(button.disabled, false);
  form.emit('submit', { defaultPrevented: false }); assert.equal(button.disabled, true); assert.equal(button.textContent, '저장 중…');
  const second = key(fields.memo); form.emit('submit', second); assert.equal(second.defaultPrevented, true);
  form.emit('keydown', key(fields.memo)); assert.equal(form.requests, 0);
  surface.emit('pageshow'); assert.equal(button.disabled, false); assert.equal(button.textContent, '거래 저장');
  form.emit('keydown', key(fields.memo)); assert.equal(form.requests, 1);
});

test('HTTP continued entry preserves valid conditions, clears amount and memo and generates a fresh idempotency key', async () => {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['expense', 'expense'], ['salary', 'income'], ['equity', 'equity'], ['private', 'asset']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank']); setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin`;
  const entryForm = html => html.match(/<form data-manual-entry[\s\S]*?<\/form>/)[0];
  try {
    const original = entryForm(await (await fetch(`${base}/register?accountId=bank`)).text());
    assert.match(original, /data-focus-after-save="false"/); assert.match(original, /value="expense" data-counter-type="expense" selected/);
    assert.doesNotMatch(original, /value="private"/); assert.doesNotMatch(original, /value="bank" data-counter-type/);
    const requestId = original.match(/name="requestId" value="([^"]+)"/)[1];
    const values = new URLSearchParams({ csrf: 'token', accountId: 'bank', requestId, date: '2026-09-27', kind: 'expense', counterId: 'expense',
      categoryId: 'food', amountExpression: '100+200', memo: '<점심 & 간식>', continueEntry: 'true' });
    const send = () => fetch(`${base}/transactions`, { method: 'POST', body: values });
    const response = await send(); assert.equal(response.status, 200);
    const after = entryForm(await response.text()); assert.match(after, /data-focus-after-save="true"/);
    assert.match(after, /name="date" value="2026-09-27"/); assert.match(after, /value="food" selected/);
    assert.doesNotMatch(after, /점심|100\+200/); assert.match(after, /name="memo" maxlength="500">/);
    assert.notEqual(after.match(/name="requestId" value="([^"]+)"/)[1], requestId);
    assert.equal((await send()).status, 200); assert.equal(book.entries().length, 1); assert.equal(book.entries()[0].memo, '<점심 & 간식>');
    values.delete('continueEntry'); const stopped = entryForm(await (await send()).text());
    assert.match(stopped, /data-focus-after-save="false"/); assert.match(stopped, /name="continueEntry" value="true" style=/);
    assert.doesNotMatch(stopped, /value="2026-09-27"/);
    const asset = await fetch(`${base}/assets/manual-entry-ui.js`); assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'no-store'); assert.match(asset.headers.get('content-type'), /javascript/);
    values.set('amountExpression', '999'); assert.equal((await send()).status, 400); assert.equal(book.entries().length, 1);
    sub = 'viewer'; assert.doesNotMatch(await (await fetch(`${base}/register?accountId=bank`)).text(), /data-manual-entry/);
    assert.equal((await send()).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

import { parseSplitPaste } from './split-paste.js';

const form = document.querySelector('#split-form');
const rows = document.querySelector('#split-rows');
const kind = form?.querySelector('[name="kind"]');
const counterTemplate = document.querySelector('#counter-template');
const categoryTemplate = document.querySelector('#category-template');

function addRow() {
  if (rows.children.length >= 50) return;
  const row = document.createElement('tr');
  const accountCell = document.createElement('td');
  const account = counterTemplate.content.firstElementChild.cloneNode(true);
  accountCell.append(account);
  const amountCell = document.createElement('td');
  const amount = document.createElement('input');
  amount.name = 'lineAmount';
  amount.placeholder = '금액 또는 10000+2500';
  amount.required = true;
  amountCell.append(amount);
  const categoryCell = document.createElement('td');
  categoryCell.append(categoryTemplate.content.firstElementChild.cloneNode(true));
  const actionCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '삭제';
  remove.addEventListener('click', () => { if (rows.children.length > 2) row.remove(); });
  actionCell.append(remove);
  row.append(accountCell, amountCell, categoryCell, actionCell);
  rows.append(row);
  filterOptions();
  return row;
}

function filterOptions() {
  for (const select of rows.querySelectorAll('[name="counterId"]')) {
    for (const option of select.options) {
      option.hidden = kind.value === 'transfer' ? !['asset', 'liability'].includes(option.dataset.type) :
        option.dataset.type !== kind.value;
    }
    if (select.selectedOptions[0]?.hidden) {
      select.value = [...select.options].find(option => !option.hidden)?.value ?? '';
    }
  }
  for (const select of rows.querySelectorAll('[name="lineCategory"]')) {
    select.disabled = kind.value !== 'expense' || form.dataset.onBudget !== 'true';
    if (select.disabled) select.value = '';
  }
}

document.querySelector('#add-split-row')?.addEventListener('click', addRow);
for (const button of rows?.querySelectorAll('[data-remove-row]') ?? []) {
  button.addEventListener('click', () => { if (rows.children.length > 2) button.closest('tr').remove(); });
}
kind?.addEventListener('change', filterOptions);
document.querySelector('#apply-split-paste')?.addEventListener('click', () => {
  const notice = document.querySelector('#split-paste-notice');
  const choices = template => [...template.content.firstElementChild.options]
    .filter(option => option.value).map(option => ({ id: option.value,
      name: option.dataset.name ?? option.textContent.trim(), type: option.dataset.type }));
  try {
    const parsed = parseSplitPaste(document.querySelector('#split-paste').value, {
      counters: choices(counterTemplate).filter(item => kind.value === 'transfer' ?
        ['asset', 'liability'].includes(item.type) : item.type === kind.value),
      categories: choices(categoryTemplate),
      allowCategories: kind.value === 'expense' && form.dataset.onBudget === 'true',
    });
    rows.replaceChildren();
    for (const item of parsed) {
      const row = addRow();
      row.querySelector('[name="counterId"]').value = item.counterId;
      row.querySelector('[name="lineAmount"]').value = item.amountExpression;
      row.querySelector('[name="lineCategory"]').value = item.categoryId;
    }
    notice.textContent = `${parsed.length}행을 표에 넣었습니다. 내용을 확인한 뒤 저장하세요.`;
  } catch (error) { notice.textContent = error.message; }
});
form?.addEventListener('keydown', event => {
  if (event.isComposing || event.key !== 'Enter') return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    form.requestSubmit();
    return;
  }
  const field = event.target;
  if (!field.matches('#split-rows input, #split-rows select')) return;
  event.preventDefault();
  const row = field.closest('tr');
  let nextRow = event.shiftKey ? row.previousElementSibling : row.nextElementSibling;
  if (!nextRow && !event.shiftKey) nextRow = addRow();
  if (!nextRow) return;
  const next = nextRow.querySelector(`[name="${field.name}"]`);
  if (next && !next.disabled) {
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
  }
});
filterOptions();

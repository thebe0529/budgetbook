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
    select.disabled = kind.value !== 'expense';
    if (select.disabled) select.value = '';
  }
}

document.querySelector('#add-split-row')?.addEventListener('click', addRow);
for (const button of rows?.querySelectorAll('[data-remove-row]') ?? []) {
  button.addEventListener('click', () => { if (rows.children.length > 2) button.closest('tr').remove(); });
}
kind?.addEventListener('change', filterOptions);
filterOptions();

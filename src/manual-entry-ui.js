export function setupManualEntry(form, surface = globalThis) {
  if (!form) return;
  const field = name => form.elements.namedItem(name);
  const kind = field('kind'); const counter = field('counterId'); const category = field('categoryId');
  const amount = field('amountExpression'); const memo = field('memo');
  const button = form.querySelector('button[type="submit"]');
  const buttonLabel = button.textContent;
  let submitted = false; let composing = false;
  function updateKind() {
    const allowed = kind.value === 'expense' ? ['expense'] : kind.value === 'income' ? ['income'] :
      kind.value === 'opening' ? ['equity'] : ['asset', 'liability'];
    for (const option of counter.options) {
      option.disabled = !allowed.includes(option.dataset.counterType);
      option.hidden = option.disabled;
    }
    if (![...counter.options].some(option => option.value === counter.value && !option.disabled)) {
      counter.value = [...counter.options].find(option => !option.disabled)?.value ?? '';
    }
    category.disabled = kind.value !== 'expense' || form.dataset.onBudget !== 'true';
    if (category.disabled) category.value = '';
  }
  kind.addEventListener('change', updateKind);
  form.addEventListener('compositionstart', () => { composing = true; });
  form.addEventListener('compositionend', () => { composing = false; });
  form.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || composing || event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault(); if (!submitted) form.requestSubmit(button);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.target === amount) { event.preventDefault(); memo.focus(); }
      else if (event.target === memo) { event.preventDefault(); if (!submitted) form.requestSubmit(button); }
    }
  });
  form.addEventListener('submit', event => {
    if (event.defaultPrevented) return;
    if (submitted) { event.preventDefault(); return; }
    submitted = true; button.disabled = true; button.textContent = '저장 중…';
  });
  surface.addEventListener('pageshow', () => {
    submitted = false; button.disabled = false; button.textContent = buttonLabel; updateKind();
  });
  updateKind();
  if (form.dataset.focusAfterSave === 'true') amount.focus();
}

if (typeof document !== 'undefined') setupManualEntry(document.querySelector('[data-manual-entry]'));

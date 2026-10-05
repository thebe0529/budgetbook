import { calculateAmount } from './amount-expression.js';

export function setupManualEntry(form, surface = globalThis) {
  if (!form) return;
  const field = name => form.elements.namedItem(name);
  const kind = field('kind'); const counter = field('counterId'); const category = field('categoryId');
  const amount = field('amountExpression'); const memo = field('memo');
  const button = form.querySelector('button[type="submit"]');
  const preview = form.querySelector('[data-amount-preview]');
  const buttonLabel = button.textContent;
  let submitted = false; let composing = false;
  function updateAmount() {
    if (!amount.value.trim()) {
      amount.setCustomValidity(amount.value ? '금액을 입력하세요.' : '');
      preview.textContent = '금액을 입력하면 계산 결과를 표시합니다.';
      preview.className = '';
      return;
    }
    let message = '';
    try {
      const result = calculateAmount(amount.value);
      if (result <= 0) message = '계산한 금액은 1원 이상이어야 합니다.';
      else { preview.textContent = `계산 결과: ${result.toLocaleString('ko-KR')}원`; preview.className = 'notice'; }
    } catch {
      message = '올바른 사칙연산 식을 입력하세요. 0으로 나누거나 지원 범위를 넘는 금액은 저장할 수 없습니다.';
    }
    amount.setCustomValidity(message);
    if (message) { preview.textContent = message; preview.className = 'error'; }
  }
  amount.addEventListener('input', () => { if (!composing) updateAmount(); });
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
  form.addEventListener('compositionend', () => { composing = false; updateAmount(); });
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
    updateAmount();
    if (!amount.checkValidity()) { event.preventDefault(); amount.reportValidity(); return; }
    submitted = true; button.disabled = true; button.textContent = '저장 중…';
  });
  surface.addEventListener('pageshow', () => {
    submitted = false; button.disabled = false; button.textContent = buttonLabel; updateKind(); updateAmount();
  });
  updateKind();
  updateAmount();
  if (form.dataset.focusAfterSave === 'true') amount.focus();
}

if (typeof document !== 'undefined') setupManualEntry(document.querySelector('[data-manual-entry]'));

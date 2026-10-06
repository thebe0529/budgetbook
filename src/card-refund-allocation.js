import { calculateAmount } from './amount-expression.js';

export const refundDistributionModes = [
  ['equal', '미납 회차 균등 배분'],
  ['latest-first', '뒤 회차부터 차감'],
  ['earliest-first', '앞 회차부터 차감'],
  ['manual', '회차별 차감액 직접 지정'],
];

export function normalizeRefundDistribution(distributionMode = 'equal', deductions) {
  if (!refundDistributionModes.some(([mode]) => mode === distributionMode)) throw new Error('Invalid installment distribution mode');
  if (distributionMode !== 'manual') {
    if (deductions !== undefined && (!Array.isArray(deductions) || deductions.length)) throw new Error('Deductions require manual distribution');
    return { distributionMode, deductions: [] };
  }
  if (!Array.isArray(deductions) || deductions.length < 1 || deductions.length > 120) throw new Error('Provide one to 120 installment deductions');
  const normalized = deductions.map(item => {
    if (!Number.isSafeInteger(item?.index) || item.index < 1) throw new Error('Invalid deduction installment index');
    const amount = calculateAmount(item.amountExpression);
    if (amount < 0) throw new Error('Installment deduction cannot be negative');
    return { index: item.index, amount };
  }).sort((a, b) => a.index - b.index);
  if (new Set(normalized.map(item => item.index)).size !== normalized.length) throw new Error('Duplicate installment deduction');
  return { distributionMode, deductions: normalized };
}

export function distributeCardRefund(installments, reduction, { distributionMode, deductions }) {
  const unpaid = installments.filter(item => !item.paidEntryId);
  const unpaidAmount = unpaid.reduce((sum, item) => sum + item.amount, 0);
  if (!reduction) {
    if (distributionMode !== 'equal') throw new Error('Distribution requires unpaid installments');
    return installments;
  }
  const changes = new Map();
  if (distributionMode === 'manual') {
    let total = 0;
    for (const deduction of deductions) {
      const installment = unpaid.find(item => item.index === deduction.index);
      if (!installment || deduction.amount > installment.amount) throw new Error('Deduction must target an unpaid installment within its amount');
      total += deduction.amount;
      if (!Number.isSafeInteger(total)) throw new Error('Deduction total exceeds supported range');
      changes.set(deduction.index, installment.amount - deduction.amount);
    }
    if (total !== reduction) throw new Error('Installment deductions must equal the installment reduction');
  } else if (distributionMode === 'equal') {
    const remaining = unpaidAmount - reduction;
    unpaid.forEach((item, i) => changes.set(item.index, Math.floor(remaining / unpaid.length) + (i < remaining % unpaid.length ? 1 : 0)));
  } else {
    let remaining = reduction;
    for (const item of [...unpaid].sort((a, b) => distributionMode === 'latest-first' ? b.index - a.index : a.index - b.index)) {
      const deducted = Math.min(item.amount, remaining);
      changes.set(item.index, item.amount - deducted);
      remaining -= deducted;
    }
  }
  return installments.map(item => changes.has(item.index) ? { ...item, amount: changes.get(item.index) } : item);
}

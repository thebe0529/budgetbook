import { accountRegister } from './manual.js';
import { accountPeriodLock } from './account-locks.js';
import { registerFilters, filteredRegisterRows } from './register-view.js';
import { serializeCsv } from './csv.js';

export function registerTransactionsCsv(book, sub, accountId, params = new URLSearchParams()) {
  const filters = registerFilters(params);
  const register = accountRegister(book, sub, accountId, filters.throughDate || '9999-12-31');
  if (!['asset', 'liability'].includes(register.account.type)) throw new Error('Asset or liability account required');
  const lock = accountPeriodLock(book, sub, accountId);
  const rows = filteredRegisterRows(register, filters);
  return serializeCsv([['일자', '계좌', '메모', '증감(원)', '누적 잔액(원)', '확인 상태(현재)', '취소 상태(현재)',
    '거래 ID', '연결된 취소 분개 ID', '취소한 원거래 ID', '이 계좌 기간 잠금(현재)'],
    ...rows.map(row => [row.date, register.account.name, row.memo, row.movement, row.balance,
      row.checked ? '확인 완료' : '미확인', row.reversalId ? '취소됨 (원거래 보존)' : row.reversesEntryId ? '취소 분개' : '',
      row.id, row.reversalId || '', row.reversesEntryId || '', lock && row.date <= lock.throughDate ? '잠금' : ''])]);
}

export function periodLockMessage(snapshot, input) {
  const accounts = [...snapshot.accounts, ...snapshot.counterpartAccounts];
  const original = input.kind === 'split-update' ? snapshot.accounts.find(a => a.id === input.accountId)
    ?.rows?.find(row => row.id === input.entryId) : null;
  if (original?.locked) return '원거래가 잠금 기간에 포함되어 수정할 수 없습니다. 소유자에게 기간 잠금 해제를 요청하세요.';
  const accountIds = [input.accountId, input.counterId, ...(input.lines || []).map(line => line.counterId)].filter(Boolean);
  const locked = accounts.find(account => accountIds.includes(account.id) && account.lockedThroughDate &&
    (input.date <= account.lockedThroughDate || original?.date <= account.lockedThroughDate));
  return locked ? `${locked.name} 계좌는 ${locked.lockedThroughDate}까지 잠겨 있습니다. 실제 거래일을 확인하거나 소유자에게 잠금 해제를 요청하세요.` : '';
}

export function correctRejectedDate(snapshot, item, date, requestId) {
  if (item.syncError?.code !== 'PERIOD_LOCKED' || item.kind === 'split-update') {
    throw new Error('잠금으로 거절된 신규 거래의 일자만 수정할 수 있습니다.');
  }
  if (requestId === item.requestId || typeof requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('새 요청 ID가 필요합니다.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('올바른 거래일을 입력하세요.');
  const { syncError, ...payload } = item;
  const corrected = { ...payload, date, requestId };
  const warning = periodLockMessage(snapshot, corrected);
  if (warning) throw new Error(warning);
  return corrected;
}

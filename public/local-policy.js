export const isLocalUpdate = kind => ['split-update', 'manual-update'].includes(kind);

export const canCorrectRejectedDate = item => item.syncError?.code === 'PERIOD_LOCKED' &&
  ['expense', 'income', 'transfer', 'split'].includes(item.kind);

export function localTransactionInput(values, editor, requestId) {
  const data = Object.fromEntries(values);
  const editing = Boolean(editor.entryId);
  if (editing && !['manual', 'split'].includes(editor.type)) throw new Error('수정할 거래를 다시 선택하세요.');
  const input = { requestId, date: data.date, accountId: editing ? editor.accountId : data.accountId, memo: data.memo ?? '' };
  if (editor.type === 'split' && editing || !editing && data.mode === 'split') {
    const counters = values.getAll('splitCounterId');
    const amounts = values.getAll('splitAmount');
    const categories = values.getAll('splitCategory');
    if (counters.length < 2 || counters.length > 50 || counters.length !== amounts.length ||
      (categories.length && categories.length !== counters.length) ||
      categories.some(Boolean) && categories.some(value => !value)) throw new Error('분할 거래 행과 예산 카테고리를 확인하세요.');
    return { ...input, kind: editing ? 'split-update' : 'split', splitKind: data.kind,
      ...(editing ? { entryId: editor.entryId, expectedRevision: editor.expectedRevision } : {}),
      lines: counters.map((counterId, i) => ({ counterId, amountExpression: amounts[i], categoryId: categories[i] || null })) };
  }
  if (editing && (!['expense', 'income', 'transfer'].includes(editor.manualKind) ||
    typeof editor.expectedHash !== 'string' || !/^[0-9a-f]{64}$/i.test(editor.expectedHash))) {
    throw new Error('수정 정보가 없습니다. 동기화 후 거래를 다시 선택하세요.');
  }
  return { ...input, kind: editing ? 'manual-update' : data.kind,
    ...(editing ? { entryId: editor.entryId, expectedHash: editor.expectedHash, manualKind: editor.manualKind } : {}),
    counterId: data.counterId, amountExpression: data.amountExpression, categoryId: data.categoryId || null };
}

export function periodLockMessage(snapshot, input) {
  const accounts = [...snapshot.accounts, ...snapshot.counterpartAccounts];
  const original = isLocalUpdate(input.kind) ? snapshot.accounts.find(a => a.id === input.accountId)
    ?.rows?.find(row => row.id === input.entryId) : null;
  if (original?.locked) return '원거래가 잠금 기간에 포함되어 수정할 수 없습니다. 소유자에게 기간 잠금 해제를 요청하세요.';
  const accountIds = [input.accountId, input.counterId, ...(input.lines || []).map(line => line.counterId)].filter(Boolean);
  const originalIds = original ? [input.accountId, original.manual?.counterId,
    ...(original.split?.lines || []).map(line => line.counterId)].filter(Boolean) : [];
  const locked = accounts.find(account => account.lockedThroughDate &&
    (accountIds.includes(account.id) && input.date <= account.lockedThroughDate ||
      originalIds.includes(account.id) && original.date <= account.lockedThroughDate));
  return locked ? `${locked.name} 계좌는 ${locked.lockedThroughDate}까지 잠겨 있습니다. 실제 거래일을 확인하거나 소유자에게 잠금 해제를 요청하세요.` : '';
}

export function correctRejectedDate(snapshot, item, date, requestId) {
  if (!canCorrectRejectedDate(item)) {
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

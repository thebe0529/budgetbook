import { getParserRules, issueAccountKey, issueApiKey, revokeKey, saveParserRules } from './push-credentials.js';
import { parsePush } from './push-parser.js';
import { canAccessAccount, member, removeMember, setMember, visibleAccounts } from './members.js';
import { approveEvent, listReviewEvents } from './review.js';
import { randomUUID } from 'node:crypto';
import { accountOverview, accountRegister, createCategory, createGroup,
  createLedgerAccount, moveAccountGroup, renameGroup, recordManual } from './manual.js';
import { calculateAmount } from './amount-expression.js';
import { addMonths, assertDate, assertMonth } from './ledger.js';
import { readFileSync } from 'node:fs';
import { editableManual, recordSplitManual, updateSplitManual } from './split-manual.js';
import { cardCashDefault, setCardCashDefault, recordCardPurchase, recordCardPayment, recordCardPaymentBatch, visibleCardSchedule } from './card-manual.js';
import { autoLinkMatches, disableSchedule, forecast, linkOccurrence, linkedOccurrences, listSchedules,
  matchingEntries, saveSchedule, unlinkOccurrence } from './forecast.js';
import { accountActivity, detailedReports } from './report-details.js';
import { accountActivityCsv, cashMovementsCsv } from './report-export.js';
import { backupSettings, configureBackups, listBackups } from './backups.js';
import { budgetMoves, copyPreviousBudget, moveBudget, previousBudgetPreview } from './budget-actions.js';
import { budgetTargetPreview, fillBudgetTargets, setBudgetTarget } from './budget-targets.js';
import { confirmTransactions, setTransactionChecked } from './transaction-checks.js';
import { registerFilters, registerPage } from './register-view.js';
import { compareStatement, completeStatementReview, saveStatementComparison, statementComparisonHistory } from './statement-comparison.js';
import { accountPeriodLock, accountLockHistory, lockAccountPeriod, unlockAccountPeriod } from './account-locks.js';
import { reviewOverview } from './review-overview.js';
import { manualReversalPreview, reverseManualTransaction } from './manual-reversal.js';
import { registerTransactionsCsv } from './register-export.js';
import { transactionHistory } from './transaction-history.js';
import { manualEditPreview, updateManualTransaction } from './manual-edit.js';
import { listAdjustments, recordAdjustment, reverseAdjustment } from './adjustments.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function page(title, content) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escape(title)} · BudgetBook</title><style>
    body{font:16px system-ui,sans-serif;max-width:850px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#172333}
    label{display:block;margin-top:1rem;font-weight:650}input,textarea,select{box-sizing:border-box;width:100%;padding:.6rem;font:inherit}
    button{padding:.65rem 1rem;margin-top:1rem;background:#174a7e;color:white;border:0;border-radius:5px;cursor:pointer}
    pre{white-space:pre-wrap;background:#eef3f8;padding:1rem;border-radius:5px}nav{display:flex;gap:1rem;flex-wrap:wrap}
    .table-scroll{overflow-x:auto}.table-scroll table{min-width:760px}
    .notice{padding:1rem;background:#eaf5ed}.error{padding:1rem;background:#ffedeb}
    table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d8e1eb;padding:.5rem;text-align:left}
    </style></head><body><nav><a href="/admin/accounts">계좌</a><a href="/admin/budget">예산</a>
    <a href="/admin/reports">보고서</a><a href="/admin/review-overview">검토·잠금 현황</a><a href="/admin/balance-check">명세서 잔액 비교</a><a href="/admin/adjustments">일괄 조정</a>
    <a href="/admin/cards">카드 예정액</a>
    <a href="/admin/forecast">현금흐름 예상</a>
    <a href="/admin/review">수신 검토</a><a href="/admin/regex">정규식 설정</a>
    <a href="/admin/family">가족 관리</a><a href="/admin/backups">백업</a>
    <a href="/app/">로컬 입력</a>
    <a href="/auth/logout">로그아웃</a></nav>
    <h1>${escape(title)}</h1>${content}</body></html>`;
}

function renderAccounts(book, session, message = '') {
  const overview = accountOverview(book, session.sub, '9999-12-31');
  const allGroups = book.accountGroups();
  const accountMap = book.accounts();
  const groupControls = a => session.role !== 'owner' ? '' : `<form method="post" action="/admin/accounts/group">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="accountId" value="${escape(a.id)}">
    <select name="groupId" aria-label="${escape(a.name)} 그룹"><option value="">그룹 없음</option>${allGroups.filter(g => g.type === a.type)
      .map(g => `<option value="${escape(g.id)}" ${accountMap.get(a.id)?.groupId === g.id ? 'selected' : ''}>${escape(g.name)}</option>`).join('')}</select><button>그룹 변경</button></form>`;
  const rows = overview.map(a => `<tr><td><a href="/admin/register?accountId=${encodeURIComponent(a.id)}">${escape(a.name)}</a></td>
    <td>${escape(a.type)}</td><td>${escape(a.balance.toLocaleString('ko-KR'))}원</td><td>${groupControls(a)}</td></tr>`).join('');
  const typeOptions = ['asset', 'liability', 'equity', 'income', 'expense']
    .map(type => `<option value="${type}">${type}</option>`).join('');
  const groups = book.accountGroups().map(g => `<option value="${escape(g.id)}">${escape(g.name)} (${g.type})</option>`).join('');
  const controls = session.role !== 'owner' ? '' : `<h2>계좌 그룹 추가</h2>
    <form method="post" action="/admin/groups"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <label>그룹 이름</label><input name="name" required><label>그룹 유형</label>
      <select name="type"><option value="asset">자산</option><option value="liability">부채</option></select><button>그룹 생성</button></form>
    <h2>계좌 그룹 이름 변경</h2>${allGroups.map(g => `<form method="post" action="/admin/groups/rename">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="groupId" value="${escape(g.id)}">
      <label>${escape(g.type)} 그룹 이름</label><input name="name" maxlength="80" value="${escape(g.name)}" required><button>이름 저장</button></form>`).join('')}
    <h2>계좌 추가</h2><form method="post" action="/admin/accounts">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <label>계좌명</label><input name="name" required><label>회계 유형</label><select name="type">${typeOptions}</select>
      <label>계좌 그룹</label><select name="groupId"><option value="">없음</option>${groups}</select>
      <label><input type="checkbox" name="onBudget" style="width:auto"> 온버짓</label>
      <label><input type="checkbox" name="cash" style="width:auto"> 현금성 자산</label>
      <label><input type="checkbox" name="card" style="width:auto"> 신용카드 부채</label>
      <button>계좌 생성</button></form>
    <h2>예산 카테고리 추가</h2><form method="post" action="/admin/categories">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <label>카테고리명</label><input name="name" required><button>카테고리 생성</button></form>`;
  return page('계좌 관리', `${message}<table><thead><tr><th>계좌</th><th>유형</th><th>잔액</th><th>그룹 변경</th></tr></thead>
    <tbody>${rows}</tbody></table>${controls}`);
}

function renderRegister(book, session, accountId, message = '', filters = registerFilters(new URLSearchParams())) {
  const accounts = visibleAccounts(book, session.sub).filter(a => ['asset', 'liability'].includes(a.type));
  if (accountId && !accounts.some(a => a.id === accountId)) throw new Error('Account access denied');
  const selected = accounts.find(a => a.id === accountId) ?? accounts[0];
  if (!selected) return page('거래 입력', '<p>볼 수 있는 계좌가 없습니다.</p>');
  const register = accountRegister(book, session.sub, selected.id, '9999-12-31');
  const periodLock = accountPeriodLock(book, session.sub, selected.id);
  const options = accounts.map(a => `<option value="${escape(a.id)}"${a.id === selected.id ? ' selected' : ''}>${escape(a.name)}</option>`).join('');
  const counters = [...book.accounts().values()].filter(a => ['income', 'expense', 'equity'].includes(a.type) ||
    (['asset', 'liability'].includes(a.type) && canAccessAccount(book, session.sub, a.id, 'write')))
    .map(a => `<option value="${escape(a.id)}">${escape(a.name)} (${a.type})</option>`).join('');
  const categories = [...book.budgetCategories().values()].map(c =>
    `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join('');
  const input = !canAccessAccount(book, session.sub, selected.id, 'write') ?
    '<p>읽기 권한만 있습니다.</p>' : `<h2>거래 추가</h2><form method="post" action="/admin/transactions">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="accountId" value="${escape(selected.id)}">
      <input type="hidden" name="requestId" value="${randomUUID()}">
      <label>일자</label><input type="date" name="date" required>
      <label>유형</label><select name="kind"><option value="expense">지출</option><option value="income">수입</option>
        <option value="transfer">이체·카드 결제</option>${session.role === 'owner' ? '<option value="opening">기초 잔액</option>' : ''}</select>
      <label>상대 계정</label><select name="counterId">${counters}</select>
      <label>금액 (사칙연산 가능)</label><input name="amountExpression" required placeholder="10000+2500*2">
      <label>예산 카테고리 (온버짓 지출만)</label><select name="categoryId"><option value="">없음</option>${categories}</select>
      <label>메모</label><input name="memo"><button>거래 저장</button></form>
      <p><a href="/admin/split?accountId=${encodeURIComponent(selected.id)}">여러 행으로 분할 거래 입력</a></p>`;
  const { status } = filters;
  const writable = canAccessAccount(book, session.sub, selected.id, 'write');
  const view = registerPage(register, filters);
  const hiddenFilters = Object.entries({ ...filters, page: view.page }).map(([name, value]) =>
    `<input type="hidden" name="${name}" value="${escape(value)}">`).join('');
  const pageLink = number => `/admin/register?${escape(new URLSearchParams({ ...filters, accountId: selected.id, page: number }).toString())}`;
  const exportQuery = new URLSearchParams({ ...filters, accountId: selected.id });
  exportQuery.delete('page');
  const navigation = `<nav aria-label="거래 페이지">${view.page > 1 ? `<a href="${pageLink(view.page - 1)}">이전</a>` : ''}
    ${view.page} / ${view.pages} 페이지 ${view.page < view.pages ? `<a href="${pageLink(view.page + 1)}">다음</a>` : ''}</nav>`;
  const rows = view.rows.map(row => {
    const locked = periodLock && row.date <= periodLock.throughDate;
    const editable = !locked && !row.reversalId && row.kind === 'manual-split' && row.sourceAccountId === selected.id &&
      canAccessAccount(book, session.sub, selected.id, 'write') &&
      (row.createdBy === session.sub || session.role === 'owner');
    let cancel = '';
    let manualEdit = '';
    if (!locked && row.kind === 'manual' && row.sourceAccountId === selected.id) {
      try {
        manualEditPreview(book, session.sub, row.id);
        manualEdit = `<a href="/admin/transactions/edit?entryId=${encodeURIComponent(row.id)}">수정</a>`;
      } catch { /* Editing requires the author/owner and every financial account's write access. */ }
    }
    if (['manual', 'manual-split'].includes(row.kind) && row.sourceAccountId === selected.id && writable) {
      try {
        manualReversalPreview(book, session.sub, row.id);
        cancel = `<a href="/admin/transactions/reverse?entryId=${encodeURIComponent(row.id)}">${row.reversalId ? '취소 이력' : '거래 취소'}</a>`;
      } catch { /* No cancellation control without rights to every affected account. */ }
    }
    return `<tr><td>${writable && !row.checked ? `<input type="checkbox" name="selection" form="confirm-selected" aria-label="${escape(row.date)} ${escape(row.memo)} 확인 선택" value="${escape(JSON.stringify({ entryId: row.id, expectedHash: row.confirmationHash }))}">` : ''}</td><td>${escape(row.date)}</td><td>${escape(row.memo)}
      ${editable ? `<a href="/admin/split/edit?entryId=${encodeURIComponent(row.id)}">수정</a>` : ''}
      ${manualEdit}
      ${['manual', 'manual-split', 'manual-reversal'].includes(row.kind) ? `<a href="/admin/transactions/history?accountId=${encodeURIComponent(selected.id)}&amp;entryId=${encodeURIComponent(row.id)}">변경 이력</a>` : ''}
      ${row.reversalId ? ' · 취소됨 (원거래 보존)' : ''}${row.reversesEntryId ? ' · 취소 분개' : ''} ${cancel}</td>
    <td>${escape(row.movement.toLocaleString('ko-KR'))}</td><td>${escape(row.balance.toLocaleString('ko-KR'))}</td>
    <td>${row.checked ? '확인 완료' : '미확인'}${locked ? ' · 기간 잠금' : ''}${!locked && canAccessAccount(book, session.sub, selected.id, 'write') ?
    `<form method="post" action="/admin/register/check"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
    ${hiddenFilters}
    <input type="hidden" name="accountId" value="${escape(selected.id)}"><input type="hidden" name="entryId" value="${escape(row.id)}">
    <input type="hidden" name="expectedHash" value="${escape(row.confirmationHash)}">
    <input type="hidden" name="checked" value="${row.checked ? 'false' : 'true'}"><button>${row.checked ? '확인 해제' : '거래 확인'}</button></form>` : ''}</td></tr>`;
  }).join('');
  return page(`${selected.name} 거래`, `${message}<form method="get" action="/admin/register">
    <label>계좌</label><select name="accountId">${options}</select>
    <label>확인 상태</label><select name="status">${[['all', '전체'], ['unchecked', '미확인'], ['checked', '확인 완료']].map(([value, label]) => `<option value="${value}"${status === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
    <label>시작일</label><input type="date" name="fromDate" value="${escape(filters.fromDate)}">
    <label>종료일</label><input type="date" name="throughDate" value="${escape(filters.throughDate)}">
    <label>메모 검색</label><input name="memo" maxlength="200" value="${escape(filters.memo)}"><button>조회</button></form>
    <p>잔액: ${escape(register.balance.toLocaleString('ko-KR'))}원 · 확인 거래 누적 합계: ${register.checkedBalance.toLocaleString('ko-KR')}원 · 미확인 ${register.uncheckedCount}건</p>
    <p><a href="/admin/balance-check?accountId=${encodeURIComponent(selected.id)}">이 계좌의 명세서 잔액 비교</a></p>
    ${periodLock ? `<p class="notice">${escape(periodLock.throughDate)}까지 거래 기간이 잠겨 있습니다.</p>` : ''}
    <p>은행 내역과 대조한 거래를 확인 표시하세요. 거래가 수정되면 표시를 다시 확인해야 합니다. 확인 표시는 원장 잔액을 변경하지 않습니다.</p>${input}
    <h2>거래 목록</h2><p>조건에 맞는 ${view.total}건 · 검색 거래 증감 합계: ${view.movement.toLocaleString('ko-KR')}원 · 페이지당 최대 200건. 잔액은 검색 조건과 무관한 전체 원장 기준입니다.</p>${navigation}
    <p><a href="/admin/register/export.csv?${escape(exportQuery.toString())}">조건에 맞는 전체 거래 CSV 다운로드</a></p>
    ${writable ? `<form id="confirm-selected" method="post" action="/admin/register/check-selected">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="accountId" value="${escape(selected.id)}">
    ${hiddenFilters}<button>선택 거래 확인</button></form>` : ''}
    <table><tr><th>선택</th><th>일자</th><th>메모</th><th>증감</th><th>잔액</th><th>확인 상태</th></tr>${rows}</table>${navigation}`);
}

function renderManualEdit(book, session, entryId) {
  const { input, expectedHash } = manualEditPreview(book, session.sub, entryId);
  const account = book.accounts().get(input.accountId);
  const counters = [...book.accounts().values()].filter(a => input.kind === 'expense' ? a.type === 'expense' :
    input.kind === 'income' ? a.type === 'income' : input.kind === 'opening' ? a.type === 'equity' :
    ['asset', 'liability'].includes(a.type) && a.id !== input.accountId && canAccessAccount(book, session.sub, a.id, 'write'));
  const categoryOptions = [...book.budgetCategories().values()].map(c =>
    `<option value="${escape(c.id)}" ${c.id === input.categoryId ? 'selected' : ''}>${escape(c.name)}</option>`).join('');
  const kindNames = { expense: '지출', income: '수입', transfer: '이체·카드 결제', opening: '기초 잔액' };
  return page('단순 거래 수정', `<p>원천 계좌: ${escape(account.name)} · 유형: ${kindNames[input.kind]}</p>
    <p class="notice">수정 전 내용을 변경 이력에 보존합니다. 확인 완료 표시는 무효화되므로 다시 확인해야 합니다. 거래가 바뀌거나 관련 계좌 기간이 잠기면 저장할 수 없습니다. 원천 계좌와 거래 유형은 변경할 수 없습니다.</p>
    <form method="post" action="/admin/transactions/update">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="entryId" value="${escape(entryId)}">
    <input type="hidden" name="accountId" value="${escape(input.accountId)}"><input type="hidden" name="kind" value="${input.kind}">
    <input type="hidden" name="expectedHash" value="${expectedHash}"><input type="hidden" name="updateRequestId" value="${randomUUID()}">
    <label>일자</label><input type="date" name="date" value="${escape(input.date)}" required>
    <label>상대 계정</label><select name="counterId">${counters.map(a => `<option value="${escape(a.id)}" ${a.id === input.counterId ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select>
    <label>금액 (사칙연산 가능)</label><input name="amountExpression" value="${escape(input.amountExpression)}" required>
    ${input.kind === 'expense' && account.onBudget ? `<label>예산 카테고리</label><select name="categoryId"><option value="">없음</option>${categoryOptions}</select>` : ''}
    <label>메모</label><input name="memo" maxlength="500" value="${escape(input.memo)}"><button>거래 수정 저장</button></form>
    <p><a href="/admin/transactions/history?accountId=${encodeURIComponent(input.accountId)}&amp;entryId=${encodeURIComponent(entryId)}">변경 이력</a>
    · <a href="/admin/register?accountId=${encodeURIComponent(input.accountId)}">계좌 거래 목록으로</a></p>`);
}

function renderTransactionHistory(book, session, accountId, entryId) {
  const history = transactionHistory(book, session.sub, accountId, entryId);
  const details = entry => `<p>거래일: ${escape(entry.date)} · 메모: ${escape(entry.memo)}</p>
    <div class="table-scroll"><table><thead><tr><th>계정</th><th>차변(원)</th><th>대변(원)</th></tr></thead><tbody>
    ${entry.postings.map(p => `<tr><td>${escape(p.accountName)}</td><td>${p.side === 'debit' ? escape(p.amount.toLocaleString('ko-KR')) : ''}</td>
      <td>${p.side === 'credit' ? escape(p.amount.toLocaleString('ko-KR')) : ''}</td></tr>`).join('')}</tbody></table></div>
    ${entry.budgetAllocations.length ? `<p>예산 배분: ${entry.budgetAllocations.map(item => `${escape(item.categoryName)} ${escape(item.amount.toLocaleString('ko-KR'))}원`).join(' · ')}</p>` : '<p>예산 배분 없음</p>'}`;
  return page('거래 변경 이력', `<p><a href="/admin/register?accountId=${encodeURIComponent(accountId)}">계좌 거래 목록으로</a></p>
    <p>원거래 ID: ${escape(history.originalId)}</p><p>읽기 전용 이력입니다. 계정·카테고리 이름은 현재 이름이며 처리 시각은 UTC입니다. 최초 등록 시각은 저장되어 있지 않습니다.</p>
    ${history.versions.map((version, index) => `<section><h2>버전 ${escape(version.revision)}${index === history.versions.length - 1 ? ' (현재 원거래)' : ''}</h2>
      <p>${index ? '수정자' : '작성자'}: ${escape(version.actor)} · ${version.changedAt ? `수정 시각: ${escape(version.changedAt)}` : '최초 등록'}</p>${details(version)}</section>`).join('')}
    ${history.reversal ? `<section><h2>거래 취소</h2><p>취소일: ${escape(history.reversal.date)} · 취소자: ${escape(history.reversal.actor)} · 처리 시각: ${escape(history.reversal.createdAt)}</p>
      <p>사유: ${escape(history.reversal.reason)}</p><p>취소 분개 ID: ${escape(history.reversal.entry.id)}</p>${details(history.reversal.entry)}</section>` : '<p>취소 이력 없음</p>'}`);
}

function renderManualReversal(book, session, entryId, message = '') {
  const { entry, expectedHash, reversal } = manualReversalPreview(book, session.sub, entryId);
  const account = book.accounts().get(entry.sourceAccountId);
  const amounts = entry.postings.filter(p => p.accountId === account.id).reduce((sum, p) =>
    sum + p.amount * ((p.side === 'debit') === (account.type === 'asset') ? 1 : -1), 0);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const content = reversal ? `<p class="notice">이미 취소된 거래입니다. 취소 분개는 한 번만 기록됩니다.</p>
    <p>취소일: ${escape(reversal.date)} · 취소자: ${escape(reversal.actor)} · 기록 시각: ${escape(reversal.createdAt)} (UTC)</p>
    <p>사유: ${escape(reversal.reason)}</p>${reversal.detachedScheduleLink ? '<p>예정 거래의 실제 거래 연결을 해제했습니다.</p>' : ''}` : `<form method="post" action="/admin/transactions/reverse">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="entryId" value="${escape(entry.id)}">
    <input type="hidden" name="expectedHash" value="${expectedHash}"><input type="hidden" name="requestId" value="${randomUUID()}">
    <label>취소일 (원거래일 이후)</label><input type="date" name="date" min="${escape(entry.date)}" value="${today < entry.date ? entry.date : today}" required>
    <label>취소 사유</label><input name="reason" maxlength="200" required><button>반대 분개로 거래 취소</button></form>`;
  return page('수동 거래 취소', `${message}<p>계좌: ${escape(account.name)} · 원거래일: ${escape(entry.date)} · 증감: ${amounts.toLocaleString('ko-KR')}원</p>
    <p>메모: ${escape(entry.memo)}</p><p>원거래를 보존하고 취소일에 같은 금액의 반대 분개를 기록합니다. 예산도 취소일이 속한 달에 되돌립니다. 원거래일보다 이전 날짜나 계좌의 잠금 기간에는 취소할 수 없습니다.</p>
    ${content}<p><a href="/admin/register?accountId=${encodeURIComponent(account.id)}">계좌 거래로 돌아가기</a></p>`);
}

function renderReviewOverview(book, session, query) {
  const throughDate = query.get('throughDate') || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const filter = query.get('status') || 'all';
  if (!['all', 'attention'].includes(filter)) throw new Error('Invalid overview filter');
  const overview = reviewOverview(book, session.sub, throughDate);
  const labels = { none: '비교 이력 없음', changed: '저장 후 변경 · 재검토 필요', difference: '잔액 차이 있음',
    unchecked: '저장 당시 미확인 거래 있음', ready: '검토 완료 표시 가능', reviewed: '검토 완료' };
  const rows = overview.rows.filter(row => filter === 'all' || row.needsAttention).map(row => {
    const register = `/admin/register?${escape(new URLSearchParams({ accountId: row.account.id, throughDate, status: 'unchecked' }).toString())}`;
    const compare = `/admin/balance-check?${escape(new URLSearchParams({ accountId: row.account.id, throughDate }).toString())}`;
    const saved = row.comparison ? `/admin/balance-check?${escape(new URLSearchParams({ accountId: row.account.id,
      throughDate: row.comparison.throughDate, statementBalance: row.comparison.statementBalance }).toString())}` : '';
    return `<tr><td>${escape(row.account.name)} (${row.account.type === 'asset' ? '자산' : '부채'})</td>
      <td>${row.balance.toLocaleString('ko-KR')}원</td><td><a href="${register}">${row.uncheckedCount}건</a></td>
      <td>${row.comparison ? `<a href="${saved}">${escape(row.comparison.throughDate)}</a>` : '없음'}
      ${row.olderCutoff ? '<br>조회 기준일보다 이전' : ''}</td>
      <td>${labels[row.status]}</td><td>${row.comparison ? `${row.comparison.difference.toLocaleString('ko-KR')}원` : '—'}</td>
      <td>${row.lockedThroughDate ? `${escape(row.lockedThroughDate)}까지` : '잠금 없음'}</td>
      <td><a href="${compare}">기준일 잔액 비교</a></td></tr>`;
  }).join('');
  return page('계좌 검토·잠금 현황', `<form method="get" action="/admin/review-overview">
    <label>조회 기준일</label><input type="date" name="throughDate" value="${escape(throughDate)}" required>
    <label>표시</label><select name="status"><option value="all"${filter === 'all' ? ' selected' : ''}>전체 계좌</option>
    <option value="attention"${filter === 'attention' ? ' selected' : ''}>확인 필요 계좌</option></select><button>조회</button></form>
    <p>접근 가능한 ${overview.rows.length}개 계좌 · 확인 필요 ${overview.attentionCount}개 · 미확인 거래가 있는 계좌 ${overview.uncheckedAccountCount}개</p>
    <p>잔액과 미확인 건수는 조회 기준일까지의 거래입니다. 최근 비교는 기준일이 조회일 이하인 이력 중 가장 최근에 저장한 결과입니다. 차이는 저장 당시 명세서 잔액에서 원장 잔액을 뺀 금액입니다. 잠금은 현재 상태를 표시합니다.</p>
    <p>조회일보다 이전 비교만 있거나, 미확인 거래·잔액 차이·저장 후 변경·검토 미완료가 있으면 확인 필요로 분류합니다.</p>
    <div class="table-scroll"><table><tr><th>계좌</th><th>기준일 잔액</th><th>미확인</th><th>최근 비교 기준일</th><th>최근 비교 상태</th><th>저장 당시 차이</th><th>현재 잠금 기준일</th><th>작업</th></tr>
    ${rows || '<tr><td colspan="8">조건에 맞는 계좌가 없습니다.</td></tr>'}</table></div>`);
}

function renderBalanceCheck(book, session, query, message = '') {
  const accounts = visibleAccounts(book, session.sub).filter(a => ['asset', 'liability'].includes(a.type));
  const accountId = query.get('accountId');
  if (accountId && !accounts.some(a => a.id === accountId)) throw new Error('Account access denied');
  const selected = accounts.find(a => a.id === accountId) ?? accounts[0];
  if (!selected) return page('명세서 잔액 비교', '<p>볼 수 있는 계좌가 없습니다.</p>');
  const periodLock = accountPeriodLock(book, session.sub, selected.id);
  const owner = member(book, session.sub)?.role === 'owner';
  const lockControls = periodLock ? `<p class="notice">${escape(periodLock.throughDate)}까지 거래 추가·수정·삭제와 확인 해제가 잠겨 있습니다.
    ${escape(periodLock.actor)} · ${escape(periodLock.createdAt)} (UTC)</p>${owner ?
    `<form method="post" action="/admin/balance-check/unlock"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
    <input type="hidden" name="accountId" value="${escape(selected.id)}"><input type="hidden" name="expectedLockId" value="${escape(periodLock.id)}">
    <input type="hidden" name="requestId" value="${randomUUID()}"><label>기간 잠금 해제 사유</label><input name="reason" maxlength="500" required>
    <button>기간 잠금 해제</button></form>` : ''}` : '<p>현재 기간 잠금이 없습니다.</p>';
  const throughDate = query.get('throughDate') || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  assertDate(throughDate);
  const expression = query.get('statementBalance') || '';
  let result = '';
  if (expression.trim()) {
    const comparison = compareStatement(book, session.sub, selected.id, throughDate, expression);
    const money = amount => `${amount.toLocaleString('ko-KR')}원`;
    const link = status => `/admin/register?${escape(new URLSearchParams({ accountId: selected.id, throughDate, status }).toString())}`;
    result = `<h2>비교 결과</h2><table><tr><th>항목</th><th>금액</th></tr>
      <tr><td>명세서 잔액</td><td>${money(comparison.statementBalance)}</td></tr>
      <tr><td>기준일 원장 잔액</td><td>${money(comparison.ledgerBalance)}</td></tr>
      <tr><td>차이 (명세서 − 원장)</td><td>${money(comparison.difference)}</td></tr>
      <tr><td>확인 거래 누적 합계</td><td>${money(comparison.checkedBalance)}</td></tr>
      <tr><td>미확인 거래 증감 합계</td><td>${money(comparison.uncheckedMovement)}</td></tr></table>
      <p class="${comparison.difference === 0 ? 'notice' : 'error'}">${comparison.difference === 0 ? '기준일 잔액이 일치합니다.' : '기준일 잔액에 차이가 있습니다. 누락·중복 거래와 거래일을 확인하세요.'}</p>
      <p>기준일까지 ${comparison.transactionCount}건 중 미확인 ${comparison.uncheckedCount}건입니다. 잔액이 일치해도 거래별 확인이 완료된 것은 아닙니다.</p>
      <p><a href="${link('unchecked')}">기준일까지의 미확인 거래 조회</a> · <a href="${link('all')}">기준일까지의 전체 거래 조회</a></p>`;
    if (canAccessAccount(book, session.sub, selected.id, 'write')) result += `<form method="post" action="/admin/balance-check/save">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="requestId" value="${randomUUID()}">
      <input type="hidden" name="accountId" value="${escape(selected.id)}"><input type="hidden" name="throughDate" value="${escape(throughDate)}">
      <input type="hidden" name="statementBalance" value="${comparison.statementBalance}"><input type="hidden" name="expectedHash" value="${comparison.stateHash}">
      <button>비교 결과 저장</button></form>`;
  }
  const history = statementComparisonHistory(book, session.sub, selected.id).map(saved => {
    const link = `/admin/balance-check?${escape(new URLSearchParams({ accountId: selected.id, throughDate: saved.throughDate,
      statementBalance: saved.statementBalance }).toString())}`;
    const completion = saved.review ? `<p>${saved.changed ? '완료 후 변경됨 · 재검토 필요' : '검토 완료'}<br>
      ${escape(saved.review.actor)} · ${escape(saved.review.completedAt)}</p>` :
      !saved.changed && saved.difference === 0 && saved.uncheckedCount === 0 && canAccessAccount(book, session.sub, selected.id, 'write') ?
      `<form method="post" action="/admin/balance-check/complete"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="comparisonId" value="${escape(saved.id)}"><button>검토 완료 표시</button></form>` : '';
    const locking = owner && saved.review && !saved.changed && (!periodLock || saved.throughDate > periodLock.throughDate) ?
      `<form method="post" action="/admin/balance-check/lock"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="comparisonId" value="${escape(saved.id)}"><input type="hidden" name="requestId" value="${randomUUID()}">
      <button>${escape(saved.throughDate)}까지 기간 잠금</button></form>` : '';
    return `<tr><td>${escape(saved.throughDate)}</td><td>${saved.statementBalance.toLocaleString('ko-KR')}</td>
      <td>${saved.ledgerBalance.toLocaleString('ko-KR')}</td><td>${saved.difference.toLocaleString('ko-KR')}</td>
      <td>${saved.uncheckedCount}</td><td>${escape(saved.actor)}<br>${escape(saved.savedAt)}</td>
      <td>${saved.changed ? '저장 후 변경됨' : '저장 당시와 동일'}${completion}${locking}<br><a href="${link}">현재 상태로 다시 비교</a></td></tr>`;
  }).join('');
  const lockHistory = accountLockHistory(book, session.sub, selected.id).map(event => `<tr>
    <td>${event.action === 'lock' ? '잠금' : '해제'}</td><td>${escape(event.lock.throughDate)}</td><td>${escape(event.actor)}</td>
    <td>${escape(event.createdAt)}</td><td>${escape(event.reason || '')}</td></tr>`).join('');
  return page('명세서 잔액 비교', `${message}<form method="get" action="/admin/balance-check">
    <label>계좌</label><select name="accountId">${accounts.map(a => `<option value="${escape(a.id)}"${a.id === selected.id ? ' selected' : ''}>${escape(a.name)}</option>`).join('')}</select>
    <label>기준일 (당일 거래 포함)</label><input type="date" name="throughDate" value="${escape(throughDate)}" required>
    <label>명세서 잔액 (원, 사칙연산 가능)</label><input name="statementBalance" maxlength="256" value="${escape(expression)}" required>
    <button>잔액 비교</button></form>
    <p>예금은 보유 잔액을, 카드·대출은 남은 채무를 양수로 입력하세요. 초과 입금 등 반대 잔액은 음수로 입력할 수 있습니다.</p>
    <p>기준일까지의 기초 잔액을 포함한 모든 거래로 비교합니다. 결과 저장은 비교 이력을 남기며 거래 확인 표시나 원장 금액을 변경하지 않습니다.</p>
    <p>잔액 차이가 0원이고 미확인 거래가 없는 이력은 검토 완료로 표시할 수 있습니다. 완료 후 거래나 확인 상태가 바뀌면 다시 검토해야 합니다. 소유자는 검토 완료 이력을 기준으로 기간을 별도로 잠글 수 있습니다.</p>${result}
    <h2>현재 기간 잠금</h2>${lockControls}
    <h2>저장한 비교 이력 (최근 20건)</h2><table><tr><th>기준일</th><th>명세서 잔액</th><th>원장 잔액</th><th>차이</th><th>미확인 건수</th><th>저장자·시각 (UTC)</th><th>상태</th></tr>${history || '<tr><td colspan="7">저장한 이력이 없습니다.</td></tr>'}</table>
    <h2>기간 잠금·해제 이력 (최근 20건)</h2><table><tr><th>작업</th><th>기준일</th><th>작업자</th><th>시각 (UTC)</th><th>해제 사유</th></tr>${lockHistory || '<tr><td colspan="5">잠금 이력이 없습니다.</td></tr>'}</table>`);
}

function renderSplit(book, session, accountId, entryId = null, message = '') {
  const account = visibleAccounts(book, session.sub).find(a => a.id === accountId);
  if (!account || !canAccessAccount(book, session.sub, accountId, 'write')) {
    throw new Error('Account write access required');
  }
  const existing = entryId ? editableManual(book, session.sub, entryId) : null;
  if (entryId && (!existing || existing.sourceAccountId !== accountId)) {
    throw new Error('Split transaction cannot be edited');
  }
  const kind = existing?.splitKind ?? 'expense';
  const counters = [...book.accounts().values()].filter(a => ['income', 'expense'].includes(a.type) ||
    (['asset', 'liability'].includes(a.type) && a.id !== accountId &&
      canAccessAccount(book, session.sub, a.id, 'write')));
  const categories = [...book.budgetCategories().values()];
  const options = selected => counters.map(a => `<option value="${escape(a.id)}" data-type="${a.type}" data-name="${escape(a.name)}"
    ${a.id === selected ? 'selected' : ''}>${escape(a.name)} (${a.type})</option>`).join('');
  const categoryOptions = selected => '<option value="">없음</option>' + categories.map(c =>
    `<option value="${escape(c.id)}" data-name="${escape(c.name)}" ${c.id === selected ? 'selected' : ''}>${escape(c.name)}</option>`).join('');
  const counterLines = existing?.postings.filter(p => p.accountId !== accountId) ?? [null, null];
  const rows = counterLines.map((line, index) => `<tr><td><select name="counterId">${options(line?.accountId)}</select></td>
    <td><input name="lineAmount" value="${escape(line?.amount ?? '')}" required></td>
    <td><select name="lineCategory">${categoryOptions(existing?.budgetAllocations?.[index]?.categoryId)}</select></td>
    <td><button type="button" data-remove-row>삭제</button></td></tr>`).join('');
  return page(entryId ? '분할 거래 수정' : '분할 거래 입력', `${message}
    <p>원천 계좌: ${escape(account.name)} · 상대 계정을 행으로 추가합니다. 각 행의 합계를 원천 계좌에 한 번 반영합니다.</p>
    <p id="split-keyboard-help">Tab: 다음 입력칸 · Enter: 아래 행의 같은 입력칸 (마지막 행은 추가) · Shift+Enter: 위 행 · Ctrl+Enter 또는 ⌘+Enter: 저장. 최대 50행입니다.</p>
    <details><summary>엑셀 행 붙여넣기</summary>
      <p>머리글 없이 상대 계정 이름(또는 ID), 금액 식, 예산 카테고리 이름(선택)을 탭으로 구분해 2~50행을 붙여넣으세요. 아래 버튼을 누르면 현재 표를 교체합니다. 이름이 중복되면 ID를 사용하세요.</p>
      <textarea id="split-paste" rows="5" aria-label="분할 거래 붙여넣기"></textarea>
      <button type="button" id="apply-split-paste">붙여넣기로 현재 표 교체</button>
      <p id="split-paste-notice" role="status"></p></details>
    <form id="split-form" data-on-budget="${account.onBudget === true}" method="post" action="${entryId ? '/admin/split/update' : '/admin/split'}">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="accountId" value="${escape(accountId)}">
      ${entryId ? `<input type="hidden" name="entryId" value="${escape(entryId)}">
        <input type="hidden" name="revision" value="${existing.revision}">` :
    `<input type="hidden" name="requestId" value="${randomUUID()}">`}
      <label>일자</label><input type="date" name="date" value="${escape(existing?.date ?? '')}" required>
      <label>유형</label><select name="kind"><option value="expense" ${kind === 'expense' ? 'selected' : ''}>지출</option>
      <option value="income" ${kind === 'income' ? 'selected' : ''}>수입</option>
      <option value="transfer" ${kind === 'transfer' ? 'selected' : ''}>이체·카드 결제</option></select>
      <label>메모</label><input name="memo" value="${escape(existing?.memo ?? '')}">
      <table aria-describedby="split-keyboard-help"><tr><th>상대 계정</th><th>금액</th><th>예산 카테고리</th><th></th></tr>
      <tbody id="split-rows">${rows}</tbody></table><button type="button" id="add-split-row">행 추가</button>
      <button>분할 거래 ${entryId ? '수정' : '저장'}</button>
    </form><template id="counter-template"><select name="counterId">${options()}</select></template>
    <template id="category-template"><select name="lineCategory">${categoryOptions()}</select></template>
    <script type="module" src="/admin/assets/split.js"></script>`);
}

function renderReports(book, session, fromDate, throughDate, message = '') {
  const overview = accountOverview(book, session.sub, throughDate);
  const rows = overview.map(a => `<tr><td><a href="/admin/register?accountId=${encodeURIComponent(a.id)}">
    ${escape(a.name)}</a></td><td>${escape(a.balance.toLocaleString('ko-KR'))}</td></tr>`).join('');
  let consolidated = '<p>가족 구성원에게는 허용된 계좌의 잔액만 표시합니다.</p>';
  if (session.role === 'owner') {
    const detail = detailedReports(book, session.sub, fromDate, throughDate);
    const { balanceSheet: bs, incomeStatement: income } = detail.summary;
    const money = value => escape(value.toLocaleString('ko-KR'));
    const link = id => `/admin/reports/account?accountId=${encodeURIComponent(id)}&fromDate=${encodeURIComponent(fromDate)}&throughDate=${encodeURIComponent(throughDate)}`;
    const positionRows = detail.positions.map(a => `<tr><td>${escape(a.type)}</td><td>${escape(a.group)}</td>
      <td><a href="/admin/reports/account?accountId=${encodeURIComponent(a.id)}&fromDate=0001-01-01&throughDate=${encodeURIComponent(throughDate)}">${escape(a.name)}</a></td><td>${money(a.amount)}</td></tr>`).join('');
    const performanceRows = detail.performance.map(a => `<tr><td>${escape(a.type)}</td>
      <td><a href="${link(a.id)}">${escape(a.name)}</a></td><td>${money(a.amount)}</td></tr>`).join('');
    const cashRows = detail.cashRows.map(a => `<tr><td><a href="${link(a.id)}">${escape(a.name)}</a></td>
      <td>${money(a.opening)}</td><td>${money(a.receipts)}</td><td>${money(a.payments)}</td>
      <td>${money(a.closing)}</td></tr>`).join('');
    const movements = detail.cashMovements.map(m => `<tr><td>${escape(m.date)}</td>
      <td><a href="${link(m.accountId)}">${escape(book.accounts().get(m.accountId)?.name ?? '')}</a></td>
      <td>${escape(m.activity)}</td><td>${escape(m.memo)}</td><td>${money(m.amount)}</td></tr>`).join('');
    const activityLabels = { operating: '영업활동', investing: '투자활동', financing: '재무활동' };
    const activityRows = Object.entries(detail.cashFlowActivities.totals).map(([key, value]) =>
      `<tr><td>${activityLabels[key]}</td><td>${money(value)}</td></tr>`).join('');
    consolidated = `<h2>재무상태표 · ${escape(throughDate)}</h2>
      <table><tr><th>유형</th><th>계좌 그룹</th><th>계정</th><th>잔액</th></tr>${positionRows}</table>
      <p>자산 ${money(bs.assets)}원 · 부채 ${money(bs.liabilities)}원 · 순자산 ${money(bs.netWorth)}원<br>
      기초자본 ${money(bs.equity)}원 + 누적 손익 ${money(bs.retainedResult)}원 = 순자산 ${money(bs.netWorth)}원</p>
      <h2>손익계산서 · ${escape(fromDate)} ~ ${escape(throughDate)}</h2>
      <table><tr><th>유형</th><th>계정</th><th>기간 금액</th></tr>${performanceRows}</table>
      <p>수입 ${money(income.income)}원 − 비용 ${money(income.expenses)}원 = 순손익 ${money(income.result)}원</p>
      <h2>현금흐름 내역 · ${escape(fromDate)} ~ ${escape(throughDate)}</h2>
      <p>현금성 계좌의 기간 입출금을 표시합니다. 현금성 계좌 사이의 이체는 양쪽 계좌에 나타나지만 합계의 순변동은 0원입니다.</p>
      <table><tr><th>계좌</th><th>기초</th><th>입금</th><th>출금</th><th>기말</th></tr>${cashRows}
      <tr><th>합계</th><th>${money(detail.cashTotals.opening)}</th><th>${money(detail.cashTotals.receipts)}</th>
      <th>${money(detail.cashTotals.payments)}</th><th>${money(detail.cashTotals.closing)}</th></tr></table>
      <p>현금 순증감 ${money(detail.summary.cashFlow.netChange)}원</p>
      <p><a href="/admin/reports/cash.csv?fromDate=${encodeURIComponent(fromDate)}&throughDate=${encodeURIComponent(throughDate)}">현금 입출금 CSV 다운로드</a></p>
      <h3>활동별 현금흐름</h3>
      <table><tr><th>활동</th><th>순증감</th></tr>${activityRows}</table>
      <details><summary>현금 입출금 원거래 전체 보기</summary>
      <table><tr><th>일자</th><th>계좌</th><th>활동</th><th>메모</th><th>증감</th></tr>${movements}</table></details>`;
  }
  return page('보고서', `${message}<form method="get" action="/admin/reports">
    <label>시작일</label><input type="date" name="fromDate" value="${escape(fromDate)}">
    <label>기준일</label><input type="date" name="throughDate" value="${escape(throughDate)}"><button>조회</button></form>
    <h2>접근 가능한 계좌 잔액</h2><table><tr><th>계좌</th><th>잔액</th></tr>${rows}</table>${consolidated}`);
}

function renderAccountActivity(book, session, accountId, fromDate, throughDate) {
  const activity = accountActivity(book, session.sub, accountId, fromDate, throughDate);
  const rows = activity.lines.map(line => `<tr><td>${escape(line.date)}</td><td>${escape(line.entryId)}</td>
    <td>${escape(line.memo)}</td><td>${line.side === 'debit' ? escape(line.amount.toLocaleString('ko-KR')) : ''}</td>
    <td>${line.side === 'credit' ? escape(line.amount.toLocaleString('ko-KR')) : ''}</td>
    <td>${escape(line.movement.toLocaleString('ko-KR'))}</td></tr>`).join('');
  return page(`${activity.account.name} 거래 내역`, `<p>기간: ${escape(fromDate)} ~ ${escape(throughDate)} ·
    기간 합계: ${escape(activity.total.toLocaleString('ko-KR'))}원</p>
    <p><a href="/admin/reports/account.csv?accountId=${encodeURIComponent(accountId)}&fromDate=${encodeURIComponent(fromDate)}&throughDate=${encodeURIComponent(throughDate)}">계정 거래 CSV 다운로드</a></p>
    <p>증감은 계정의 정상잔액 방향으로 표시합니다. 자산·비용은 차변, 부채·자본·수입은 대변이 증가합니다.</p>
    <table><tr><th>일자</th><th>분개 ID</th><th>메모</th><th>차변</th><th>대변</th><th>증감</th></tr>
    ${rows}</table><p><a href="/admin/reports?fromDate=${encodeURIComponent(fromDate)}&throughDate=${encodeURIComponent(throughDate)}">보고서로 돌아가기</a></p>`);
}

function renderBackups(book, session, message = '') {
  if (session.role !== 'owner') throw new Error('Owner access required');
  const settings = backupSettings(book, session.sub);
  const rows = listBackups(book, session.sub).slice(0, 50).map(b => `<tr><td>${escape(b.created_at)}</td>
    <td>${escape(b.filename)}</td></tr>`).join('');
  return page('백업 설정', `${message}<p>서버의 백업 저장 경로: ${book.backupManager ?
    '설정됨' : '미설정 (BUDGETBOOK_BACKUP_DIR 환경 변수 필요)'}</p>
    <p>SQLite 일관성 검사 후 백업 파일을 저장합니다. 복구는 서버 관리자에게 파일 경로를 전달해 서버 중지 상태에서 진행합니다.</p>
    <form method="post" action="/admin/backups/settings">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}">
    <label>백업 주기 (일)</label><input type="number" name="intervalDays" min="1" max="30"
      value="${settings.intervalDays}" required>
    <label>보관할 최근 백업 수</label><input type="number" name="keepCount" min="1" max="365"
      value="${settings.keepCount}" required><button>설정 저장</button></form>
    ${book.backupManager ? `<form method="post" action="/admin/backups/run">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}"><button>지금 백업</button></form>` : ''}
    <h2>최근 백업</h2><table><tr><th>생성 시각 (UTC)</th><th>파일</th></tr>${rows}</table>`);
}

function renderAdjustments(book, session, message = '') {
  if (session.role !== 'owner') throw new Error('Owner access required');
  const accounts = [...book.accounts().values()];
  const options = accounts.map(a => `<option value="${escape(a.id)}">${escape(a.name)} (${a.type})</option>`).join('');
  const creditOptions = accounts.map((a, index) => `<option value="${escape(a.id)}" ${index === 1 ? 'selected' : ''}>
    ${escape(a.name)} (${a.type})</option>`).join('');
  const categories = [...book.budgetCategories().values()].map(c =>
    `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join('');
  const row = `<tr><td><select name="debitId">${options}</select></td>
    <td><select name="creditId">${creditOptions}</select></td>
    <td><input name="amountExpression" placeholder="10000+2500" required></td>
    <td><select name="categoryId"><option value="">없음</option>${categories}</select></td>
    <td><input name="lineMemo" maxlength="200"></td>
    <td><button type="button" data-remove-adjustment>삭제</button></td></tr>`;
  const batches = listAdjustments(book, session.sub).slice(0, 50).map(batch => `<tr>
    <td>${escape(batch.date)}</td><td>${escape(batch.reason)}</td><td>${batch.entryIds.length}</td>
    <td><a href="/admin/adjustments/detail?id=${encodeURIComponent(batch.id)}">분개 조회</a></td>
    <td>${batch.reversesBatchId ? '역분개 배치' : batch.reversalId ? '취소됨' :
      `<form method="post" action="/admin/adjustments/reverse">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="batchId" value="${escape(batch.id)}">
      <label>취소일</label><input type="date" name="date" required>
      <label>사유</label><input name="reason" maxlength="200" required>
      <button>역분개 기록</button></form>`}</td></tr>`).join('');
  return page('누락 거래 일괄 조정', `${message}
    <p>각 행은 차변과 대변이 같은 금액인 독립 분개입니다. 모든 행을 검증한 후 한꺼번에 기록합니다.
    잘못 저장했다면 원래 분개를 삭제하지 않고 역분개 배치를 기록합니다.</p>
    <form method="post" action="/admin/adjustments">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}">
    <input type="hidden" name="requestId" value="${randomUUID()}">
    <label>조정일</label><input type="date" name="date" required>
    <label>일괄 조정 사유</label><input name="reason" maxlength="200" required>
    <table><tr><th>차변 계정</th><th>대변 계정</th><th>금액</th><th>예산</th><th>메모</th><th></th></tr>
    <tbody id="adjustment-rows">${row}</tbody></table>
    <button type="button" id="add-adjustment-row">행 추가</button><button>모든 조정 저장</button></form>
    <template id="adjustment-row-template">${row}</template>
    <script defer src="/admin/assets/adjustment.js"></script>
    <h2>최근 조정 배치</h2><table><tr><th>일자</th><th>사유</th><th>분개</th><th>내역</th><th>취소</th></tr>
    ${batches}</table>`);
}

function renderAdjustmentDetail(book, session, id) {
  if (session.role !== 'owner') throw new Error('Owner access required');
  const batch = listAdjustments(book, session.sub).find(b => b.id === id);
  if (!batch) throw new Error('Adjustment batch not found');
  const accounts = book.accounts();
  const rows = batch.entryIds.flatMap(entryId => {
    const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
    if (!row) throw new Error('Adjustment entry missing');
    const entry = JSON.parse(row.data);
    return entry.postings.map(p => `<tr><td>${escape(entry.date)}</td><td>${escape(entry.id)}</td>
      <td>${escape(entry.memo)}</td><td>${escape(accounts.get(p.accountId)?.name ?? '')}</td>
      <td>${p.side === 'debit' ? escape(p.amount.toLocaleString('ko-KR')) : ''}</td>
      <td>${p.side === 'credit' ? escape(p.amount.toLocaleString('ko-KR')) : ''}</td></tr>`);
  }).join('');
  return page('조정 분개 내역', `<p>${escape(batch.date)} · ${escape(batch.reason)}</p>
    <table><tr><th>일자</th><th>분개 ID</th><th>메모</th><th>계정</th><th>차변</th><th>대변</th></tr>${rows}</table>
    <p><a href="/admin/adjustments">일괄 조정으로 돌아가기</a></p>`);
}

function renderBudget(book, session, month, message = '') {
  assertMonth(month);
  if (session.role !== 'owner') throw new Error('Owner access required');
  const budget = book.budget(month);
  const preview = previousBudgetPreview(book, session.sub, month);
  const targetPreview = budgetTargetPreview(book, session.sub, month);
  const targets = new Map(targetPreview.rows.map(row => [row.categoryId, row]));
  const categories = book.budgetCategories();
  const options = [...categories.values()].map(c => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join('');
  const moves = budgetMoves(book, session.sub, month).map(move => `<tr><td>${escape(move.createdAt)}</td>
    <td>${escape(categories.get(move.payload.fromCategoryId)?.name ?? move.payload.fromCategoryId)}</td>
    <td>${escape(categories.get(move.payload.toCategoryId)?.name ?? move.payload.toCategoryId)}</td>
    <td>${move.payload.amount.toLocaleString('ko-KR')}</td></tr>`).join('');
  const rows = Object.values(budget.categories).map(category => `<tr><td>${escape(category.name)}</td>
    <td>${category.budgeted.toLocaleString('ko-KR')}</td>
    <td>${category.spent.toLocaleString('ko-KR')}</td>
    <td>${category.balance.toLocaleString('ko-KR')}</td>
    <td><form method="post" action="/admin/budget"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="month" value="${escape(month)}">
      <input type="hidden" name="categoryId" value="${escape(category.categoryId)}">
      <input name="amountExpression" aria-label="${escape(category.name)} 예산" placeholder="월 배정액" required>
      <button>배정</button></form></td>
    <td><form method="post" action="/admin/budget/target"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="month" value="${escape(month)}"><input type="hidden" name="categoryId" value="${escape(category.categoryId)}">
      <input name="amountExpression" aria-label="${escape(category.name)} 매월 배정 목표" value="${targets.get(category.categoryId)?.target ?? 0}" required>
      <button>목표 저장</button></form>부족 배정 ${((targets.get(category.categoryId)?.needed) ?? 0).toLocaleString('ko-KR')}원</td></tr>`).join('');
  return page('월별 예산', `${message}<form method="get" action="/admin/budget">
    <label>월</label><input type="month" name="month" value="${escape(month)}"><button>조회</button></form>
    <p>온버짓 가용 자금: ${budget.availableFunds.toLocaleString('ko-KR')}원 ·
      미배정 자금: ${budget.readyToAssign.toLocaleString('ko-KR')}원</p>
    <form method="post" action="/admin/budget/copy-previous">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="month" value="${escape(month)}">
      <p>${escape(preview.fromMonth ?? '이전 달 없음')} 배정액에서 아직 입력하지 않은 ${preview.rows.length}항목,
      총 ${preview.total.toLocaleString('ko-KR')}원을 복사합니다. 이번 달에 입력한 금액은 0원도 그대로 유지합니다.</p>
      <button ${preview.rows.length ? '' : 'disabled'}>이전 달 예산 복사</button></form>
    <p>매월 배정 목표는 이번 달 배정액과 비교합니다. 이월 잔액과 지출은 목표 계산에 포함하지 않습니다. 목표를 0원으로 저장하면 해제합니다.</p>
    <table><tr><th>카테고리</th><th>이번 달 배정</th><th>이번 달 지출</th><th>이월 포함 잔액</th><th>배정 변경</th><th>매월 목표</th></tr>${rows}</table>
    <form method="post" action="/admin/budget/fill-targets">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="month" value="${escape(month)}">
      <input type="hidden" name="requestId" value="${randomUUID()}">
      <p>목표 부족액 합계 ${targetPreview.total.toLocaleString('ko-KR')}원 · 채운 후 미배정 자금 ${(budget.readyToAssign - targetPreview.total).toLocaleString('ko-KR')}원</p>
      <button ${targetPreview.total > 0 ? '' : 'disabled'}>이번 달 목표 부족액 채우기</button></form>
    <h2>카테고리 간 예산 이동</h2><p>이번 달 배정액 안에서 이동합니다. 총 배정액은 유지하며, 지출과 이월액은 이동하지 않습니다.</p>
    <form method="post" action="/admin/budget/move">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="month" value="${escape(month)}">
      <input type="hidden" name="requestId" value="${randomUUID()}">
      <label>보내는 카테고리</label><select name="fromCategoryId">${options}</select>
      <label>받는 카테고리</label><select name="toCategoryId">${options}</select>
      <label>이동 금액 (사칙연산 가능)</label><input name="amountExpression" required>
      <button ${categories.size < 2 ? 'disabled' : ''}>예산 이동</button></form>
    <h2>이번 달 최근 이동 기록</h2><table><tr><th>저장 시각 (UTC)</th><th>보내는 항목</th><th>받는 항목</th><th>금액</th></tr>${moves}</table>`);
}

function renderCards(book, session, throughDate, message = '') {
  assertDate(throughDate);
  const accounts = [...book.accounts().values()];
  const cards = accounts.filter(a => a.card && a.type === 'liability' &&
    canAccessAccount(book, session.sub, a.id, 'write'));
  const cash = accounts.filter(a => a.cash && a.type === 'asset' &&
    canAccessAccount(book, session.sub, a.id, 'write'));
  const expenses = accounts.filter(a => a.type === 'expense');
  const categories = [...book.budgetCategories().values()];
  const options = (values, selected) => values.map(a => `<option value="${escape(a.id)}" ${a.id === selected ? 'selected' : ''}>${escape(a.name)}</option>`).join('');
  const purchase = cards.length && expenses.length ? `<h2>카드 구매·할부 등록</h2>
    <form method="post" action="/admin/cards/purchase">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}">
    <input type="hidden" name="requestId" value="${randomUUID()}">
    <label>카드</label><select name="cardId">${options(cards)}</select>
    <label>구매일</label><input type="date" name="date" required>
    <label>비용 계정</label><select name="expenseId">${options(expenses)}</select>
    <label>금액 (사칙연산 가능)</label><input name="amountExpression" required>
    <label>할부 개월 수 (일시불은 1)</label><input type="number" name="count" min="1" max="120" value="1" required>
    <label>첫 결제 예정일</label><input type="date" name="firstDueDate" required>
    <label>예산 카테고리 (온버짓 카드만)</label><select name="categoryId"><option value="">없음</option>${options(categories)}</select>
    <label>메모</label><input name="memo"><button>구매 저장</button></form>` :
    '<p>카드와 비용 계정을 등록해야 구매 내역을 입력할 수 있습니다.</p>';
  const schedule = visibleCardSchedule(book, session.sub, throughDate);
  const grouped = new Map();
  for (const row of schedule) grouped.set(row.dueDate.slice(0, 7),
    (grouped.get(row.dueDate.slice(0, 7)) ?? 0) + row.amount);
  const months = [...grouped].map(([month, total]) =>
    `<tr><td>${escape(month)}</td><td>${escape(total.toLocaleString('ko-KR'))}원</td></tr>`).join('');
  const rows = schedule.map(row => `<tr><td>${cash.length && canAccessAccount(book, session.sub, row.cardId, 'write') ?
    `<input type="checkbox" form="card-bulk-pay" name="item" value="${escape(JSON.stringify([row.planId, row.index]))}" aria-label="${escape(row.memo)} ${row.index}회차 선택" style="width:auto">` : ''}</td><td>${escape(row.dueDate)}</td>
    <td>${escape(accounts.find(a => a.id === row.cardId)?.name ?? '')}</td>
    <td>${escape(row.memo)}</td><td>${row.index}회차</td>
    <td>${escape(row.amount.toLocaleString('ko-KR'))}원</td><td>${cash.length &&
      canAccessAccount(book, session.sub, row.cardId, 'write') ?
      `<form method="post" action="/admin/cards/pay"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="planId" value="${escape(row.planId)}"><input type="hidden" name="index" value="${row.index}">
      <label>실제 결제일</label><input type="date" name="date" value="${escape(row.dueDate)}" required>
      <label>출금 계좌</label><select name="cashId">${options(cash, cardCashDefault(book, session.sub, row.cardId))}</select><button>결제 기록</button></form>` : ''}</td></tr>`).join('');
  const defaults = session.role !== 'owner' ? '' : `<h2>카드별 기본 출금 계좌</h2>${cards.map(card =>
    `<form method="post" action="/admin/cards/default-cash"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
    <input type="hidden" name="cardId" value="${escape(card.id)}"><input type="hidden" name="throughDate" value="${escape(throughDate)}">
    <label>${escape(card.name)} 출금 계좌</label><select name="cashId"><option value="">기본값 해제</option>
    ${options(cash, cardCashDefault(book, session.sub, card.id))}</select><button>기본 계좌 저장</button></form>`).join('')}`;
  return page('카드 예정액', `${message}${purchase}${defaults}<h2>미결제 할부 예정액</h2>
    <form method="get" action="/admin/cards"><label>조회 종료일</label>
    <input type="date" name="throughDate" value="${escape(throughDate)}"><button>조회</button></form>
    <table><tr><th>월</th><th>결제 예정액</th></tr>${months}</table>
    <table><tr><th>묶음 선택</th><th>예정일</th><th>카드</th><th>메모</th><th>회차</th><th>금액</th><th>결제</th></tr>${rows}</table>
    ${cards.length && cash.length ? `<h2>선택한 회차 묶음 납부</h2><p>2~100회차를 선택하고 실제 결제일과 공통 출금 계좌를 지정하세요.</p>
    <form id="card-bulk-pay" method="post" action="/admin/cards/pay-batch">
    <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="requestId" value="${randomUUID()}">
    <input type="hidden" name="throughDate" value="${escape(throughDate)}">
    <label>실제 결제일</label><input type="date" name="date" required>
    <label>묶음 납부 출금 계좌</label><select name="cashId">${options(cash)}</select><button>선택한 회차 납부 기록</button></form>` : ''}`);
}

function renderForecast(book, session, query, message = '') {
  if (session.role !== 'owner') throw new Error('Owner access required');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const asOf = query.get('asOf') || today;
  const throughDate = query.get('throughDate') || addMonths(today, 12);
  const cash = [...book.accounts().values()].filter(a => a.cash);
  const schedules = listSchedules(book, session.sub);
  const cardCashId = query.get('cardCashId') || '';
  const cardMode = query.get('cardMode') || (cardCashId ? 'override' : 'defaults');
  if (!['defaults', 'override', 'exclude'].includes(cardMode)) throw new Error('Invalid card forecast mode');
  if (cardMode === 'override' && !cardCashId) throw new Error('Select a common card cash account');
  const overrides = Object.fromEntries(schedules.filter(s => query.has(`amount_${s.id}`))
    .map(s => [s.id, query.get(`amount_${s.id}`)]));
  const result = forecast(book, session.sub, { asOf, throughDate,
    cardCashId: cardMode === 'override' ? cardCashId : undefined,
    useCardDefaults: cardMode === 'defaults', overrides });
  const missingCards = result.missingCardAccounts.map(item => `<li>${escape(item.name)}:
    ${item.count}회차, ${item.amount.toLocaleString('ko-KR')}원</li>`).join('');
  const cashOptions = cash.map(a => `<option value="${escape(a.id)}" ${a.id === cardCashId ? 'selected' : ''}>
    ${escape(a.name)}</option>`).join('');
  const accountOptions = cash.map(a => `<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('');
  const scheduleRows = schedules.map(s => `<tr><td>${escape(s.name)}</td>
    <td>${escape(cash.find(a => a.id === s.accountId)?.name ?? '')}</td>
    <td>${escape(s.startDate)} · ${s.frequency === 'monthly' ? '매월' : '1회'}</td>
    <td>${escape(s.amount.toLocaleString('ko-KR'))}</td><td><details><summary>수정</summary>
      <form method="post" action="/admin/forecast/schedules">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="id" value="${escape(s.id)}">
      <label>이름</label><input name="name" value="${escape(s.name)}" required>
      <label>현금 계좌</label><select name="accountId">${cash.map(a =>
    `<option value="${escape(a.id)}" ${s.accountId === a.id ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select>
      <label>금액</label><input name="amountExpression" value="${escape(s.amount)}" required>
      <label>첫 예정일</label><input type="date" name="startDate" value="${escape(s.startDate)}" required>
      <label>마지막 예정일</label><input type="date" name="endDate" value="${escape(s.endDate ?? '')}">
      <label>반복</label><select name="frequency"><option value="monthly" ${s.frequency === 'monthly' ? 'selected' : ''}>매월</option>
      <option value="once" ${s.frequency === 'once' ? 'selected' : ''}>한 번</option></select>
      <button>수정 저장</button></form></details>${s.active ?
      `<form method="post" action="/admin/forecast/disable"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="id" value="${escape(s.id)}"><button>중지</button></form>` : '중지됨'}</td></tr>`).join('');
  const overrideInputs = schedules.filter(s => s.active).map(s =>
    `<label>${escape(s.name)} 예상 금액 (원, 음수는 지출)</label>
    <input name="amount_${escape(s.id)}" value="${escape(overrides[s.id] ?? s.amount)}">`).join('');
  const eventRows = result.events.map(e => {
    const candidates = e.scheduleId ? matchingEntries(book, session.sub, e.scheduleId, e.date) : [];
    const link = candidates.length ? `<form method="post" action="/admin/forecast/link">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="scheduleId" value="${escape(e.scheduleId)}">
      <input type="hidden" name="date" value="${escape(e.date)}">
      <input type="hidden" name="asOf" value="${escape(asOf)}">
      <input type="hidden" name="throughDate" value="${escape(throughDate)}">
      <input type="hidden" name="cardCashId" value="${escape(cardCashId)}">
      <input type="hidden" name="cardMode" value="${escape(cardMode)}">
      <select name="entryId">${candidates.map(entry => `<option value="${escape(entry.id)}">
      ${escape(entry.date)} ${escape(entry.memo ?? entry.id)}</option>`).join('')}</select>
      <button>실제 거래 연결</button></form>` : '';
    return `<tr><td>${escape(e.date)}</td><td>${escape(e.type)}</td>
    <td>${escape(e.name)}</td><td>${escape(cash.find(a => a.id === e.accountId)?.name ?? '')}</td>
    <td>${escape(e.amount.toLocaleString('ko-KR'))}</td>
    <td>${escape(e.projectedBalance.toLocaleString('ko-KR'))}${link}</td></tr>`;
  }).join('');
  const linkedRows = linkedOccurrences(book, session.sub).map(row => `<tr>
    <td>${escape(schedules.find(s => s.id === row.schedule_id)?.name ?? '')}</td>
    <td>${escape(row.occurrence_date)}</td><td>${escape(row.entry_id)}</td>
    <td><form method="post" action="/admin/forecast/unlink">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="scheduleId" value="${escape(row.schedule_id)}">
      <input type="hidden" name="date" value="${escape(row.occurrence_date)}"><button>연결 해제</button>
      <input type="hidden" name="asOf" value="${escape(asOf)}"><input type="hidden" name="throughDate" value="${escape(throughDate)}">
      <input type="hidden" name="cardMode" value="${escape(cardMode)}"><input type="hidden" name="cardCashId" value="${escape(cardCashId)}">
    </form></td></tr>`).join('');
  const autoForms = schedules.filter(s => s.active).map(s => {
    const dates = result.events.filter(e => e.scheduleId === s.id).map(e => e.date);
    if (!dates.length) return '';
    return `<form method="post" action="/admin/forecast/auto-link" style="display:inline">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="scheduleId" value="${escape(s.id)}">
      ${dates.map(date => `<input type="hidden" name="date" value="${escape(date)}">`).join('')}
      <input type="hidden" name="asOf" value="${escape(asOf)}"><input type="hidden" name="throughDate" value="${escape(throughDate)}">
      <input type="hidden" name="cardMode" value="${escape(cardMode)}"><input type="hidden" name="cardCashId" value="${escape(cardCashId)}">
      <button>자동 매칭: ${escape(s.name)}</button></form>`;
  }).join('');
  return page('현금흐름 예상', `${message}<p>현금성 계좌 합계: 시작 ${result.openingTotal.toLocaleString('ko-KR')}원 →
    종료 예상 ${result.projectedTotal.toLocaleString('ko-KR')}원</p>
    ${missingCards ? `<p class="error">기본 출금 계좌가 없어 예상에 포함되지 않은 카드 예정액입니다. <a href="/admin/cards">카드 설정</a>에서 계좌를 지정하세요.</p><ul>${missingCards}</ul>` : ''}
    <p>예정 거래는 실제 원장에 기록되지 않습니다. 이미 입력한 미래 일자 거래는 별도 확정 거래로 표시됩니다.</p>
    <h2>조회·임시 시뮬레이션</h2><form method="get" action="/admin/forecast">
      <label>기준일</label><input type="date" name="asOf" value="${escape(asOf)}" required>
      <label>종료일 (최대 10년)</label><input type="date" name="throughDate" value="${escape(throughDate)}" required>
      <label>카드 예상 방식</label><select name="cardMode">
      <option value="defaults" ${cardMode === 'defaults' ? 'selected' : ''}>카드별 기본 출금 계좌</option>
      <option value="override" ${cardMode === 'override' ? 'selected' : ''}>공통 출금 계좌로 시뮬레이션</option>
      <option value="exclude" ${cardMode === 'exclude' ? 'selected' : ''}>카드 예정액 제외</option></select>
      <label>시뮬레이션 공통 출금 계좌</label><select name="cardCashId"><option value="">계좌 선택</option>
      ${cashOptions}</select>${overrideInputs}<button>다시 계산</button></form>
    <h2>예정 거래 추가</h2><form method="post" action="/admin/forecast/schedules">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <label>이름</label><input name="name" required>
      <label>현금 계좌</label><select name="accountId">${accountOptions}</select>
      <label>금액 (수입은 양수, 지출은 음수)</label><input name="amountExpression" placeholder="-100000" required>
      <label>첫 예정일</label><input type="date" name="startDate" required>
      <label>마지막 예정일 (선택)</label><input type="date" name="endDate">
      <label>반복</label><select name="frequency"><option value="monthly">매월</option>
      <option value="once">한 번</option></select><button>예정 거래 저장</button></form>
    <h2>등록된 예정 거래</h2><table><tr><th>이름</th><th>계좌</th><th>시작·반복</th><th>금액</th><th>상태</th></tr>${scheduleRows}</table>
    <h2>예상 상세</h2><table><tr><th>날짜</th><th>구분</th><th>내역</th><th>계좌</th>
    <th>변동</th><th>예상 잔액·연결</th></tr>${eventRows}</table><p>${autoForms}</p>
    <h2>실제 거래 연결 내역</h2><table><tr><th>예정 거래</th><th>회차 예정일</th>
    <th>원장 거래 ID</th><th>관리</th></tr>${linkedRows}</table>`);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

async function formBody(req) {
  if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    throw new Error('Invalid form content type');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error('Form too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function fields(form) {
  return Object.fromEntries(['amount', 'date', 'payee', 'memo'].map(key =>
    [key, String(form.get(key) ?? '')]));
}

function renderConfig(book, session, accountId, values, message = '') {
  const accounts = visibleAccounts(book, session.sub).filter(a => ['asset', 'liability'].includes(a.type));
  if (accountId && !accounts.some(a => a.id === accountId)) throw new Error('Account access denied');
  const selected = accounts.find(a => a.id === accountId) ?? accounts[0];
  if (!selected) return page('정규식 설정', '<p>먼저 계좌를 등록하세요.</p>');
  const rules = values ?? getParserRules(book, session.sub, selected.id) ?? {};
  const inputs = [['amount', '금액', '(?:금액\\s*)([\\d,]+)'],
    ['date', '일자 (YYYY-MM-DD)', '(\\d{4}[-.]\\d{2}[-.]\\d{2})'],
    ['payee', '거래처', '가맹점\\s*([^\\n]+)'], ['memo', '메모', '']]
    .map(([key, name, example]) => `<label for="${key}">${name}</label>
      <input id="${key}" name="${key}" value="${escape(rules[key] ?? '')}" placeholder="${escape(example)}">`).join('');
  const options = accounts.map(a => `<option value="${escape(a.id)}"${a.id === selected.id ? ' selected' : ''}>${escape(a.name)} (${escape(a.id)})</option>`).join('');
  const userKeys = book.db.prepare('SELECT id FROM user_api_keys WHERE user_sub = ? AND revoked = 0')
    .all(session.sub).map(row => ({ ...row, type: 'api', label: 'API 키' }));
  const accountKeys = book.db.prepare('SELECT id FROM account_keys WHERE user_sub = ? AND account_id = ? AND revoked = 0')
    .all(session.sub, selected.id).map(row => ({ ...row, type: 'account', label: '계정 키' }));
  const keyRows = [...userKeys, ...accountKeys].map(key => `<li>${key.label}: ${escape(key.id)}
    <form method="post" action="/admin/revoke"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="accountId" value="${escape(selected.id)}">
      <input type="hidden" name="keyId" value="${escape(key.id)}">
      <input type="hidden" name="type" value="${key.type}"><button>폐기</button></form></li>`).join('');
  return page('앱 푸시 정규식 설정', `${message}
    <p>각 필드는 <strong>첫 번째 캡처 그룹</strong>에서 값을 읽습니다. 필수 항목은 금액과 일자입니다.
    정규식은 계좌별로 저장하며 원문 테스트는 원장에 거래를 생성하지 않습니다.</p>
    <form method="get" action="/admin/regex"><label>대상 계좌</label><select name="accountId">${options}</select><button>선택</button></form>
    <form method="post" action="/admin/regex"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="accountId" value="${escape(selected.id)}">${inputs}
      <button name="action" value="test">원문으로 시험</button> <button name="action" value="save">규칙 저장</button>
      <label for="rawText">시험할 앱 푸시 원문</label><textarea id="rawText" name="rawText" rows="4">${escape(values?.rawText ?? '')}</textarea>
    </form><h2>API 자격증명</h2><p>API 키는 사용자를, 계정 키는 이 계좌를 식별합니다. 새 키는 생성 후 한 번만 표시됩니다.</p>
    <form method="post" action="/admin/keys"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="accountId" value="${escape(selected.id)}">
      <button name="type" value="api">API 키 생성</button> <button name="type" value="account">계정 키 생성</button></form>
    <h3>현재 활성 키</h3><ul>${keyRows || '<li>없음</li>'}</ul>`);
}

function renderReview(book, session, message = '') {
  const events = listReviewEvents(book, session.sub);
  const counters = [...book.accounts().values()].filter(a => ['expense', 'income'].includes(a.type));
  const categories = [...book.budgetCategories().values()];
  const rows = events.map(event => {
    const canEdit = canAccessAccount(book, session.sub, event.accountId, 'write');
    const options = counters.map(a => `<option value="${escape(a.id)}">${escape(a.name)} (${a.type})</option>`).join('');
    const categoryOptions = categories.map(c => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join('');
    const form = event.status === 'approved' ? `<p>승인 분개: ${escape(event.approvedEntryId)}</p>` :
      !canEdit ? '<p>읽기 권한만 있습니다.</p>' : `<form method="post" action="/admin/approve">
      <input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="eventId" value="${escape(event.id)}">
      <label>유형</label><select name="kind"><option value="expense">지출</option><option value="income">수입</option></select>
      <label>금액(원)</label><input name="amount" inputmode="numeric" value="${escape(Math.abs(event.parsed?.amount ?? 0) || '')}">
      <label>일자</label><input name="date" value="${escape(event.parsed?.date ?? '')}">
      <label>거래처·메모</label><input name="payee" value="${escape(event.parsed?.payee ?? '')}">
      <label>상대 계정</label><select name="counterAccountId">${options}</select>
      <label>예산 카테고리 (온버짓 지출만)</label><select name="categoryId"><option value="">없음</option>${categoryOptions}</select>
      <button>원장에 승인</button></form>`;
    return `<section><h2>${escape(book.accounts().get(event.accountId)?.name)} · ${escape(event.status)}</h2>
      <p>수신 ID: ${escape(event.id)}</p><pre>${escape(event.rawText)}</pre>
      ${event.parseError ? `<p class="error">파싱: ${escape(event.parseError)}</p>` : ''}
      ${form}</section><hr>`;
  }).join('');
  return page('수신 거래 검토', `${message}${rows || '<p>수신 내역이 없습니다.</p>'}`);
}

function renderFamily(book, session, message = '') {
  const members = book.db.prepare("SELECT user_sub, role FROM family_members WHERE role <> 'owner' ORDER BY user_sub").all();
  const accounts = [...book.accounts().values()].filter(a => ['asset', 'liability'].includes(a.type));
  const checkboxes = accounts.map(a => `<label><input type="checkbox" name="accountId" value="${escape(a.id)}"
    style="width:auto"> ${escape(a.name)}</label>`).join('');
  const rows = members.map(person => `<li>${escape(person.user_sub)} (${escape(person.role)})
    <form method="post" action="/admin/family/remove"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="sub" value="${escape(person.user_sub)}"><button>구성원 제거</button></form></li>`).join('');
  return page('가족 구성원 관리', `${message}<p>Pocket ID 사용자의 정확한 sub를 입력합니다.
    읽기 권한은 수신 내역을 볼 수 있고, 편집 권한은 지정 계좌의 정규식·키·거래 승인을 관리할 수 있습니다.</p>
    <form method="post" action="/admin/family"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <label>사용자 sub</label><input name="sub" required>
      <label>역할</label><select name="role"><option value="viewer">읽기</option><option value="editor">편집</option></select>
      <fieldset><legend>접근할 계좌</legend>${checkboxes}</fieldset><button>구성원 저장</button></form>
    <h2>등록된 구성원</h2><ul>${rows || '<li>없음</li>'}</ul>`);
}

export async function handleAdmin(book, auth, req, res, pathname) {
  if (pathname === '/auth/login') { await auth.start(res); return true; }
  if (pathname === '/auth/callback') {
    try { await auth.callback(req, res); }
    catch { sendHtml(res, 401, page('로그인 실패', '<p>인증 또는 접근 권한을 확인하세요.</p>')); }
    return true;
  }
  if (pathname === '/auth/logout') { auth.logout(req, res); return true; }
  if (!pathname.startsWith('/admin/')) return false;
  const session = auth.session(req);
  if (!session) { res.writeHead(302, { Location: '/auth/login', 'Cache-Control': 'no-store' }); res.end(); return true; }
  try {
    if (req.method === 'GET' && pathname === '/admin/assets/adjustment.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(readFileSync(new URL('./adjustment-ui.js', import.meta.url))); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/adjustments') {
      sendHtml(res, 200, renderAdjustments(book, session)); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/adjustments/detail') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      sendHtml(res, 200, renderAdjustmentDetail(book, session, id)); return true;
    }
    if (req.method === 'POST' && ['/admin/adjustments', '/admin/adjustments/reverse'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) {
        sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true;
      }
      if (session.role !== 'owner') throw new Error('Owner access required');
      if (pathname.endsWith('/reverse')) reverseAdjustment(book, session.sub, {
        batchId: form.get('batchId'), date: form.get('date'), reason: form.get('reason'),
      });
      else {
        const debit = form.getAll('debitId');
        const credit = form.getAll('creditId');
        const amount = form.getAll('amountExpression');
        const category = form.getAll('categoryId');
        const memo = form.getAll('lineMemo');
        if (![credit, amount, category, memo].every(values => values.length === debit.length)) {
          throw new Error('Incomplete adjustment row');
        }
        recordAdjustment(book, session.sub, { requestId: form.get('requestId'),
          date: form.get('date'), reason: form.get('reason'),
          rows: debit.map((debitId, i) => ({ debitId, creditId: credit[i],
            amountExpression: amount[i], categoryId: category[i] || null, memo: memo[i] })) });
      }
      sendHtml(res, 200, renderAdjustments(book, session,
        '<p class="notice">조정 배치를 기록했습니다.</p>')); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/backups') {
      sendHtml(res, 200, renderBackups(book, session)); return true;
    }
    if (req.method === 'POST' && ['/admin/backups/settings', '/admin/backups/run'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) {
        sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true;
      }
      if (session.role !== 'owner') throw new Error('Owner access required');
      if (pathname.endsWith('settings')) configureBackups(book, session.sub, {
        intervalDays: Number(form.get('intervalDays')), keepCount: Number(form.get('keepCount')),
      });
      else {
        if (!book.backupManager) throw new Error('Backup directory is not configured');
        await book.backupManager.run();
      }
      sendHtml(res, 200, renderBackups(book, session, '<p class="notice">백업 설정을 반영했습니다.</p>'));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/forecast') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      sendHtml(res, 200, renderForecast(book, session, query)); return true;
    }
    if (req.method === 'POST' && ['/admin/forecast/schedules', '/admin/forecast/disable',
      '/admin/forecast/link', '/admin/forecast/unlink', '/admin/forecast/auto-link'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) {
        sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true;
      }
      if (pathname.endsWith('disable')) disableSchedule(book, session.sub, form.get('id'));
      else if (pathname.endsWith('unlink')) unlinkOccurrence(book, session.sub, {
        scheduleId: form.get('scheduleId'), date: form.get('date'),
      });
      else if (pathname.endsWith('auto-link')) autoLinkMatches(book, session.sub, {
        scheduleId: form.get('scheduleId'), dates: form.getAll('date'),
      });
      else if (pathname.endsWith('link')) linkOccurrence(book, session.sub, {
        scheduleId: form.get('scheduleId'), date: form.get('date'), entryId: form.get('entryId'),
      });
      else saveSchedule(book, session.sub, {
        id: form.get('id') || null, name: form.get('name'), accountId: form.get('accountId'),
        amountExpression: form.get('amountExpression'), startDate: form.get('startDate'),
        endDate: form.get('endDate'), frequency: form.get('frequency'),
      });
      sendHtml(res, 200, renderForecast(book, session, new URLSearchParams({
        asOf: form.get('asOf') || '', throughDate: form.get('throughDate') || '',
        cardCashId: form.get('cardCashId') || '',
        cardMode: form.get('cardMode') || (form.get('cardCashId') ? 'override' : 'defaults'),
      }),
        '<p class="notice">예정 거래를 변경했습니다.</p>'));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/cards') {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const throughDate = new URL(req.url, 'http://localhost').searchParams.get('throughDate') ||
        `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-${today.slice(8, 10)}`;
      sendHtml(res, 200, renderCards(book, session, throughDate)); return true;
    }
    if (req.method === 'POST' && pathname === '/admin/cards/default-cash') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const throughDate = form.get('throughDate');
      assertDate(throughDate);
      setCardCashDefault(book, session.sub, form.get('cardId'), form.get('cashId') || null);
      sendHtml(res, 200, renderCards(book, session, throughDate, '<p class="notice">카드 기본 출금 계좌를 저장했습니다.</p>'));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/cards/pay-batch') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const throughDate = form.get('throughDate');
      assertDate(throughDate);
      const items = form.getAll('item').map(value => {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('Invalid installment selection');
        return { planId: parsed[0], index: parsed[1] };
      });
      const result = recordCardPaymentBatch(book, session.sub, { items, requestId: form.get('requestId'),
        date: form.get('date'), cashId: form.get('cashId') });
      sendHtml(res, 200, renderCards(book, session, throughDate,
        `<p class="notice">${result.duplicate ? '이미 처리한' : '처리한'} 묶음 납부: ${result.entries.length}회차, ${result.total.toLocaleString('ko-KR')}원</p>`));
      return true;
    }
    if (req.method === 'POST' && ['/admin/cards/purchase', '/admin/cards/pay'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) {
        sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true;
      }
      const result = pathname.endsWith('purchase') ? recordCardPurchase(book, session.sub, {
        requestId: form.get('requestId'), date: form.get('date'), cardId: form.get('cardId'),
        expenseId: form.get('expenseId'), amountExpression: form.get('amountExpression'),
        count: form.get('count'), firstDueDate: form.get('firstDueDate'),
        categoryId: form.get('categoryId') || null, memo: form.get('memo') || '',
      }) : recordCardPayment(book, session.sub, {
        planId: form.get('planId'), index: Number(form.get('index')),
        date: form.get('date'), cashId: form.get('cashId'),
      });
      const throughDate = pathname.endsWith('purchase') ?
        result.plan.installments.at(-1).dueDate : '9999-12-31';
      sendHtml(res, 200, renderCards(book, session, throughDate,
        '<p class="notice">카드 거래를 기록했습니다.</p>'));
      return true;
    }
    if (req.method === 'GET' && ['/admin/assets/split.js', '/admin/assets/split-paste.js',
      '/admin/assets/amount-expression.js'].includes(pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      const file = pathname.endsWith('/split.js') ? 'split-ui.js' : pathname.split('/').at(-1);
      res.end(readFileSync(new URL(`./${file}`, import.meta.url)));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/split') {
      const accountId = new URL(req.url, 'http://localhost').searchParams.get('accountId');
      sendHtml(res, 200, renderSplit(book, session, accountId)); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/split/edit') {
      const entryId = new URL(req.url, 'http://localhost').searchParams.get('entryId');
      const entry = editableManual(book, session.sub, entryId);
      if (!entry) throw new Error('Split transaction cannot be edited');
      sendHtml(res, 200, renderSplit(book, session, entry.sourceAccountId, entryId)); return true;
    }
    if (req.method === 'POST' && ['/admin/split', '/admin/split/update'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const ids = form.getAll('counterId');
      const amounts = form.getAll('lineAmount');
      const categories = form.getAll('lineCategory');
      if (ids.length !== amounts.length || (categories.length !== 0 && categories.length !== ids.length)) {
        throw new Error('Split rows are incomplete');
      }
      const input = { date: form.get('date'), kind: form.get('kind'), accountId: form.get('accountId'),
        memo: form.get('memo') ?? '', requestId: form.get('requestId'),
        lines: ids.map((counterId, index) => ({ counterId, amountExpression: amounts[index],
          categoryId: categories[index] || null })) };
      const result = pathname.endsWith('/update') ?
        { entry: updateSplitManual(book, session.sub, form.get('entryId'),
          Number(form.get('revision')), input), duplicate: false } : recordSplitManual(book, session.sub, input);
      sendHtml(res, 200, renderSplit(book, session, input.accountId, result.entry.id,
        `<p class="notice">${result.duplicate ? '이미 저장된' : '저장한'} 분할 거래입니다.</p>`));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/transactions/reverse') {
      sendHtml(res, 200, renderManualReversal(book, session, new URL(req.url, 'http://localhost').searchParams.get('entryId')));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/transactions/reverse') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      reverseManualTransaction(book, session.sub, { entryId: form.get('entryId'), date: form.get('date'), reason: form.get('reason'),
        expectedHash: form.get('expectedHash'), requestId: form.get('requestId') });
      sendHtml(res, 200, renderManualReversal(book, session, form.get('entryId'), '<p class="notice">거래 취소를 기록했습니다.</p>'));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/accounts') {
      sendHtml(res, 200, renderAccounts(book, session)); return true;
    }
    if (req.method === 'POST' && ['/admin/balance-check/lock', '/admin/balance-check/unlock'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const { lock } = pathname.endsWith('/unlock') ? unlockAccountPeriod(book, session.sub, {
        accountId: form.get('accountId'), expectedLockId: form.get('expectedLockId'), reason: form.get('reason'), requestId: form.get('requestId') }) :
        lockAccountPeriod(book, session.sub, form.get('comparisonId'), form.get('requestId'));
      sendHtml(res, 200, renderBalanceCheck(book, session, new URLSearchParams({ accountId: lock.accountId }),
        `<p class="notice">기간 잠금 ${pathname.endsWith('/unlock') ? '해제' : '설정'}를 저장했습니다.</p>`));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/balance-check/complete') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const { comparison } = completeStatementReview(book, session.sub, form.get('comparisonId'));
      const query = new URLSearchParams({ accountId: comparison.account.id, throughDate: comparison.throughDate,
        statementBalance: comparison.statementBalance });
      sendHtml(res, 200, renderBalanceCheck(book, session, query, '<p class="notice">검토 완료를 표시했습니다.</p>'));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/balance-check/save') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      saveStatementComparison(book, session.sub, { accountId: form.get('accountId'), throughDate: form.get('throughDate'),
        statementExpression: form.get('statementBalance'), expectedHash: form.get('expectedHash'), requestId: form.get('requestId') });
      sendHtml(res, 200, renderBalanceCheck(book, session, form, '<p class="notice">비교 결과 이력을 저장했습니다.</p>'));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/review-overview') {
      sendHtml(res, 200, renderReviewOverview(book, session, new URL(req.url, 'http://localhost').searchParams));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/balance-check') {
      sendHtml(res, 200, renderBalanceCheck(book, session, new URL(req.url, 'http://localhost').searchParams));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/transactions/edit') {
      sendHtml(res, 200, renderManualEdit(book, session, new URL(req.url, 'http://localhost').searchParams.get('entryId')));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/transactions/update') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const result = updateManualTransaction(book, session.sub, { entryId: form.get('entryId'), expectedHash: form.get('expectedHash'),
        updateRequestId: form.get('updateRequestId'), accountId: form.get('accountId'), kind: form.get('kind'), date: form.get('date'),
        counterId: form.get('counterId'), amountExpression: form.get('amountExpression'), categoryId: form.get('categoryId') || null,
        memo: form.get('memo') ?? '' });
      sendHtml(res, 200, renderRegister(book, session, result.entry.sourceAccountId,
        `<p class="notice">${result.duplicate ? '이미 처리한 수정 요청입니다.' : '거래를 수정했습니다. 변경 이력을 확인하고 거래를 다시 확인하세요.'}</p>`));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/transactions/history') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      sendHtml(res, 200, renderTransactionHistory(book, session, query.get('accountId'), query.get('entryId')));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/register/export.csv') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const csv = registerTransactionsCsv(book, session.sub, query.get('accountId'), query);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="budgetbook-register.csv"',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(csv); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/register') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      sendHtml(res, 200, renderRegister(book, session, query.get('accountId'), '', registerFilters(query))); return true;
    }
    if (req.method === 'POST' && pathname === '/admin/register/check-selected') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const filters = registerFilters(form);
      const count = confirmTransactions(book, session.sub, form.get('accountId'), form.getAll('selection').map(value => JSON.parse(value)));
      sendHtml(res, 200, renderRegister(book, session, form.get('accountId'), `<p class="notice">${count}건의 거래를 확인했습니다.</p>`, filters));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/register/check') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      if (!['true', 'false'].includes(form.get('checked'))) throw new Error('Invalid confirmation status');
      const accountId = form.get('accountId');
      const filters = registerFilters(form);
      setTransactionChecked(book, session.sub, accountId, form.get('entryId'), form.get('checked') === 'true', form.get('expectedHash'));
      sendHtml(res, 200, renderRegister(book, session, accountId, '<p class="notice">거래 확인 상태를 저장했습니다.</p>', filters));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/reports') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const fromDate = query.get('fromDate') || `${today.slice(0, 7)}-01`;
      const throughDate = query.get('throughDate') || today;
      sendHtml(res, 200, renderReports(book, session, fromDate, throughDate)); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/reports/cash.csv') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const fromDate = query.get('fromDate');
      const throughDate = query.get('throughDate');
      const csv = cashMovementsCsv(book, session.sub, fromDate, throughDate);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="budgetbook-cash-${fromDate}-${throughDate}.csv"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(csv); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/reports/account.csv') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const fromDate = query.get('fromDate');
      const throughDate = query.get('throughDate');
      const csv = accountActivityCsv(book, session.sub, query.get('accountId'), fromDate, throughDate);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="budgetbook-account-${fromDate}-${throughDate}.csv"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(csv); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/reports/account') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      sendHtml(res, 200, renderAccountActivity(book, session, query.get('accountId'),
        query.get('fromDate'), query.get('throughDate'))); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/budget') {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const month = new URL(req.url, 'http://localhost').searchParams.get('month') || today.slice(0, 7);
      sendHtml(res, 200, renderBudget(book, session, month)); return true;
    }
    if (req.method === 'POST' && pathname === '/admin/budget/copy-previous') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const month = form.get('month');
      const result = copyPreviousBudget(book, session.sub, month);
      sendHtml(res, 200, renderBudget(book, session, month,
        `<p class="notice">${result.count}항목, ${result.total.toLocaleString('ko-KR')}원을 복사했습니다.</p>`));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/budget/move') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const month = form.get('month');
      const result = moveBudget(book, session.sub, { month, requestId: form.get('requestId'),
        fromCategoryId: form.get('fromCategoryId'), toCategoryId: form.get('toCategoryId'),
        amountExpression: form.get('amountExpression') });
      sendHtml(res, 200, renderBudget(book, session, month,
        `<p class="notice">${result.duplicate ? '이미 처리한' : '처리한'} 예산 이동: ${result.payload.amount.toLocaleString('ko-KR')}원</p>`));
      return true;
    }
    if (req.method === 'POST' && ['/admin/budget/target', '/admin/budget/fill-targets'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const month = form.get('month');
      assertMonth(month);
      let message;
      if (pathname.endsWith('/target')) {
        setBudgetTarget(book, session.sub, form.get('categoryId'), form.get('amountExpression'));
        message = '매월 배정 목표를 저장했습니다.';
      } else {
        const result = fillBudgetTargets(book, session.sub, month, form.get('requestId'));
        message = `${result.duplicate ? '이미 처리한' : '처리한'} 목표 배정: ${result.count}항목, ${result.total.toLocaleString('ko-KR')}원`;
      }
      sendHtml(res, 200, renderBudget(book, session, month, `<p class="notice">${escape(message)}</p>`));
      return true;
    }
    if (req.method === 'POST' && pathname === '/admin/budget') {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      if (session.role !== 'owner') throw new Error('Owner access required');
      const month = form.get('month');
      const amount = calculateAmount(form.get('amountExpression'));
      book.assignBudget(month, form.get('categoryId'), amount);
      sendHtml(res, 200, renderBudget(book, session, month,
        '<p class="notice">월별 예산을 저장했습니다.</p>'));
      return true;
    }
    if (req.method === 'POST' && ['/admin/groups/rename', '/admin/accounts/group'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) {
        sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true;
      }
      if (pathname.endsWith('/rename')) renameGroup(book, session.sub, form.get('groupId'), form.get('name'));
      else moveAccountGroup(book, session.sub, form.get('accountId'), form.get('groupId') || null);
      sendHtml(res, 200, renderAccounts(book, session, '<p class="notice">계좌 그룹을 변경했습니다.</p>'));
      return true;
    }
    if (req.method === 'POST' && ['/admin/groups', '/admin/accounts', '/admin/categories',
      '/admin/transactions'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      if (pathname === '/admin/transactions') {
        const result = recordManual(book, session.sub, {
          date: form.get('date'), kind: form.get('kind'), accountId: form.get('accountId'),
          counterId: form.get('counterId'), categoryId: form.get('categoryId') || null,
          amountExpression: form.get('amountExpression'), memo: form.get('memo') || '',
          requestId: form.get('requestId'),
        });
        sendHtml(res, 200, renderRegister(book, session, form.get('accountId'),
          `<p class="notice">${result.duplicate ? '이미 저장된' : '저장한'} 거래: ${escape(result.entry.id)}</p>`));
        return true;
      }
      if (session.role !== 'owner') throw new Error('Owner access required');
      if (pathname === '/admin/groups') createGroup(book, session.sub, form.get('name'), form.get('type'));
      if (pathname === '/admin/accounts') createLedgerAccount(book, session.sub, {
        name: form.get('name'), type: form.get('type'), groupId: form.get('groupId') || null,
        onBudget: form.has('onBudget'), cash: form.has('cash'), card: form.has('card'),
      });
      if (pathname === '/admin/categories') createCategory(book, session.sub, form.get('name'));
      sendHtml(res, 200, renderAccounts(book, session, '<p class="notice">항목을 생성했습니다.</p>'));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/review') {
      sendHtml(res, 200, renderReview(book, session)); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/family') {
      if (session.role !== 'owner') throw new Error('Owner access required');
      sendHtml(res, 200, renderFamily(book, session)); return true;
    }
    if (req.method === 'POST' && ['/admin/approve', '/admin/family', '/admin/family/remove'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      if (pathname === '/admin/approve') {
        const result = approveEvent(book, session.sub, {
          eventId: form.get('eventId'), kind: form.get('kind'),
          counterAccountId: form.get('counterAccountId'), categoryId: form.get('categoryId') || null,
          amount: Number(form.get('amount')), date: form.get('date'), payee: form.get('payee'),
        });
        sendHtml(res, 200, renderReview(book, session,
          `<p class="notice">${result.duplicate ? '이미 승인된' : '승인한'} 거래: ${escape(result.entryId)}</p>`));
        return true;
      }
      if (session.role !== 'owner') throw new Error('Owner access required');
      if (pathname.endsWith('/remove')) removeMember(book, session.sub, form.get('sub'));
      else setMember(book, session.sub, form.get('sub'), form.get('role'), form.getAll('accountId'));
      sendHtml(res, 200, renderFamily(book, session, '<p class="notice">구성원을 변경했습니다.</p>'));
      return true;
    }
    if (req.method === 'GET' && pathname === '/admin/regex') {
      if (session.role === 'viewer') throw new Error('Editor access required');
      const accountId = new URL(req.url, 'http://localhost').searchParams.get('accountId');
      sendHtml(res, 200, renderConfig(book, session, accountId)); return true;
    }
    if (req.method === 'POST' && ['/admin/regex', '/admin/keys', '/admin/revoke'].includes(pathname)) {
      if (session.role === 'viewer') throw new Error('Editor access required');
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const accountId = form.get('accountId');
      if (!canAccessAccount(book, session.sub, accountId, 'write')) throw new Error('Account access denied');
      if (pathname === '/admin/revoke') {
        if (!revokeKey(book, form.get('type'), form.get('keyId'), session.sub)) {
          throw new Error('Key not found');
        }
        sendHtml(res, 200, renderConfig(book, session, accountId, null,
          '<p class="notice">키를 폐기했습니다.</p>'));
        return true;
      }
      if (pathname === '/admin/regex') {
        const patterns = fields(form);
        if (form.get('action') === 'save') {
          saveParserRules(book, session.sub, accountId, patterns);
          sendHtml(res, 200, renderConfig(book, session, accountId, patterns,
            '<p class="notice">정규식을 저장했습니다.</p>'));
        } else if (form.get('action') === 'test') {
          const parsed = await parsePush(patterns, String(form.get('rawText') ?? ''));
          sendHtml(res, 200, renderConfig(book, session, accountId,
            { ...patterns, rawText: form.get('rawText') },
            `<p class="notice">시험 결과</p><pre>${escape(JSON.stringify(parsed, null, 2))}</pre>`));
        } else throw new Error('Unknown action');
        return true;
      }
      const issued = form.get('type') === 'api' ? issueApiKey(book, session.sub) :
        form.get('type') === 'account' ? issueAccountKey(book, session.sub, accountId) : null;
      if (!issued) throw new Error('Unknown key type');
      sendHtml(res, 200, page('키 생성 완료', `<p>아래 키는 다시 표시할 수 없습니다. 안전하게 보관하세요.</p>
        <pre>${escape(issued.key)}</pre><p>키 ID: ${escape(issued.id)}</p>
        <p><a href="/admin/regex?accountId=${encodeURIComponent(accountId)}">설정으로 돌아가기</a></p>`));
      return true;
    }
    sendHtml(res, 404, page('페이지 없음', '')); return true;
  } catch (error) {
    sendHtml(res, 400, page('입력 확인', `<p class="error">${escape(error.message)}</p>`));
    return true;
  }
}

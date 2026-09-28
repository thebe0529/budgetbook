import { getParserRules, issueAccountKey, issueApiKey, revokeKey, saveParserRules } from './push-credentials.js';
import { parsePush } from './push-parser.js';
import { canAccessAccount, member, removeMember, setMember, visibleAccounts } from './members.js';
import { approveEvent, listReviewEvents } from './review.js';
import { randomUUID } from 'node:crypto';
import { accountOverview, accountRegister, createCategory, createGroup,
  createLedgerAccount, recordManual } from './manual.js';
import { calculateAmount } from './amount-expression.js';
import { assertMonth } from './ledger.js';
import { readFileSync } from 'node:fs';
import { editableManual, recordSplitManual, updateSplitManual } from './split-manual.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function page(title, content) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escape(title)} · BudgetBook</title><style>
    body{font:16px system-ui,sans-serif;max-width:850px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#172333}
    label{display:block;margin-top:1rem;font-weight:650}input,textarea,select{box-sizing:border-box;width:100%;padding:.6rem;font:inherit}
    button{padding:.65rem 1rem;margin-top:1rem;background:#174a7e;color:white;border:0;border-radius:5px;cursor:pointer}
    pre{white-space:pre-wrap;background:#eef3f8;padding:1rem;border-radius:5px}nav{display:flex;gap:1rem}
    .notice{padding:1rem;background:#eaf5ed}.error{padding:1rem;background:#ffedeb}
    table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d8e1eb;padding:.5rem;text-align:left}
    </style></head><body><nav><a href="/admin/accounts">계좌</a><a href="/admin/budget">예산</a>
    <a href="/admin/reports">보고서</a>
    <a href="/admin/review">수신 검토</a><a href="/admin/regex">정규식 설정</a>
    <a href="/admin/family">가족 관리</a><a href="/auth/logout">로그아웃</a></nav>
    <h1>${escape(title)}</h1>${content}</body></html>`;
}

function renderAccounts(book, session, message = '') {
  const overview = accountOverview(book, session.sub, '9999-12-31');
  const rows = overview.map(a => `<tr><td><a href="/admin/register?accountId=${encodeURIComponent(a.id)}">${escape(a.name)}</a></td>
    <td>${escape(a.type)}</td><td>${escape(a.balance.toLocaleString('ko-KR'))}원</td></tr>`).join('');
  const typeOptions = ['asset', 'liability', 'equity', 'income', 'expense']
    .map(type => `<option value="${type}">${type}</option>`).join('');
  const groups = book.accountGroups().map(g => `<option value="${escape(g.id)}">${escape(g.name)} (${g.type})</option>`).join('');
  const controls = session.role !== 'owner' ? '' : `<h2>계좌 그룹 추가</h2>
    <form method="post" action="/admin/groups"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <label>그룹 이름</label><input name="name" required><label>그룹 유형</label>
      <select name="type"><option value="asset">자산</option><option value="liability">부채</option></select><button>그룹 생성</button></form>
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
  return page('계좌 관리', `${message}<table><thead><tr><th>계좌</th><th>유형</th><th>잔액</th></tr></thead>
    <tbody>${rows}</tbody></table>${controls}`);
}

function renderRegister(book, session, accountId, message = '') {
  const accounts = visibleAccounts(book, session.sub).filter(a => ['asset', 'liability'].includes(a.type));
  if (accountId && !accounts.some(a => a.id === accountId)) throw new Error('Account access denied');
  const selected = accounts.find(a => a.id === accountId) ?? accounts[0];
  if (!selected) return page('거래 입력', '<p>볼 수 있는 계좌가 없습니다.</p>');
  const register = accountRegister(book, session.sub, selected.id, '9999-12-31');
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
  const rows = register.rows.slice(0, 200).map(row => {
    const editable = row.kind === 'manual-split' && row.sourceAccountId === selected.id &&
      canAccessAccount(book, session.sub, selected.id, 'write') &&
      (row.createdBy === session.sub || session.role === 'owner');
    return `<tr><td>${escape(row.date)}</td><td>${escape(row.memo)}
      ${editable ? `<a href="/admin/split/edit?entryId=${encodeURIComponent(row.id)}">수정</a>` : ''}</td>
    <td>${escape(row.movement.toLocaleString('ko-KR'))}</td><td>${escape(row.balance.toLocaleString('ko-KR'))}</td></tr>`;
  }).join('');
  return page(`${selected.name} 거래`, `${message}<form method="get" action="/admin/register">
    <label>계좌</label><select name="accountId">${options}</select><button>조회</button></form>
    <p>잔액: ${escape(register.balance.toLocaleString('ko-KR'))}원</p>${input}
    <h2>최근 거래</h2><table><tr><th>일자</th><th>메모</th><th>증감</th><th>잔액</th></tr>${rows}</table>`);
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
  const options = selected => counters.map(a => `<option value="${escape(a.id)}" data-type="${a.type}"
    ${a.id === selected ? 'selected' : ''}>${escape(a.name)} (${a.type})</option>`).join('');
  const categoryOptions = selected => '<option value="">없음</option>' + categories.map(c =>
    `<option value="${escape(c.id)}" ${c.id === selected ? 'selected' : ''}>${escape(c.name)}</option>`).join('');
  const counterLines = existing?.postings.filter(p => p.accountId !== accountId) ?? [null, null];
  const rows = counterLines.map((line, index) => `<tr><td><select name="counterId">${options(line?.accountId)}</select></td>
    <td><input name="lineAmount" value="${escape(line?.amount ?? '')}" required></td>
    <td><select name="lineCategory">${categoryOptions(existing?.budgetAllocations?.[index]?.categoryId)}</select></td>
    <td><button type="button" data-remove-row>삭제</button></td></tr>`).join('');
  return page(entryId ? '분할 거래 수정' : '분할 거래 입력', `${message}
    <p>원천 계좌: ${escape(account.name)} · 상대 계정을 행으로 추가합니다. 각 행의 합계를 원천 계좌에 한 번 반영합니다.</p>
    <form id="split-form" method="post" action="${entryId ? '/admin/split/update' : '/admin/split'}">
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
      <table><tr><th>상대 계정</th><th>금액</th><th>예산 카테고리</th><th></th></tr>
      <tbody id="split-rows">${rows}</tbody></table><button type="button" id="add-split-row">행 추가</button>
      <button>분할 거래 ${entryId ? '수정' : '저장'}</button>
    </form><template id="counter-template"><select name="counterId">${options()}</select></template>
    <template id="category-template"><select name="lineCategory">${categoryOptions()}</select></template>
    <script defer src="/admin/assets/split.js"></script>`);
}

function renderReports(book, session, fromDate, throughDate, message = '') {
  const overview = accountOverview(book, session.sub, throughDate);
  const rows = overview.map(a => `<tr><td>${escape(a.name)}</td><td>${escape(a.balance.toLocaleString('ko-KR'))}</td></tr>`).join('');
  let consolidated = '<p>가족 구성원에게는 허용된 계좌의 잔액만 표시합니다.</p>';
  if (session.role === 'owner') {
    const report = book.reports(fromDate, throughDate);
    consolidated = `<h2>장부 전체</h2><p>자산 ${report.balanceSheet.assets.toLocaleString('ko-KR')}원 ·
      부채 ${report.balanceSheet.liabilities.toLocaleString('ko-KR')}원 ·
      순자산 ${report.balanceSheet.netWorth.toLocaleString('ko-KR')}원</p>
      <p>기간 수입 ${report.incomeStatement.income.toLocaleString('ko-KR')}원 ·
      비용 ${report.incomeStatement.expenses.toLocaleString('ko-KR')}원 ·
      순손익 ${report.incomeStatement.result.toLocaleString('ko-KR')}원 ·
      현금 증감 ${report.cashFlow.netChange.toLocaleString('ko-KR')}원</p>`;
  }
  return page('보고서', `${message}<form method="get" action="/admin/reports">
    <label>시작일</label><input type="date" name="fromDate" value="${escape(fromDate)}">
    <label>기준일</label><input type="date" name="throughDate" value="${escape(throughDate)}"><button>조회</button></form>
    <h2>접근 가능한 계좌 잔액</h2><table><tr><th>계좌</th><th>잔액</th></tr>${rows}</table>${consolidated}`);
}

function renderBudget(book, session, month, message = '') {
  assertMonth(month);
  if (session.role !== 'owner') throw new Error('Owner access required');
  const budget = book.budget(month);
  const rows = Object.values(budget.categories).map(category => `<tr><td>${escape(category.name)}</td>
    <td>${category.budgeted.toLocaleString('ko-KR')}</td>
    <td>${category.spent.toLocaleString('ko-KR')}</td>
    <td>${category.balance.toLocaleString('ko-KR')}</td>
    <td><form method="post" action="/admin/budget"><input type="hidden" name="csrf" value="${escape(session.csrf)}">
      <input type="hidden" name="month" value="${escape(month)}">
      <input type="hidden" name="categoryId" value="${escape(category.categoryId)}">
      <input name="amountExpression" aria-label="${escape(category.name)} 예산" placeholder="월 배정액" required>
      <button>배정</button></form></td></tr>`).join('');
  return page('월별 예산', `${message}<form method="get" action="/admin/budget">
    <label>월</label><input type="month" name="month" value="${escape(month)}"><button>조회</button></form>
    <p>온버짓 가용 자금: ${budget.availableFunds.toLocaleString('ko-KR')}원 ·
      미배정 자금: ${budget.readyToAssign.toLocaleString('ko-KR')}원</p>
    <table><tr><th>카테고리</th><th>이번 달 배정</th><th>이번 달 지출</th><th>이월 포함 잔액</th><th>배정 변경</th></tr>${rows}</table>`);
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
    if (req.method === 'GET' && pathname === '/admin/assets/split.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(readFileSync(new URL('./split-ui.js', import.meta.url)));
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
    if (req.method === 'GET' && pathname === '/admin/accounts') {
      sendHtml(res, 200, renderAccounts(book, session)); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/register') {
      const accountId = new URL(req.url, 'http://localhost').searchParams.get('accountId');
      sendHtml(res, 200, renderRegister(book, session, accountId)); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/reports') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const fromDate = query.get('fromDate') || `${today.slice(0, 7)}-01`;
      const throughDate = query.get('throughDate') || today;
      sendHtml(res, 200, renderReports(book, session, fromDate, throughDate)); return true;
    }
    if (req.method === 'GET' && pathname === '/admin/budget') {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const month = new URL(req.url, 'http://localhost').searchParams.get('month') || today.slice(0, 7);
      sendHtml(res, 200, renderBudget(book, session, month)); return true;
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

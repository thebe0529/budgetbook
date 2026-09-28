import { getParserRules, issueAccountKey, issueApiKey, revokeKey, saveParserRules } from './push-credentials.js';
import { parsePush } from './push-parser.js';
import { canAccessAccount, member, removeMember, setMember, visibleAccounts } from './members.js';
import { approveEvent, listReviewEvents } from './review.js';

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
    </style></head><body><nav><a href="/admin/review">수신 검토</a><a href="/admin/regex">정규식 설정</a>
    <a href="/admin/family">가족 관리</a><a href="/auth/logout">로그아웃</a></nav>
    <h1>${escape(title)}</h1>${content}</body></html>`;
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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

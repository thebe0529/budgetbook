import { getParserRules, issueAccountKey, issueApiKey, revokeKey, saveParserRules } from './push-credentials.js';
import { parsePush } from './push-parser.js';

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
    </style></head><body><nav><a href="/admin/regex">정규식 설정</a><a href="/auth/logout">로그아웃</a></nav>
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
  const accounts = [...book.accounts().values()].filter(a => ['asset', 'liability'].includes(a.type));
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
    if (req.method === 'GET' && pathname === '/admin/regex') {
      const accountId = new URL(req.url, 'http://localhost').searchParams.get('accountId');
      sendHtml(res, 200, renderConfig(book, session, accountId)); return true;
    }
    if (req.method === 'POST' && ['/admin/regex', '/admin/keys', '/admin/revoke'].includes(pathname)) {
      const form = await formBody(req);
      if (form.get('csrf') !== session.csrf) { sendHtml(res, 403, page('접근 거부', '<p>요청 검증에 실패했습니다.</p>')); return true; }
      const accountId = form.get('accountId');
      if (!book.accounts().has(accountId)) throw new Error('Unknown account');
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

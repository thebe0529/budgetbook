const notice = document.querySelector('#notice');
const form = document.querySelector('#transaction-form');
const workspace = document.querySelector('#workspace');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DAY = 86400000;
let vault;
let state;
let key;
let server;
let syncing = false;
let writeTail = Promise.resolve();

function status(message) { notice.textContent = message; }
const bytes = values => Uint8Array.from(atob(values), c => c.charCodeAt(0));
const base64 = values => btoa(String.fromCharCode(...values));

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('budgetbook-local-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localRecord(value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', value === undefined ? 'readonly' : 'readwrite');
    const request = value === undefined ? transaction.objectStore('records').get('vault') :
      transaction.objectStore('records').put(value, 'vault');
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}

async function derive(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: bytes(salt), iterations: 310000,
    hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function save() {
  const snapshot = JSON.stringify(state);
  const currentKey = key;
  const currentVault = vault;
  writeTail = writeTail.catch(() => {}).then(async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, currentKey,
      encoder.encode(snapshot));
    const record = { salt: currentVault.salt, iv: base64(iv),
      ciphertext: base64(new Uint8Array(encrypted)), subject: currentVault.subject };
    await localRecord(record);
    vault = record;
  });
  return writeTail;
}

async function getServer() {
  const response = await fetch('/api/v1/local/state', { cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? 'Pocket ID 로그인이 필요합니다.' : '서버 조회 실패');
  return response.json();
}

function choose(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
}

function render() {
  const snapshot = state.snapshot;
  workspace.hidden = false;
  const accountSelect = form.elements.accountId;
  const selected = accountSelect.value;
  choose(accountSelect, snapshot.accounts.filter(a => a.canWrite)
    .map(a => [a.id, a.name]));
  if (snapshot.accounts.some(a => a.id === selected && a.canWrite)) accountSelect.value = selected;
  const kind = form.elements.kind.value;
  const source = snapshot.accounts.find(a => a.id === accountSelect.value);
  const counter = snapshot.counterpartAccounts.filter(a => kind === 'transfer' ?
    ['asset', 'liability'].includes(a.type) && a.id !== source?.id : a.type === kind);
  choose(form.elements.counterId, counter.map(a => [a.id, a.name]));
  choose(form.elements.categoryId, [['', '없음'], ...(kind === 'expense' && source?.onBudget ?
    snapshot.categories.map(c => [c.id, c.name]) : [])]);
  const accounts = document.querySelector('#accounts');
  accounts.replaceChildren(...snapshot.accounts.map(a => {
    const item = document.createElement('li');
    item.textContent = `${a.name}: ${Number(a.balance).toLocaleString('ko-KR')}원`;
    return item;
  }));
  const queue = document.querySelector('#queue');
  queue.replaceChildren(...state.pending.map(item => {
    const li = document.createElement('li');
    li.textContent = `${item.date} ${item.memo || item.kind} · ${item.amountExpression}원 `;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '대기 거래 삭제';
    remove.disabled = syncing;
    remove.addEventListener('click', async () => {
      if (syncing) return;
      state.pending = state.pending.filter(p => p.requestId !== item.requestId);
      await save(); render();
    });
    li.append(remove);
    return li;
  }));
  document.querySelector('#sync-button').disabled = syncing || !state.pending.length;
  document.querySelector('#lock-button').disabled = syncing;
}

async function sync() {
  if (syncing || !state) return;
  syncing = true;
  render();
  try {
    server = await getServer();
    if (server.subject !== vault.subject) throw new Error('이 브라우저의 다른 사용자 자료입니다. 다른 브라우저 프로필을 사용하세요.');
    state.verifiedAt = Date.now();
    state.snapshot = { accounts: server.accounts, counterpartAccounts: server.counterpartAccounts,
      categories: server.categories };
    await save();
    while (state.pending.length) {
      const response = await fetch('/api/v1/local/transactions', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': server.csrf },
        body: JSON.stringify(state.pending[0]) });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(response.status === 401 ? 'Pocket ID 로그인이 필요합니다.' :
          `전송 대기 거래 오류 (${response.status}): ${result.error || '확인 필요'}`);
      }
      state.pending.shift();
      await save();
    }
    server = await getServer();
    state.snapshot = { accounts: server.accounts, counterpartAccounts: server.counterpartAccounts,
      categories: server.categories };
    state.verifiedAt = Date.now();
    await save();
    status('동기화 완료. 대기 거래 0건.');
  } catch (error) { status(`동기화 보류: ${error.message}`); }
  finally { syncing = false; render(); }
}

document.querySelector('#unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const passphrase = event.currentTarget.elements.passphrase.value;
  try {
    if (vault) {
      key = await derive(passphrase, vault.salt);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(vault.iv) },
        key, bytes(vault.ciphertext));
      state = JSON.parse(decoder.decode(decrypted));
      if (server && server.subject !== vault.subject) throw new Error('다른 사용자 자료입니다. 다른 브라우저 프로필을 사용하세요.');
      if (!server && Date.now() - state.verifiedAt > 30 * DAY) {
        throw new Error('오프라인 30일이 지났습니다. Pocket ID 로그인 후 다시 열어주세요.');
      }
    } else {
      if (!server) throw new Error('새 기기 등록에는 Pocket ID 로그인이 필요합니다.');
      vault = { subject: server.subject, salt: base64(crypto.getRandomValues(new Uint8Array(16))) };
      key = await derive(passphrase, vault.salt);
      state = { verifiedAt: Date.now(), snapshot: { accounts: server.accounts,
        counterpartAccounts: server.counterpartAccounts, categories: server.categories }, pending: [] };
      await save();
    }
    document.querySelector('#unlock-section').hidden = true;
    event.currentTarget.reset();
    render();
    if (server) sync();
    else status(`오프라인 상태 · 마지막 로그인 확인: ${new Date(state.verifiedAt).toLocaleString('ko-KR')}`);
  } catch (error) {
    key = null;
    state = null;
    status(`잠금 해제 실패: ${error.message}`);
  }
});

form.addEventListener('change', event => {
  if (['kind', 'accountId'].includes(event.target.name)) render();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!state || Date.now() - state.verifiedAt > 30 * DAY) {
    status('오프라인 이용 기간이 지났습니다. 먼저 서버에서 로그인하고 동기화하세요.'); return;
  }
  const data = Object.fromEntries(new FormData(form));
  const input = { requestId: crypto.randomUUID(), date: data.date, kind: data.kind,
    accountId: data.accountId, counterId: data.counterId, amountExpression: data.amountExpression,
    categoryId: data.categoryId || null, memo: data.memo };
  state.pending.push(input);
  try { await save(); }
  catch (error) { state.pending.pop(); status(`로컬 저장 실패: ${error.message}`); return; }
  form.reset(); render();
  status('거래를 이 기기에 암호화해 저장했습니다. 서버 전송 전에는 잔액에 반영되지 않습니다.');
  if (navigator.onLine) sync();
});

document.querySelector('#sync-button').addEventListener('click', sync);
document.querySelector('#lock-button').addEventListener('click', () => {
  if (syncing) return;
  state = null; key = null; server = null; workspace.hidden = true;
  document.querySelector('#unlock-section').hidden = false;
  status('로컬 자료가 잠겼습니다.');
});
window.addEventListener('online', () => { if (state) sync(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' })
  .catch(() => status('오프라인 설치를 사용할 수 없습니다.'));
try {
  vault = await localRecord();
  try { server = await getServer(); }
  catch { server = null; }
  document.querySelector('#unlock-title').textContent = vault ? '로컬 자료 잠금 해제' : '새 기기 잠금 암호 설정';
  status(server ? '로그인 확인 완료. 잠금 암호를 입력하세요.' :
    '서버 연결 또는 로그인이 필요합니다. 저장된 자료가 있다면 오프라인에서 열 수 있습니다.');
} catch (error) { status(`기기 저장소를 열 수 없습니다: ${error.message}`); }

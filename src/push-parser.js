import { Worker } from 'node:worker_threads';
import { assertDate } from './ledger.js';

export const FIELDS = ['amount', 'date', 'payee', 'memo'];
let activeWorkers = 0;

export function validatePatterns(patterns) {
  if (!patterns || typeof patterns !== 'object' || Array.isArray(patterns)) throw new Error('Invalid patterns');
  if (Object.keys(patterns).some(field => !FIELDS.includes(field))) throw new Error('Unknown parser field');
  if (!patterns.amount || !patterns.date) throw new Error('Amount and date patterns are required');
  for (const field of FIELDS) {
    const source = patterns[field];
    if (source === undefined || source === '') continue;
    if (typeof source !== 'string' || source.length > 256) throw new Error(`${field}: invalid pattern length`);
    let regex;
    try { regex = new RegExp(source, 'u'); }
    catch { throw new Error(`${field}: invalid regular expression`); }
    if (regex.exec('')?.[1] !== undefined) throw new Error(`${field}: empty-string patterns are not allowed`);
    // Require at least one capturing group; patterns are executed in a bounded worker.
    if (!/\((?!\?(?:[:=!]|<[=!]))/.test(source)) throw new Error(`${field}: capture group 1 required`);
  }
}

function runPatterns(patterns, text, timeoutMs = 500) {
  if (activeWorkers >= 4) return Promise.reject(new Error('Parser busy; retry later'));
  activeWorkers++;
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./regex-worker.js', import.meta.url),
      { workerData: { patterns, text } }); }
    catch (error) { activeWorkers--; reject(error); return; }
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      activeWorkers--;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Regex execution timed out')), timeoutMs);
    worker.once('message', message => message.error ? finish(new Error(message.error)) :
      finish(null, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Regex worker exited: ${code}`)); });
  });
}

export async function parsePush(patterns, text) {
  validatePatterns(patterns);
  if (typeof text !== 'string' || text.length > 10_000) throw new Error('Invalid push text');
  const fields = await runPatterns(patterns, text);
  const amountText = fields.amount?.replace(/[\s,₩원]/g, '');
  if (!/^-?\d+$/.test(amountText ?? '')) throw new Error('Amount must be an integer KRW value');
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('Invalid amount');
  const date = fields.date?.replace(/[./]/g, '-');
  assertDate(date);
  return { amount, date, ...(fields.payee ? { payee: fields.payee } : {}),
    ...(fields.memo ? { memo: fields.memo } : {}) };
}

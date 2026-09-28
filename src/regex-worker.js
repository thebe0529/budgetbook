import { parentPort, workerData } from 'node:worker_threads';

try {
  const result = {};
  for (const [field, source] of Object.entries(workerData.patterns)) {
    if (!source) continue;
    const expression = new RegExp(source, 'u');
    if (expression.exec('')?.[1] !== undefined) throw new Error(`${field}: empty-string patterns are not allowed`);
    const match = expression.exec(workerData.text);
    if (!match?.[1]) throw new Error(`${field}: no capture group match`);
    result[field] = match[1].trim();
  }
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: error.message }); }

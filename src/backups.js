import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, chmod, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { member } from './members.js';

function owner(book, sub) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
}

export function backupSettings(book, sub) {
  owner(book, sub);
  const saved = book.db.prepare('SELECT interval_days, keep_count FROM backup_settings WHERE id = 1').get();
  return { intervalDays: saved?.interval_days ?? 1, keepCount: saved?.keep_count ?? 30 };
}

export function configureBackups(book, sub, { intervalDays, keepCount }) {
  owner(book, sub);
  if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 30 ||
      !Number.isInteger(keepCount) || keepCount < 1 || keepCount > 365) {
    throw new Error('Backup interval must be 1–30 days and retention 1–365 copies');
  }
  book.db.prepare(`INSERT INTO backup_settings (id, interval_days, keep_count) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET interval_days=excluded.interval_days, keep_count=excluded.keep_count`)
    .run(intervalDays, keepCount);
  return backupSettings(book, sub);
}

export function listBackups(book, sub) {
  owner(book, sub);
  return book.db.prepare('SELECT id, created_at, filename FROM backup_runs ORDER BY created_at DESC, rowid DESC').all();
}

export function createBackupManager(book, directory) {
  if (!isAbsolute(directory || '')) throw new Error('Backup directory must be an absolute path');
  let running = null;
  const execute = async () => {
    const id = randomUUID();
    const name = `budgetbook-${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.sqlite`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${name}.partial`);
    const destination = join(directory, name);
    try {
      await backup(book.db, temporary);
      const check = new DatabaseSync(temporary, { readOnly: true });
      try {
        if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
          throw new Error('Backup integrity check failed');
        }
      } finally { check.close(); }
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      book.db.prepare('INSERT INTO backup_runs (id, created_at, filename) VALUES (?, ?, ?)')
        .run(id, new Date().toISOString(), name);
      const { keepCount } = backupSettingsForSystem(book);
      const old = book.db.prepare('SELECT id, filename FROM backup_runs ORDER BY created_at DESC, rowid DESC').all()
        .slice(keepCount);
      for (const item of old) {
        if (item.filename !== basename(item.filename) || !item.filename.startsWith('budgetbook-')) continue;
        await unlink(join(directory, item.filename)).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        book.db.prepare('DELETE FROM backup_runs WHERE id = ?').run(item.id);
      }
      return { id, filename: name };
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  };
  const run = () => {
    if (!running) {
      running = execute().finally(() => { running = null; });
    }
    return running;
  };
  return {
    run,
    async runIfDue(now = new Date()) {
      const latest = book.db.prepare('SELECT created_at FROM backup_runs ORDER BY created_at DESC LIMIT 1').get();
      if (latest && now.getTime() - Date.parse(latest.created_at) <
        backupSettingsForSystem(book).intervalDays * 86400000) return null;
      return run();
    },
  };
}

function backupSettingsForSystem(book) {
  const row = book.db.prepare('SELECT interval_days, keep_count FROM backup_settings WHERE id = 1').get();
  return { intervalDays: row?.interval_days ?? 1, keepCount: row?.keep_count ?? 30 };
}

export function startBackupScheduler(manager, onError = console.error) {
  manager.runIfDue().catch(onError);
  const timer = setInterval(() => manager.runIfDue().catch(onError), 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

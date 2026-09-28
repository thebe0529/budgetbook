export function ensureOwner(book, sub) {
  if (!sub) throw new Error('Owner subject required');
  const other = book.db.prepare("SELECT user_sub FROM family_members WHERE role = 'owner' AND user_sub <> ?").get(sub);
  if (other) throw new Error('A different owner is already configured');
  book.db.prepare("INSERT INTO family_members (user_sub, role) VALUES (?, 'owner') ON CONFLICT(user_sub) DO UPDATE SET role = 'owner'")
    .run(sub);
}

export function member(book, sub) {
  return book.db.prepare('SELECT user_sub, role FROM family_members WHERE user_sub = ?').get(sub) ?? null;
}

export function canAccessAccount(book, sub, accountId, action = 'read') {
  const person = member(book, sub);
  if (!person || !book.accounts().has(accountId)) return false;
  if (person.role === 'owner') return true;
  if (action === 'write' && person.role !== 'editor') return false;
  return Boolean(book.db.prepare('SELECT 1 FROM member_accounts WHERE user_sub = ? AND account_id = ?')
    .get(sub, accountId));
}

export function visibleAccounts(book, sub) {
  return [...book.accounts().values()].filter(a => canAccessAccount(book, sub, a.id));
}

export function setMember(book, actorSub, sub, role, accountIds) {
  if (member(book, actorSub)?.role !== 'owner') throw new Error('Only owner can manage family');
  if (!sub || typeof sub !== 'string' || member(book, sub)?.role === 'owner' ||
    !['editor', 'viewer'].includes(role) ||
    !Array.isArray(accountIds) || accountIds.some(id => !book.accounts().has(id))) {
    throw new Error('Invalid member or account selection');
  }
  return book.atomic(() => {
    book.db.prepare('INSERT INTO family_members (user_sub, role) VALUES (?, ?) ON CONFLICT(user_sub) DO UPDATE SET role=excluded.role')
      .run(sub, role);
    book.db.prepare('DELETE FROM member_accounts WHERE user_sub = ?').run(sub);
    const insert = book.db.prepare('INSERT INTO member_accounts (user_sub, account_id) VALUES (?, ?)');
    for (const id of new Set(accountIds)) insert.run(sub, id);
    book.db.prepare('DELETE FROM user_sessions WHERE user_sub = ?').run(sub);
    return member(book, sub);
  });
}

export function removeMember(book, actorSub, sub) {
  if (member(book, actorSub)?.role !== 'owner' || member(book, sub)?.role === 'owner') {
    throw new Error('Only owner can remove a family member');
  }
  return book.atomic(() => {
    book.db.prepare('DELETE FROM member_accounts WHERE user_sub = ?').run(sub);
    book.db.prepare('DELETE FROM user_sessions WHERE user_sub = ?').run(sub);
    book.db.prepare('UPDATE user_api_keys SET revoked = 1 WHERE user_sub = ?').run(sub);
    book.db.prepare('UPDATE account_keys SET revoked = 1 WHERE user_sub = ?').run(sub);
    return book.db.prepare('DELETE FROM family_members WHERE user_sub = ?').run(sub).changes === 1;
  });
}

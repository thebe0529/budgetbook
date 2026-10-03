import { accountRegister } from './manual.js';
import { calculateAmount } from './amount-expression.js';

export function compareStatement(book, sub, accountId, throughDate, statementExpression) {
  const register = accountRegister(book, sub, accountId, throughDate);
  if (!['asset', 'liability'].includes(register.account.type)) throw new Error('Asset or liability account required');
  const statementBalance = calculateAmount(statementExpression);
  const difference = statementBalance - register.balance;
  const uncheckedMovement = register.balance - register.checkedBalance;
  if (![register.balance, register.checkedBalance, difference, uncheckedMovement].every(Number.isSafeInteger)) {
    throw new Error('Comparison exceeds supported range');
  }
  return { account: register.account, throughDate, statementBalance, ledgerBalance: register.balance,
    difference, checkedBalance: register.checkedBalance, uncheckedMovement,
    uncheckedCount: register.uncheckedCount, transactionCount: register.rows.length };
}

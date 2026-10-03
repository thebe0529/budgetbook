import { calculateAmount } from './amount-expression.js';

function resolve(value, choices, label) {
  const byId = choices.find(item => item.id === value);
  if (byId) return byId.id;
  const matches = choices.filter(item => item.name === value);
  if (matches.length !== 1) throw new Error(`${label} 이름을 확인하세요: ${value}`);
  return matches[0].id;
}

export function parseSplitPaste(text, { counters, categories, allowCategories }) {
  if (typeof text !== 'string' || text.length > 50000) throw new Error('붙여넣기 자료가 너무 큽니다.');
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  if (lines.length < 2 || lines.length > 50) throw new Error('2~50행을 입력하세요.');
  const result = lines.map((line, i) => {
    try {
      const cells = line.split('\t').map(value => value.trim());
      if (cells.length < 2 || cells.length > 3) throw new Error('상대 계정, 금액, 예산 카테고리 순서로 입력하세요.');
      const [counter, amountExpression, category = ''] = cells;
      if (calculateAmount(amountExpression) <= 0) throw new Error('금액은 양수여야 합니다.');
      if (category && !allowCategories) throw new Error('이 거래에는 예산 카테고리를 지정할 수 없습니다.');
      return { counterId: resolve(counter, counters, '상대 계정'), amountExpression,
        categoryId: category ? resolve(category, categories, '카테고리') : '' };
    } catch (error) { throw new Error(`${i + 1}행: ${error.message}`); }
  });
  if (result.some(row => row.categoryId) && result.some(row => !row.categoryId)) {
    throw new Error('카테고리를 사용하면 모든 행에 지정하세요.');
  }
  return result;
}

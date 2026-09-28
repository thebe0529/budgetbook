# 첫 구현 안내

## 범위

`src/ledger.js`는 분개 검증, 잔액·재무상태표·기간 손익·현금 증감을 계산하는 순수 함수입니다. 금액은 원 단위 정수(KRW)를 사용합니다. `src/book.js`는 Node.js 내장 SQLite에 계정, 확정 분개, 카드 할부 계획, 조정 배치를 저장합니다.

카드 구매는 비용 차변/카드 부채 대변으로 즉시 기록합니다. 월별 할부 계획은 아직 확정 분개가 아닌 예정 데이터로 보관하고, 결제 시 카드 부채 차변/현금성 자산 대변으로 기록합니다. 누락 거래 일괄 조정은 모두 검증한 뒤 하나의 DB 트랜잭션으로 저장합니다. 보고서는 확정 분개만 집계합니다.

## 사용 예시

```js
import { Book } from './src/book.js';

const book = new Book('./budget.sqlite');
book.createAccount({ id: 'bank', name: '보통예금', type: 'asset', cash: true });
book.createAccount({ id: 'card', name: '신용카드', type: 'liability', card: true });
book.createAccount({ id: 'food', name: '식비', type: 'expense' });
book.cardPurchase({ id: 'purchase-1', date: '2026-10-10', cardId: 'card',
  expenseId: 'food', amount: 120000, count: 3, firstDueDate: '2026-11-25' });
console.log(book.pendingCardPayments('2027-01-31'));
book.close();
```

## 현재 제약과 다음 작업

- 보고서는 검증을 위한 계정 잔액·손익·현금 증감 요약 단계입니다. 회계형 화면, 현금흐름 활동 구분과 원거래 드릴다운은 뒤따릅니다.
- 카드사별 이용 기간, 휴일 이월, 수수료, 부분취소·조기상환·일부 납부는 구현 전입니다. 첫 청구일을 직접 지정합니다.
- 가계부/가족별 데이터 격리, 로그인, REST API가 없으므로 현재 모듈을 외부 네트워크에 노출하지 않습니다.
- 계좌 유형은 회계상 자산/부채 등만 구현했습니다. 계정 그룹 및 온/오프 버짓은 이어서 설계합니다.
- 조정 배치의 수정/역분개 UI와 대사 상태는 후속 작업입니다. 확정 분개에 대한 변경 메서드는 제공하지 않습니다.
- 다음 단계에서 예산 차원과 카드 분개를 함께 검증하고, Actual 동기화 코드 재사용 여부를 별도 시제품에서 판단합니다.

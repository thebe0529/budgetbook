# 첫 구현 안내

## 범위

`src/ledger.js`는 분개 검증, 잔액·재무상태표·기간 손익·현금 증감을 계산하는 순수 함수입니다. 금액은 원 단위 정수(KRW)를 사용합니다. `src/book.js`는 Node.js 내장 SQLite에 계정, 확정 분개, 카드 할부 계획, 조정 배치를 저장합니다.

계좌 그룹(자산·부채)은 계좌 목록을 묶고, 예산 카테고리(식비 등)는 거래 지출을 묶습니다. `onBudget` 계좌의 자산 잔액에서 카드 등의 부채 잔액을 뺀 값을 가용 자금으로 계산합니다. 월별 예산 배정액은 덮어쓰기로 수정할 수 있고, 미사용액은 다음 달로 이월됩니다. 거래의 `budgetAllocations`는 비용 분개 합계와 일치해야 하며, 카드를 나중에 결제할 때는 예산 지출이 새로 생기지 않습니다. 온버짓 계좌에서 오프버짓 계좌로의 이체는 가용 자금만 바꾸며 소비로 분류하지 않습니다.

`src/amount-expression.js`의 `calculateAmount`는 숫자 입력칸용 사칙연산과 괄호를 계산합니다. 최대 여섯 자리 소수를 읽고 정수 원으로 반올림(정확히 절반이면 0에서 멀어지는 방향)합니다. 변수·함수·셀 참조와 JavaScript 코드는 허용하지 않습니다.

`src/imports.js`와 `src/import-api.js`는 요청 중복 검사, 원문 검토 대기함, 인증된 상태 조회를 제공합니다. 현재 공개 엔드포인트는 API 키와 계정 키를 함께 사용하는 `/api/v1/push-events`입니다. 키 원문은 발급 시에만 반환하고 데이터베이스에는 SHA-256 다이제스트만 저장합니다. 32바이트의 무작위 키를 사용합니다. 사용법은 [수신 API 안내](import-api.md)를 참고하세요.

새로운 `src/push-credentials.js`, `src/push-parser.js`, `src/regex-worker.js`는 Pocket ID 사용자 `sub`에 묶인 API 키와 계정 키, 계정별 필드 정규식, 시간 제한 파싱을 제공합니다. `src/oidc-auth.js`는 OIDC 인증 코드+PKCE, state/nonce, 사용자 세션을 관리하고 `src/admin-ui.js`는 정규식 편집·시험, 가족 접근 권한, 수신 검토 페이지를 제공합니다. `src/review.js`는 원문을 승인 분개에 연결하고 하나의 DB 트랜잭션으로 반영합니다. 실제 Pocket ID 접속은 배포 환경에서 검증해야 합니다.

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
- 가계부/가족별 **독립 장부** 격리는 아직 없습니다. Pocket ID 로그인은 등록한 가족 구성원에게 허용하며 계좌별 권한을 적용합니다. 모든 집계에 개인 계좌를 안전하게 숨기는 기능은 아직 제공하지 않습니다. 단축어는 API 키와 계정 키를 함께 사용합니다. HTTPS 프록시와 네트워크 접근 제한 아래에서 운영해야 합니다.
- 계좌 그룹·온/오프 버짓과 기본 예산 계산은 구현했습니다. 계좌 그룹 편집/이동, 계좌 상태 변경 시 사전 영향 표시, 수입 카테고리, 월별 예산 UI는 아직 구현되지 않았습니다.
- 조정 배치의 수정/역분개 UI와 대사 상태는 후속 작업입니다. 확정 분개에 대한 변경 메서드는 제공하지 않습니다.
- 다음 단계에서 계좌 등록·거래 편집 UI와 가족별 보고서 격리를 진행하고, Actual 동기화 코드 재사용 여부를 별도 시제품에서 판단합니다.

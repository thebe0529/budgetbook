# 외부 거래 수신 API (첫 구현)

이 API는 iPhone 단축어가 전달한 앱 푸시 원문을 **사용자별·계좌별 정규식**으로 파싱한 후 검토 대기함에 저장합니다. 파싱 규칙 관리 화면은 Pocket ID OIDC 로그인을 사용합니다. 파싱 성공·실패 모두 원문을 보존하고 원장에 자동 분개하지 않습니다. 현재 관리 화면은 설정한 소유자 1인에게만 열리며 가족 권한·검토 승인 UI는 다음 단계입니다.

## Pocket ID와 관리 화면

Pocket ID에 기밀 OIDC 클라이언트를 만들고 PKCE를 활성화합니다. 콜백 URL은 `https://가계부-도메인/auth/callback`으로 정확히 등록합니다. HTTPS 역방향 프록시를 구성하고 다음 환경 변수를 모두 설정합니다.

| 변수 | 값 |
| --- | --- |
| `BUDGETBOOK_OIDC_ISSUER` | Pocket ID의 issuer URL |
| `BUDGETBOOK_OIDC_CLIENT_ID` | Pocket ID 클라이언트 ID |
| `BUDGETBOOK_OIDC_CLIENT_SECRET` | 서버만 보관하는 클라이언트 비밀값 |
| `BUDGETBOOK_OIDC_REDIRECT_URI` | 등록한 `https://가계부-도메인/auth/callback` |
| `BUDGETBOOK_OWNER_SUB` | 관리자로 지정할 Pocket ID 사용자 `sub` 클레임 |

로그인 뒤 `/admin/regex`에서 계좌를 고르고 **금액·일자·거래처·메모** 각각의 정규식을 입력합니다. 각 정규식의 첫 번째 캡처 그룹이 저장할 값입니다. 원문을 넣어 **시험**한 다음 **규칙 저장**을 누릅니다. 금액과 일자는 필수이며, 현재 일자는 4자리 연도를 포함한 `YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD` 형식을 받습니다. 금액은 쉼표를 허용하는 원 단위 정수입니다. 정규식은 별도 작업 스레드에서 시간 제한을 두고 실행합니다.

같은 화면에서 API 키(사용자 식별)와 계정 키(대상 계좌 식별)를 각각 생성·폐기합니다. 두 키는 발급 화면에 한 번만 표시됩니다. 계정 키와 API 키의 소유자가 일치해야 합니다. Pocket ID 로그인 세션은 12시간이며, 이는 향후 PWA의 30일 오프라인 허용 정책과 별개입니다.

## 단축어용 요청

`POST /api/v1/push-events` 요청 헤더: `Authorization: Bearer <API_KEY>`, `Content-Type: application/json`, `Idempotency-Key: <앱푸시별 고유 키>`.

```json
{"accountKey":"발급받은_계정_키","rawText":"2026.10.10 신한카드 승인금액 12,000원 가맹점 카페","externalId":"원천_알림_ID"}
```

새 수신은 `202 Accepted`로 `parsed-pending-review` 또는 `parse-error` 상태와 ID를 돌려줍니다. 동일 요청을 다시 보내면 기존 ID를 반환합니다. 상태 조회는 `GET /api/v1/push-events/{id}`에 같은 API 키와 `X-Account-Key: <ACCOUNT_KEY>`를 보냅니다. 계좌 키가 다른 사용자에게 속하면 `401`입니다. `Idempotency-Key`는 단축어에서 알림별로 고유하게 생성해야 하며, 원문이 같아도 다른 거래라면 다른 키를 사용합니다.

**기존 시제품 엔드포인트** `/api/v1/import-events`와 로컬 채널 발급 명령은 기존 데이터 호환을 위해 유지합니다. 새 연동은 `/api/v1/push-events`를 사용합니다.

## 서버 실행

1. 원장에 수신 계좌를 먼저 생성합니다. 현재는 계좌 등록 웹 화면이 없으므로 `Book` 라이브러리로 계좌를 등록해야 합니다.
2. NAS 영속 저장 경로를 `BUDGETBOOK_DB`로 지정하고 `npm ci`를 실행합니다. 비밀값과 DB는 서버 관리자만 접근하도록 합니다.
3. Pocket ID 환경 변수와 `BUDGETBOOK_DB`를 설정해 `npm run import-api`를 실행합니다. 기본 바인딩은 `127.0.0.1:38181`입니다. 외부 접속에는 HTTPS 역방향 프록시를 사용하며 `BUDGETBOOK_HOST`/`BUDGETBOOK_PORT`를 설정할 수 있습니다.
4. `https://가계부-도메인/admin/regex`에서 로그인해 규칙을 설정하고 자격증명을 발급합니다.

## 기존 채널 API 형식

`POST /api/v1/import-events` 요청 헤더: `Authorization: Bearer <CHANNEL_TOKEN>`, `Content-Type: application/json`, `Idempotency-Key: <원천 이벤트별 고유 키>`.

```json
{"rawText":"신한카드 승인 12000원 2026-10-10","externalId":"source-transaction-123"}
```

새 수신은 `202 Accepted`와 `{"id":"...","status":"pending-review","duplicate":false}`를 반환합니다. 같은 키 또는 같은 `externalId`와 동일한 내용이 재전송되면 같은 ID를 `200 OK`, `duplicate:true`로 반환합니다. 키가 같으나 내용이 바뀌면 `409 Conflict`입니다. `GET /api/v1/import-events/{id}`는 **같은 채널 토큰으로 수신한 이벤트**의 상태와 원문을 돌려줍니다. 다른 채널의 이벤트는 `404`입니다.

## 남은 범위

- 계좌 등록 화면, 다중 사용자 가족 권한, API 키 폐기 UI, 유사 거래 매칭·검토 승인과 원장 분개.
- NAS Docker Compose, HTTPS 프록시, 백업·Google Drive 연동.

OIDC 흐름은 라이브러리의 PKCE·state·nonce 및 ID 토큰 검증을 사용하지만, 실제 Pocket ID 서버와의 통합 테스트는 배포 환경에서 해야 합니다. 현재 API는 단일 장부용 초기 구현이며 가족별 장부 격리와 키 폐기 UI가 준비되기 전에는 가족 구성원에게 별도의 키를 발급하지 않습니다.

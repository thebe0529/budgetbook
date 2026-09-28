# 외부 거래 수신 API (첫 구현)

이 API는 iPhone 단축어·은행 수집기가 전송한 **원문을 검토 대기함에 저장**합니다. 계좌 매핑은 채널을 만들 때 지정합니다. 파싱 규칙과 검토 승인 기능이 준비되기 전에는 원장에 자동 분개하지 않습니다. Pocket ID 사용자 로그인·가족 권한 UI는 아직 구현되지 않았으며, 채널 발급·폐기는 NAS 관리자만 실행할 수 있는 로컬 명령입니다.

## 준비 및 실행

1. 원장에 수신 계좌를 먼저 생성합니다. 현재는 웹 화면이 없으므로 `Book` 라이브러리로 계좌를 등록해야 합니다.
2. NAS의 영속 저장 경로를 `BUDGETBOOK_DB`로 지정합니다. 이 경로와 환경 변수는 서버 관리자만 접근하도록 합니다.
3. `BUDGETBOOK_DB=/path/to/book.sqlite npm run import-channel -- create ACCOUNT_ID iphone-shortcut`으로 채널을 생성합니다. 출력된 토큰은 **한 번만 표시**되므로 단축어에 안전하게 보관합니다.
4. `BUDGETBOOK_DB=/path/to/book.sqlite npm run import-api`로 실행합니다. 기본 바인딩은 `127.0.0.1:38181`입니다. 외부 접속이 필요하면 HTTPS 역방향 프록시와 접근 제한을 구성한 뒤 `BUDGETBOOK_HOST`/`BUDGETBOOK_PORT`를 설정합니다. 토큰을 URL 쿼리나 로그에 남기지 않습니다.
5. 유출된 채널은 `BUDGETBOOK_DB=/path/to/book.sqlite npm run import-channel -- revoke CHANNEL_ID`로 폐기하고 새 채널을 발급합니다.

## 요청 및 응답

`POST /api/v1/import-events` 요청 헤더: `Authorization: Bearer <CHANNEL_TOKEN>`, `Content-Type: application/json`, `Idempotency-Key: <원천 이벤트별 고유 키>`.

```json
{"rawText":"신한카드 승인 12000원 2026-10-10","externalId":"source-transaction-123"}
```

새 수신은 `202 Accepted`와 `{"id":"...","status":"pending-review","duplicate":false}`를 반환합니다. 같은 키 또는 같은 `externalId`와 동일한 내용이 재전송되면 같은 ID를 `200 OK`, `duplicate:true`로 반환합니다. 키가 같으나 내용이 바뀌면 `409 Conflict`입니다. `GET /api/v1/import-events/{id}`는 **같은 채널 토큰으로 수신한 이벤트**의 상태와 원문을 돌려줍니다. 다른 채널의 이벤트는 `404`입니다.

## 남은 범위

- 은행별 텍스트 파싱 규칙·계좌 매핑 화면·중복 유사도 매칭·검토 승인과 원장 분개.
- Pocket ID OIDC 사용자 로그인, 가족별 권한, 토큰 발급 UI와 감사 이력.
- NAS Docker Compose, HTTPS 프록시, 백업·Google Drive 연동.

Pocket ID 연동을 구현한 뒤 채널 관리를 관리자 화면으로 옮기고, 가족별 장부 격리와 API 권한을 추가합니다. 현재 API는 단일 장부용 초기 구현입니다.

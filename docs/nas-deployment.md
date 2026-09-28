# NAS Docker Compose 배포

이 구성은 NAS 호스트의 HTTPS 역방향 프록시가 BudgetBook에 접속하고, Pocket ID가 로그인에 사용되는 단일 가족 장부를 대상으로 합니다.

## 준비

1. NAS에서 저장소를 내려받고 저장소 루트에서 `mkdir -p data backups`를 실행합니다. `data`에는 SQLite 원본, `backups`에는 백업본이 저장됩니다. 두 폴더 모두 컨테이너 사용자 UID/GID **1000:1000**이 쓸 수 있도록 소유권·NAS ACL을 설정합니다. NAS에서 사용하는 UID가 다르면 `compose.yaml`의 `user` 값과 폴더 권한을 함께 변경합니다.
2. `cp .env.example .env`를 실행한 뒤 Pocket ID의 issuer, OIDC 클라이언트 ID/비밀값, 정확한 사용자 `sub`, 외부 HTTPS 콜백 URL을 입력합니다. Pocket ID에 등록한 콜백 URL은 `https://가계부-도메인/auth/callback`과 같아야 합니다. `.env`는 Git에 올리지 않습니다.
3. NAS 역방향 프록시를 외부 `https://가계부-도메인` → NAS의 `http://127.0.0.1:38181`로 연결하고 HTTPS를 사용합니다. 포트를 변경하려면 `.env`의 `BUDGETBOOK_PUBLIC_PORT`를 변경합니다. 프록시가 다른 컨테이너 안에 있으면 호스트 루프백 대신 공유 Docker 네트워크를 구성해야 합니다.
4. `docker compose up -d --build`를 실행하고 `docker compose ps`와 `docker compose logs --tail=100 budgetbook`로 상태를 확인합니다. `curl -i http://127.0.0.1:38181/healthz`가 `204`를 반환하는지 확인한 뒤 Pocket ID 로그인을 시험합니다.

## 데이터와 백업

- `./data/budget.sqlite`는 원본 장부입니다. 컨테이너 교체·업데이트 시 폴더를 유지합니다.
- `./backups`에 기본 1일 주기로 백업을 보관합니다. 소유자는 `/admin/backups`에서 주기와 보관 수를 변경할 수 있습니다. NAS 스냅샷이나 별도 저장소로 `backups` 폴더도 보호하세요.
- 복구할 때는 `docker compose stop budgetbook`으로 서버를 중지하고 원본 DB 파일을 별도로 보관한 뒤 원하는 백업 파일을 `./data/budget.sqlite`로 복사합니다. 파일의 UID/GID가 컨테이너 사용자와 맞는지 확인한 뒤 `docker compose up -d`로 시작합니다. 사용자가 로그아웃되거나 백업 시점 이후 거래가 사라질 수 있으므로 복구는 별도 사본에서 먼저 확인하세요.

Google Drive 자동 저장과 실제 Pocket ID 서버 연동 검증은 아직 이 배포 구성에 포함하지 않았습니다. PWA와 로컬 동기화도 아직 구현되지 않았습니다.

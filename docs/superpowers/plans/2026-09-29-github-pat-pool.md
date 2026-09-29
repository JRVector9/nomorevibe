# 관리자 수집용 GitHub PAT 등록 및 교체

**목적:** 관리자가 공개 저장소 수집용 PAT를 직접 등록·교체하고, 수집 워커가 기존 환경 토큰과 등록된 서로 다른 계정을 사용한다. 계정별 GitHub 한도와 저장 결과를 관리자에서 확인한다.

**설계:** 기존 관리자 세션을 서버 액션에서 재확인한다. PAT를 GitHub `/user`와 `/rate_limit`로 검증하고 숫자 사용자 ID로 upsert한다. PAT는 웹·워커가 공유하는 별도 `GITHUB_COLLECTOR_SECRET`으로 AES-GCM 암호화해 새 애플리케이션 테이블에 저장한다. 화면·로그·감사 기록에는 PAT·암호문을 표시하지 않는다. 기존 `GITHUB_TOKEN`은 이행 중 계속 사용하고 DB의 활성 계정을 추가한다. primary 한도 소진이면 다른 계정으로 같은 요청을 시도하되 secondary 제한은 전체 요청을 멈춘다. DB 장애나 복호화 실패를 조용히 무시하지 않는다.

## 1. 저장·관리

- [x] `github_collector_accounts` 스키마/0053 마이그레이션, 전용 비밀키 검증, PAT 확인/암호화/동일 계정 교체.
- [x] 관리 페이지와 서버 액션. 등록·교체 시 계정 이름과 quota만 반환. 비밀값은 다시 표시하지 않음.
- [x] 활성/중지 전환과 감사 이벤트.
- [x] 테스트: PAT 인증 실패와 암호화 복원.

## 2. 수집 풀·관측

- [x] `githubRequest`에서 환경 토큰과 DB 계정을 읽고 자원별 회전. primary 한도 또는 사전 cooldown이면 다른 계정 시도. 일반 403/404/transport는 전환하지 않음.
- [x] secondary cooldown 전 계정 공유.
- [x] 관리자에서 계정별 core 사용/잔여/reset/관측 시각과 최근 1시간 원본 저장·신규 수집 제품 건수를 다른 단위로 표시.
- [x] account/DB 통합 테스트, 저장 관측 쓰기 제한, 기존 GitHub 테스트 전체.

## 3. 배포·검증

- [x] README/runbook에 0053 마이그레이션과 웹 2개·crawler 2개의 동일 전용 비밀키 선행 배포 절차 기록. DB 서버/복제 설정 변경 없음.
- [x] Vitest, lint, typecheck, build, diff check. PR의 최신 base `check` 확인.
- [x] 실제 두 번째 PAT 등록 후 계정 quota 관측과 원본 증가 확인. 실제 primary 소진 전환의 장기 운영 검증은 별도로 남음.

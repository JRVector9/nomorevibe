# GitHub 401 인증 실패 전환 운영 기록 — 2026-09-29

## 변경과 배포

PR [#229](https://github.com/JRVector9/nomorevibe/pull/229)의 CI `check`와
GitGuardian이 통과했다. main 병합 커밋은 `202f16db532d3ecea6366f7309a7d1692c822031`이다.
GitHub REST 401의 제한 재시도·응답 이유 분류·다른 계정 전환, 거부된 토큰의
공유 15분 보류, 전체 인증 장애의 수집 큐 보류를 추가했다. 기존 `rate_limits`를
사용하며 DB 스키마·서버·스트리밍 설정은 변경하지 않았다.

배포 전 03:26 UTC에 프론티어 108,919건, 원본 108,910건이었다. Dokploy에서
mini crawler 예비를 03:26:43 UTC에 먼저 새 커밋으로 배포했고, 새 예비가
`standby`인 동안 기존 M3 주가 활성 lease를 유지했다. M3 crawler 주는
03:27:45 UTC에 같은 커밋으로 배포 완료됐다. 두 앱의 최신 deployment 상태와
설명은 `done` / 해당 커밋이었다. 배포 후 DB 후보 관측은 M3 `active`, mini
`standby`, 두 release가 새 커밋과 일치했고 crawler lease는 M3 소유였다.

## 운영 검증

03:28 UTC `check-failover-readiness.ts` 종료 코드 0: 다섯 역할 주·예비와
scheduler 2복제본의 준비·진행 상태 모두 `ok`. 공개 웹 `/api/health`는
`status:ok`, `db:ok`였다. 웹은 이 crawler 전용 변경에서 기존 `f305a6b` 릴리스를
유지했다.

03:31 UTC 첫 새 코드 검색 주기에 프론티어 21건이 발견됐다. 이어진 `crawl-fetch`는
20건의 원본과 심사 후보를 저장했고 1건을 별칭으로 건너뛰었다. 그 별칭
`storytree-ai/storytree02`는 기존 원본 `storytree-ai/Storytree`의 GitHub 숫자 ID
`1260888565`와 같아 `skipped/alias_of`로 기록됐고 새 원본 행은 없었다.
GitHub ID 중복 초과 행은 배포 전후 모두 305건이다. `crawl-seed`·`crawl-fetch`의
최근 실행은 성공, `last_error`는 null이며 인증 보류 활성 행은 0개였다.

## 검증 범위와 남은 관측

로컬 단위 1,267/1,267, 관련 통합 73/73, 타입 검사·lint·빌드와 PR 전체 CI가
통과했다. 401→재시도→계정 전환, 401→일반 403, 모든 계정 거부 시 프론티어
시도 횟수 보존은 모의 GitHub 응답과 전용 테스트 DB로 확인했다. 운영 PAT를
실제로 만료하거나 폐기하지 않았다. 자연 발생 시 계정 전환과 관리자 교체 후
재개를 관측하고, 24시간 수집량·quota 추세는 별도로 기록해야 한다.

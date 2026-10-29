# Oracle 한국어 수집 활성화와 AI1 정체 복구

2026-10-28 05:12 UTC 실제 조회 기준이다. 이 문서만으로 실행 완료를 주장하지 않는다.

## 확인된 상태

- `ssh nomore-x`는 기존 등록 경로로 `osaka-smoke`에 정상 연결된다. `ssh osaka-smoke`는 허브 등록 이름 불일치로 거절된다. 추가 키·기기 등록 없이 기존 `nomore-x`를 사용한다.
- 수집 VM의 기존 agent-scan은 `3c63f3bc`로 실행 중이다. 현재 설정의 `secondReview.voters.0.provider`를 해석하지 못해 settings_invalid를 반복한다. 새 한국어 소비자 코드 설치와 별개로 기존 소비자의 릴리스도 맞춰야 한다.
- 한국어 제어는 disabled, start_at NULL, epoch 1. 전용 DB principal은 없다. Oracle GitHub App 설치 `172855274`는 기존 agent-scan principal만 허용한다.
- 기존 M3 한국어 검색의 미완료 구간은 `2026-10-22T23:41:41Z..2026-10-23T01:56:41Z`, page 4이다. 활성화 시 이 진행 위치를 보존하고, 새 전용 조건의 시작점도 그 구간의 시작일로 맞추는 안을 선택한다. 기존 비활성 한국어 조건은 켜지 않는다.
- Oracle watchdog은 onetwoday에서 active/running, recover=true다. 웹·monitor·실패한 agent-scan unit의 제한 복구가 설치돼 있다. 살아 있는 reviewer와 원격 모델의 종료 미확정 점유는 현재 재시작 대상으로 판정하지 않는다.
- AI1 요청 `0d23ab77-3cee-4889-8de9-b3ea686d12d0`는 01:35:22.206 UTC dispatch 뒤 01:35:46.367 UTC indeterminate가 됐다. 로컬 종료 이벤트는 있으나 원격 모델 종료 증거가 없다. Supa group limit 1을 계속 차지한다.

## 최소권한 활성화 범위

실행 지침은 자격증명 변경·접근 확대를 자동 승인하지 않는다. 아래 새 접근 설정은 명시 승인 후 적용한다.

1. 기존 `deploy/oracle/least-privilege.sql`의 `-- consumer github-ko-discovery` 절만 한 트랜잭션으로 적용한다. principal은 `nomorevibe_oracle_github_ko`, 연결 상한은 감독 1+자식 최대 3=4다. 기존 계정·비밀번호·권한은 바꾸지 않는다.
2. 새 임의 비밀번호는 로그·채팅·Git에 남기지 않고 Oracle root 소유 0600 환경 파일에만 전달한다. 기존 수집 암호화 비밀은 같은 호스트의 기존 보안 파일에서 재사용한다.
3. App 설치 `172855274`의 `oracle_principals`에 위 principal 하나만 추가한다. 개인 PAT·모델·frontier·candidate·jobs·role lease 쓰기 권한은 제공하지 않는다.
4. 기존 launcher/OCI identity/least privilege preflight/공유 host DB roster를 보존해 새 `github-ko-discovery` consumer를 설치한다. 원본 X 타이머는 유지한다. 최초 시작일은 위 기존 미완료 구간의 시작점을 사용한다.
5. 관리자 제어 helper로 enabled=true를 감사 기록과 함께 저장한다. heartbeat·쿼리 진척·한국어 판정·공통 큐 적재를 각각 실제 관측한 뒤에만 가동 완료로 기록한다.

## AI1 복구 경계

60초 호출 시간과 회차 예산 수정은 불필요한 24초 timeout을 줄인다. 네트워크·provider 실패의 종료 미확정을 없애지는 않는다. 기존 요청은 canonical 증명 기반 회수가 필요하다. 현재 provider는 응답으로만 종료를 증명하며 request ID별 상태/취소 프로토콜이 없다. 단순 reviewer restart나 모델 서버 idle 표본은 기존 요청의 종료 증명이 아니다.

원격 provider의 실제 hard deadline 또는 owner·gateway·provider 전체 경계의 실제 종료 영수증을 수집한 뒤 기존 `releaseProviderBoundaryRequest`/`releaseEvidencedDispatches`로 해당 요청만 해제한다. 사용량·업무 성공을 만들거나 capacity 한도를 올리지 않는다. 공유 abcLLM/Supa 전체를 종료하는 복구는 영향 범위와 복구 순서를 검토해야 하며, 관측만으로 실행했다고 기록하지 않는다.

## 검증

사용자의 수동 테스트 생략 지시를 유지한다. 새 회귀 코드는 PR에 포함하며 필수 CI는 저장소 규칙대로 유지한다. 실제 운영 상태 조회·감사·기본 건강 응답과 기능 가동 관측을 수동 테스트 통과로 표현하지 않는다.

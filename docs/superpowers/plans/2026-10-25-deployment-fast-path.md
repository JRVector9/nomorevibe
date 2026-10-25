# Deployment fast path implementation plan

> 승인 근거: 사용자가 `2026-10-25-deployment-time-review.md`대로 적용해 앞으로 배포에 사용하도록 지시했다. 병렬 에이전트 실행도 이전 지시를 따른다. 구현 중 새 승인 대기는 없다.

**Goal:** 변경 범위에 맞는 필수 CI와 대상 앱 배포를 기본 절차로 제공한다.

**Architecture:** CI는 docs/ui/full 프로필과 버전이 고정된 재사용 증거를 사용한다. 배포는 실제 앱별 baseline을 바탕으로 필요한 대상만 선택하고 `검증·이미지 준비 → 대상 갱신 → 전체 기대 상태 확인`의 세 단계로 실행한다. 기존 수동 도구와 운영 경계 회수 절차는 별도로 유지한다.

**Tech Stack:** Node24/GitHub Actions, Python standard library, 기존 Dokploy API/SSH 검증 도구.

## Tasks and ownership

- [x] CI agent: `scripts/ci-scope.mjs`, `ci-reuse.mjs`, 새 `ci-check.mjs`, 대응 Node tests, `.github/workflows/ci.yml`, `tests/ci-workflow.test.ts`. docs는 기존 생략, CSS·JSON 문구 허용 목록은 type/lint/unit/build 유지·DB 두 job만 생략, 나머지 full. 프로필·규칙 버전이 다른 artifact는 전체 검사 증거로 재사용하지 않는다. 실행: `node --test scripts/ci-scope.node-test.mjs scripts/ci-reuse.node-test.mjs scripts/ci-check.node-test.mjs`; `npm test -- tests/ci-workflow.test.ts`.
- [x] Scope agent: `scripts/ops/deployment_scope.py`, `tests/test_deployment_scope.py`. 실제17앱 등록부·ancestor가 증명된 두 tree 차이·rename 양쪽·실제 혼합 baseline을 처리한다. 좁힘 근거가 없으면 전체 대상으로 복귀하며 사용자 대상 옵션은 확장만 허용한다. 실행: `python3 -m unittest discover -s tests -p test_deployment_scope.py`.
- [x] Git runner agent: `scripts/ops/deploy_git_apps.py`, `tests/test_deploy_git_apps.py`. text/maintenance mini 두 개 → M3 두 개 → scheduler/connect 두 개, 최대 동시2·같은 역할 예비 먼저·후속 wave 실패 중단. worker5는 공통 immutable image로 갱신하고 scheduler 실제2복제본·전체 설정·실제 health를 보존한다. connect는 Git source manifest로 출처를 검증한다. 완료 단계 durable receipts와 한 번 실행 marker를 남기고 자동 재시도하지 않는다. 실행: `python3 -m unittest discover -s tests -p test_deploy_git_apps.py`.
- [x] Root integration: `scripts/ops/deploy_release.py`, `scripts/ops/release_runtime.py`, 대응 Python tests, package scripts/기본 운영 명령·runbook·AGENTS·handoff. no-op은 credential/API 호출 전 종료. CI check와 필요한 이미지 준비만 기다리고 cache job을 기다리지 않는다. 각 앱의 정확한 기존 설정·release/image·Swarm spec을 보존해 변경 대상은 새 버전, 나머지는 원 버전을 검증한다. 새 DB/catalog 변경은 자동 생략하지 않으며 기존 migration 증명을 요구한다. 장기 관측은 읽기 전용 별도 작업으로 둔다.
- [x] Integration/review: 로컬 관련 회귀를 실제 RED→GREEN으로 확인하고 동일 전체 suite를 agent마다 반복하지 않는다. 최종 source에 필요한 Node/Python/workflow 회귀·정적검사 및 필수 PR CI 한 건을 공통 증거로 사용한다. 승인된 변경을 PR로 main 반영하고 실제 결과·제한을 보고한다. 이 운영 도구/CI 변경 자체로 런타임 앱을 불필요하게 재배포하지 않는다.

## Verification cases

- 허용 CSS만이면 UI profile·web2 대상, 공유 lib/DB/CI 변경은 full CI, 분류 불명·rename 우회·다른 history는 full.
- partial artifact를 full로 재사용하거나 실패/skip된 필수 job을 성공 처리하지 않는다.
- 문서만 변경되면 운영 API·키체인·배포 호출0.
- role mini 성공 전 주 배포0, 동시 갱신 최대2, 실패한 wave 이후 요청0, 이미 시작한 동료 결과는 기록한다.
- 실행 전 앱/설정/릴리스·이미지·source·replicas·health 변화와 스냅샷 변조를 거절한다.
- 선택하지 않은 앱의 원 버전과 source를 검증하고, 실제 갱신 앱의 새 버전·출처를 검증한다.
- 완료 영수증 없이 재실행하거나 once marker를 재사용하지 않는다. 예약된 장기 관측을 실행 완료로 기록하지 않는다.

코드·DB·원장 안전 관문을 삭제하지 않는다. 독립 사람 holdout/apply=false·기존 h6 관측·원 미확정 회수/모델 종료/생산자 재등록은 이번 작업으로 재실행하지 않는다.

실제 완료: PR653/654 병합, 최종 코드 main64a8868d·PR CI40149298374·main CI40149879165 성공. 실제 GitHub ZIP/immutable image readiness 및 기존 private registry 관문을 읽기 전용으로 통과했다. 새 런타임 배포와 단축 실측은 수행하지 않았다. 상세 영수증과 후속 명령은 최신 handoff에 기록했다.

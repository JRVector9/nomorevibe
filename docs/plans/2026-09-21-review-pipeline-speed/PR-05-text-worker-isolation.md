# PR-05 — 발행과 번역·소개 작업 분리

제안 브랜치: `perf/isolate-text-worker` · 선행: PR-04 · 상태: 코드·Compose·운영 설정 예제 구현, 로컬 검증 완료. 운영 배포 전.

## 문제와 결과

publisher가 발행·사유 번역·소개 생성을 직렬 실행한다. 최근 로그의 번역 80회 중앙값은 30.3초였다. 발행 대상이 준비돼도 그 작업이 끝날 때까지 대기한다. **기존 번역·소개 생성 두 작업을 함께 전용 `text` 역할로 옮긴다.** 번역만 분리해 기존 소개 생성과 새로 겹치게 하는 방식은 사용하지 않는다.

## 역할 계약

| 역할 | 소유 작업 |
|---|---|
| publisher | `crawl-publish` |
| text (신규) | `reason-translate`, `crawl-tagline`, 서로 직렬 |
| reviewer/crawler/maintenance/scheduler | 기존 소유권 유지 |

기존 job 이름, requestedVersion, processedVersion, lease, 스케줄 주기를 유지한다. 새 job 행을 복제하지 않는다. 번역의 동시 요청 1, 소개 생성의 동시 요청 2를 유지하며 두 작업은 겹치지 않는다. 발행 분류는 기존 connect-agent 경로를 유지한다.

## 수정 범위

- `lib/jobs/catalog.ts`: JobRole/JOB_ROLES 및 소유 작업.
- `scripts/worker.ts`: 파서·usage. 역할 목록을 catalog에서 가져와 중복 하드코딩 정리.
- `scripts/worker-supervisor.ts`: RuntimeRole, budget, parse/health. 신규 text hard job timeout 180초, 기존 drain/heartbeat 계약 재사용.
- `lib/db/pool.ts`: text pool 기본 max=3. 실제 모든 인스턴스 합산 DB 연결 예산을 다시 산정.
- `lib/operations/{instance,contracts}.ts` 및 관련 서비스 상태 목록: 역할과 “소개·사유 번역” 라벨.
- `scripts/worker-healthcheck.ts`, `compose.yml`, 실제 Dokploy 앱 구성, `docs/operations/independent-workers-runbook.md`와 환경 예제.
- `tests/{job-catalog,worker-runtime,worker-supervisor,db-pool-config,db-pool-options}.test.ts`, 서비스 인스턴스/운영 화면 테스트.
- 기존 번역/소개 함수 내용과 모델·프롬프트·입력 해시·생성 결과는 변경하지 않음. DB 마이그레이션 없음.

## 구현과 배포 요구

1. text worker 실행 명령은 `npm run worker:supervised -- --role=text`. 구현 전에는 지원되지 않는 명령이다.
2. 같은 컨테이너 프로세스 안에서 publisher와 text를 함께 실행하지 않는다. 별도 health/instance ID로 상태를 확인한다. 새 인프라에 CPU/메모리/DB 풀 여유가 있는지 실측 후 설정한다.
3. 기존 두 작업의 실제 budget을 유지한다. `crawl-tagline`은 내부 54초 계산과 달리 worker의 현재 일반 budget은 25초이므로, 이동을 핑계로 55초로 올리지 않는다. reason-translate는 기존 55초. 예산 변경은 별도 근거 없이 섞지 않는다.
4. 소개가 채워져도 PR-04에서 강화한 원본·수동 작성·lease 검증과 `releaseForPublish` 조건을 통과해야 한다. PR-04의 원자적인 발행 신호를 사용한다. 소개 생성 결과만으로 제품을 삽입하거나 새 심사 승인표를 만들지 않는다.
5. 역할 이동 중에는 기존 publisher의 작업을 정상 drain한 뒤 새 publisher를 배포하고, 두 텍스트 작업을 더 이상 소유하지 않는지 확인한 다음 새 text worker를 시작한다. 짧은 텍스트 대기는 허용하되 요청은 DB에 보존한다.
6. 이전 publisher와 새 text worker를 동시에 오래 운영하지 않는다. 같은 job lease는 동일 작업 중복을 막지만 두 종류의 텍스트 작업이 서로 다른 구형/신형 프로세스에서 겹치는 부하는 막아주지 않는다.
7. 전체 역할의 모델 요청률·DB 연결 수를 확인한다. worker 분리가 모델 서버 자원 분리를 의미하지 않으므로 gateway 경합이 남을 수 있다.

## 필수 테스트 / 완료 조건

- catalog에서 각 job 소유 역할 정확히 하나, 두 텍스트 작업은 publisher 목록에 없음.
- text role 파서, DB pool, healthcheck, service instance가 실제 실행 가능한 하나의 계약으로 연결됨.
- 번역을 30초 대기시킨 테스트에서 준비된 publisher가 번역 종료 전에 발행 잡 시작.
- text worker 중지 중에도 발행 진행; 텍스트 pending 요청은 보존되고 재시작 후 처리.
- 번역 hash/개수/원문 보호, 소개의 source CAS·관리자 문구 보호·최종 발행 관문 불변.
- drain 도중 작업 종료/신규 기동/롤백을 반복해 중복 호출·유실 없는지 검증. 오래된 lease의 쓰기 차단 유지.

계획된 명령:

```sh
npx vitest run tests/job-catalog.test.ts tests/worker-runtime.test.ts tests/worker-supervisor.test.ts tests/db-pool-config.test.ts tests/db-pool-options.test.ts tests/translate-reasons-job.test.ts
npm run test:integration -- tests/integration/job-control.test.ts tests/integration/translations.test.ts tests/integration/crawl-tagline.test.ts tests/integration/review-publication-gate.test.ts
npx tsc --noEmit
npm run build
```

신규 역할의 실제 컨테이너 기동/health는 Vitest 통과와 별도로 확인한다. 앱 UI를 수정하게 되면 해당 `node_modules/next/dist/docs/` 안내를 먼저 읽는다.

## 롤백

text worker를 drain/중지하고 기존 publisher 역할 구성을 복구한다. 기존 이름의 잡 요청·번역·소개 이력은 그대로 이어받는다. 건강한 publisher를 두 개 띄워 소유권 혼합 상태로 롤백하지 않는다. 새 worker를 만들 수 없는 환경이면 이 PR은 배포 준비 미완료로 표시하고 다른 역할에 임의로 작업을 밀어 넣지 않는다.

## 실행 결과

text 전용 소유권·파서·pool3·supervisor180초·instance/health·운영 화면 라벨을 연결했다. 소유권/실행 차단 테스트2 RED→GREEN, 관련7파일36개와 타입 검사 통과. 번역 대기 중 publisher가 먼저 발행 작업을 시작하고 text의 두 작업은 직렬임을 확인. Compose 및 운영 overlay 예제/배포 순서/합산 pool27(웹1),35(웹2 기본8),31(웹2 각6) 문서화. 실제 Dokploy 구성 변경·배포는 하지 않았으며 컨테이너 기동 검증은 PR06에서 실시한다.

# Qwen 중심 제품 보강 PR 실행 계획

GPU Qwen을 빠른 주 처리, M1 Qwen을 비동기 공동 처리에 사용하고 DeepSeek는 충분한 근거의 의미 충돌과 독립 표본 감사만 맡긴다. **11개 PR로 나누며 자동 내림 확인을 먼저 완성한다. M1 사설 경로 준비와 뉴스 제품 결정은 GPU 핵심 개발을 막지 않는다.**

상태: **01~10 구현과 범위 검증 결과를 정리했으며, 11의 정확한 통합 SHA 전체 검증은 대기 중이다. 운영 전환은 실행하지 않았다.** 설계 기준 main은 [c37ae82f](https://github.com/JRVector9/nomorevibe/commit/c37ae82fbad208f519bc99ce143a934cf5e05e65)다. 아래01~11은 계획 식별자이고 실제 GitHub PR은 다음 표에 구분했다. 원래의 업무별 선행 조건·검증·중단 기준은 각 문서에 보존한다. 기계 판독용 상태는 [implementation-plan.json](implementation-plan.json), 상세 실행 기록은 [개발 기록](../../operations/2026-10-23-qwen-first-development.md)에 있다.

## PR 분할

| 순번 | 결과 | 직접 선행 | Migration |
|---|---|---|---|
| [01](PR-01-contracts-evaluation.md) | 근거·작업별 프롬프트·출력·backend 계약과 평가 | 없음 | 없음 |
| [02](PR-02-direct-capacity.md) | 기존 direct 호출의 공통 슬롯·종료 장부 연결 | 01 | 있음 |
| [03](PR-03-m1-private-ingress.md) | M1 인증 사설 모델 경로와 설치·회수 절차 | 02 | 없음 |
| [04](PR-04-work-uptime-candidates.md) | 보강 work/result 큐와 uptime 두 후보 생산 경로 | 01, 02 | 있음 |
| [05](PR-05-uptime-confirmation.md) | 비동기 재접속·GPU Qwen 확인·최종 내림 gate | 01, 02, 04 | 목표 없음 |
| [06](PR-06-qwen-screen-prompts.md) | 운영 Qwen v3·화면 shot2의 범위·근거 출처 정정 | 01 | 조건부 가산 |
| [07](PR-07-repository-move.md) | 저장소 공식 이전 검증과 주소 변경 후보 | 01, 02, 04 | 있음 |
| [08](PR-08-intro-recheck.md) | needs_editor 명시 재진입과 Qwen 재검수 | 01, 02, 04, 06 | 있음 |
| [09](PR-09-exceptions-independent-audit.md) | 제한된 DeepSeek 예외·주간 독립 표본 감사 | 01, 02, 04, 05, 07, 08 | 있음 |
| [10](PR-10-news-localization.md) | 뉴스 전용 한국어 사실 검증·비공개 초안 | 01, 02, 04 | 있음 · 공개 노출은 제품 결정 후 |
| [11](PR-11-integration-rollout.md) | 정확한 통합 SHA 검증·readiness 도구·운영 전환 runbook | 01, 02, 04, 05, 06, 07, 08, 09 | 없음 |

## 실제 구현과 검증 상태 (2026-10-23)

| 순번 | 실제 PR | 현재 구현·범위 검증 | 남은 확인 |
|---|---|---|---|
| 01 | [#628](https://github.com/JRVector9/nomorevibe/pull/628) | 계약·프롬프트·오프라인 평가, unit 15건 | 실제 근거의 모델 비교 |
| 02 | [#631](https://github.com/JRVector9/nomorevibe/pull/631) | direct 8개 목적, unit 103건·최종 DB/HTTP 23건 | `globalReady=false`, 실제 caller/alias/readback inventory |
| 03 | [#630](https://github.com/JRVector9/nomorevibe/pull/630) | 사설 relay·설치물·readiness 범위 10건 | 실제 M1 설치·worker 접근·혼합 추론 |
| 04 | [#632](https://github.com/JRVector9/nomorevibe/pull/632) | 공통 큐·확인 gate, DB 58건·binding 5건 | 최종 통합 SHA 전체 검사 |
| 05 | [#633](https://github.com/JRVector9/nomorevibe/pull/633) | 실제 DB/localhost 모델 native 13건 | 실제 모델 품질·운영 confirm 허용 |
| 06 | [#629](https://github.com/JRVector9/nomorevibe/pull/629) | v3/shot2 명시 선택·근거 provenance, unit 69건 | native 정규화 후 전송 해시 보강을11에 통합 |
| 07 | [#634](https://github.com/JRVector9/nomorevibe/pull/634) | native 8건+기존 12건=20건 | 최종 잠금 경합·전체 검사 |
| 08 | [#635](https://github.com/JRVector9/nomorevibe/pull/635) | 사실/교정 별도 native 12건+기존 23건=35건 | 재시작 복구·최종 전체 검사 |
| 09 | 발행 후 URL 기록 대기 | native 10건+주간 감사 5건=15건 | 후속 잠금 수정·최종 전체 검사 |
| 10 | 발행 후 URL 기록 대기 | 비공개 초안 native 20건 | 공개 노출 제품 결정·실제 뉴스 의미 검수 |
| 11 | 발행 후 URL 기록 대기 | 오프라인 readiness 도구·runbook 구현 | 정확한 SHA·fresh 124개 migration·전체 unit/DB/build·필수 CI |

앞선 PR은 `gh` 읽기 조회로 draft/head/base를 확인했다. 09~11의 실제 PR URL과 최종 검사 결과는 통합 담당자가 발행·검사 후 표와 JSON에 함께 기록한다. 기존 회귀가 여러 묶음에 겹치므로 위 수치를 합산해 고유 검사 수나 모델 정확도로 보고하지 않는다.

현재 회귀의 모델 서버는 localhost 가짜 HTTP 서버다. 단, PR02의 첫 fixture 호출 서명 오류로 합성 입력 3회가 실제 Qwen endpoint에 전달됐다. 그 실행은 성공 검증에서 제외하고 fixture URL 이외 전송 차단 후 재검증했다. [실패·수정 기록](../../operations/2026-10-23-local-model-capacity-validation.md)을 보존하며 운영 DB·설정 변경은 없었다.

PR02는 가장 무거운 기초 변경이다. typed direct 계약·가산 DDL, 불투명 종료 증인, 기존 caller 연결, 실제 경합·abort 회귀의 내부 커밋으로 나누고 업무 프롬프트·새 기능을 섞지 않는다. 안전하게 검토할 수 없을 만큼 커지면 그 경계에서 별도 PR로 나누고 계획 식별자를 갱신한다. 기존 capacity·consumer·관측·회수 상태기를 다시 만들지 않는다.

## 착수와 병합 순서

- 첫 착수는01이다. 01 뒤 **02·06을 병렬 개발**한다.
- 최우선 경로는 **01 → 02 → 04 → 05**다. 04는 첫 생산자를 포함한 큐이며, 실제 내림 전 확인의 완성은05다.
- 03은02 뒤 병렬로 준비한다. **GPU 핵심은03을 기다리지 않는다.** 03의 실제 설치·접근 검증을 마친 뒤에만 M1을 실행 backend로 연다. 03은 최종 M1 상시 활용 목표에는 필수이며, 완료 전에는 GPU 우선 단계만 준비됐다고 보고한다.
- 04 뒤07을, 04·06 뒤08을 병렬 개발할 수 있다. migration·catalog·공통 work/contract 파일은 동시 수정 뒤 각 PR을 최신 base로 재검증한다.
- 05·07·08이 결정 출처를 기록하면09를 연결한다. 그 전의 충분한 근거 충돌은 pending/사람 큐로 남기며 동기 DeepSeek fallback을 넣지 않는다.
- 10의 비공개 초안 backend는 기본 off로 구현했다. 한국어 노출 위치·요약 범위·게시 검수 제품 결정 전에는 공개 조회를 연결하거나 원문 상태를 바꾸지 않는다. 핵심01·02·04·05·06·07·08·09의 운영 전환을 강제하지 않는다.
- 11은 core의 정확한 통합 SHA에서 검증·운영 전환 근거를 확정한다. 03 또는10을 같은 차수에 포함하면 그 코드까지 넣은 SHA를 검증한다.

현재 draft는 의존 브랜치를 base로 제출했다. 01은 main, 02·03·06은01, 04는02, 05는04, 07은05, 08은07 위에 있으며 09~11도 통합 순서로 연결한다. 이는 위의 업무별 선행 조건과 구분한 제출 순서다. 선행 병합 후 최신 main과 필수 CI를 다시 맞추며, 등록만으로 기능을 활성화하지 않는다.

## 작업별 분담

| 대상 | GPU Qwen | M1 Qwen | DeepSeek |
|---|---|---|---|
| uptime | 최신 상태 분류 주 처리 | 필요한 화면·추가 근거 또는 여유 있는 판정 | 근거가 충분한 의미 충돌만 |
| 저장소 | 비동기 공유 큐 | 비동기 공유 큐 | 공식 이전·계보 판단 충돌만 |
| 소개 | M1과 공동 처리·적체 소진 | README·현재 화면 재검수 | 충분한 근거의 예외·독립 감사 |
| 감사 | 다른 기반 모델·규칙 결정의 근거 검토 | 동일 조건의 공동 처리 | Qwen 결정의 정해진 독립 표본 |
| 뉴스 | 유휴 슬롯으로 공동 처리 | 저우선순위 공동 처리 | 전건 확인하지 않음 |

일반 `product-llm-assist-review`는 GPU/M1 Qwen의 지원 업무를 처리한다. 독립 감사는 별도 `product-llm-assist-audit-review` 잡과 reviewer의 `assist-audit` 줄에서 105초 예산으로 처리하고, `product-automated-action-audit`는 maintenance에서 매시간 20초 예산으로 주간 표본·의미 예외만 생산한다. DeepSeek 응답을 보류한 동안 일반 Qwen이 새 job token으로 다음 호출을 완료하는 회귀를 확인했다. 주간 선정·예외 한도와 실제 UTC 주간 native dispatch 한도는 명시 설정이며, 감사 설정이 없으면 off다.

GPU/M1을 건수50:50으로 고정하지 않는다. 각 backend의 빈 슬롯이 같은 지원 작업 큐를 소비하고, GPU는 한가할 때 비동기 적체도 처리한다. 실제 M1에서 도는 화면·텍스트 추론은 하나의 물리 슬롯을 공유한다. GPU와 M1은 별도 자원이나 같은 Qwen family이므로 두 답의 일치를 독립 감사로 세지 않는다.

## 그대로 유지할 정책과 실행 권한

1. 401·403·429·999 제외, 광역 실패 보류, 현재 실패 횟수와 관리자 해제 보호를 유지한다. 기존 uptime25초·repo50초 등 생산자 시간 예산에 긴 재접속·모델 대기를 추가하지 않는다.
2. 메이커/운영자·active maker·사람 편집·원문/제품 세대·lease 보호와 저장소 일일 내림 한도100을 유지한다. 모델 action은 제안이며 실제 내림·URL 변경·소개 수정은 서버 트랜잭션이 결정한다.
3. 화면 틱당1건·0.95 기준과918건 일괄 미적용 상태를 유지한다. 이번 새 업무의 confidence 임계값을 기존 화면 값으로 대체하지 않는다.
4. 용량 대기·진짜 timeout·짧은 틱으로 생긴 timeout·invalid JSON·근거 부족·의미 충돌을 구분한다. 모두 DeepSeek로 우회하지 않는다.
5. 원격 호출 종료 불명 상태는 local abort·socket EOF·lease 만료·TTL만으로 풀지 않는다. 기존 indeterminate·정산 규칙을 유지한다.
6. 새 결과는 입력·URL·raw DB 시각 정밀도·policy/prompt/schema·모델/backend revision이 유효할 때만 적용한다. 같은 실패 관측이 계속 큐 상단을 독점하지 않게 처리 revision을 선택 조건에도 반영한다.

## 구현 전에 확인한 기반 제약

- 기존 model capacity와 native ledger를 재사용한다. Qwen/DeepSeek/screen 직접 호출을 abcllm으로 위장하지 않는다. 같은 GPU로 전달되는 gateway alias도 실제 물리 group에 포함해야 전체 한도를 보장할 수 있다.
- `model_capacity_control`은 전역 설정이다. **새 local caller만 연결한 뒤 open을 켜면 기존 번역·검색이 멈출 수 있다.** 실제 활성 caller·정책·계약·종료 경로를 모두 대조하기 전에는 운영 전역 활성화 준비 완료로 표시하지 않는다. 미완료 연결은 후속 구현 범위로 명시하고 신규 기능을 무계량 fallback으로 열지 않는다.
- M1 oMLX의 확인된 모델 API는 loopback이며 시험은 SSH 내부에서 실행했다. M1 renderer HTTP가 모델 경로를 뜻하지 않는다. mini 예비 reviewer의 확인된 설정은 렌더M1·모델GPU 기본값이고, M3 주 reviewer 모델 환경은 미확인이다. PR03은 설치물 준비와 실제 운영 경로 확인을 구분한다.
- `pipeline_item_leases`는 fetch/ai1/ai2용이다. 새 보강 업무를 여기에 억지로 넣지 않고 작은 typed domain work를 기존 job/role lease로 처리한다. 물리 호출 attempt는 기존 ledger만 사용한다.
- 열린 [#549](https://github.com/JRVector9/nomorevibe/pull/549)·[#550](https://github.com/JRVector9/nomorevibe/pull/550)는 text lane 분리 draft다. 이 계획의 필수 선행으로 삼거나 같은 변경을 다시 구현하지 않는다. 함께 병합하면 catalog·worker·DB pool·공유 부하를 다시 확인한다.

## 검증 기준

기존261회는42개 합성 근거를 기준/수정 프롬프트·장비별로 반복한 시험이다. 단건 중앙값은 처리용량이 아니며 새 `state/evidence_quality/action` 계약이나 운영 Qwen v3/shot2의 성적으로 승계하지 않는다. [초안 계약](assets/process-prompts.draft.json)은 구현용 출발점이며 아직 새 모델 호출로 검증하지 않았다.

PR01에서 모델만·프롬프트만·근거만 바꾸는 비교를 분리하고 실제 평가 자료의 source/revision·라벨 근거·모델 판·wire와 목표를 고정한다. 공개 정책을 바꾸는 threshold나 처리량 수치를 측정 뒤에 맞춰 완화하지 않는다.

| 작업 | 준비할 실제 근거 | 우선 확인 |
|---|---|---|
| uptime | 다시 열린12건과 종료·파킹·soft404·점검·차단·지연·JS 화면 | 살아 있는 제품 오내림, 기권·재수집, 반복 후보화 |
| 저장소 | repo_link_alive42건을 실행 시 재조회하고 공식 rename·fork·SDK·동명 사례 포함 | 잘못된 주소 교체, 공식 관계·근거 부족 구분 |
| 소개 | needs_editor107건을 실행 시 재산출하고 현재 README·화면·작성자 확인 | 사실 추가·언어·메이커 침범·적체 해소 |
| 감사 | 원결정 시점과 현재의 근거를 따로 보존한 종류별 표본 | 독립 모델 자격, 동조, 당시 오판과 현재 회복 구분 |
| 뉴스 | 출시/preview/연기/가격단위/미재현/공개범위 사례 | 가격 분모·단계·이름·유보 표현 보존 |

후보 평가 자료의 치명적 정책 위반·오내림·잘못된 URL·메이커 덮어쓰기는 각각 실패로 드러내고 해결/보류 근거를 남긴다. 소수 표본에서 오류가 없다는 사실을 운영 오류율0으로 보고하지 않는다. 독립 라벨·충돌 사례를 먼저 고정하고 자동 적용 여부는 이 결과와 현재 정책으로 판단한다.

AGENTS에 따라 PR별로 변경 범위 회귀와 필요한 정적 검사만 수행한다. 필수 CI는 그대로 유지한다. 수동 전체 unit/전용DB/종합 검증은 **본 차수 개발이 끝난 정확한 통합 SHA에서 한 번** 수행한다. 뉴스가 뒤 차수면 옛 SHA의 통과를 새 코드의 결과로 인용하지 않는다.

단위 검사는 `npx vitest run <해당 PR의 테스트 파일>`로, DB 회귀는 전용 `TEST_DATABASE_URL`을 사용한 `npm run test:integration -- <해당 파일>`로 실행한다. 소스 변경의 타입·lint는 기존 package 명령을 따른다. 각 범위 결과는 해당 검사 당시 SHA에 한정한다. 최종 통합 SHA의 전체 검사·필수 CI 결과가 없으면 전체 완료로 기록하지 않는다.

## 운영 전환과 중단

새 경로는 기본 비활성이다. 04의 shadow 후보 생성은 오내림 방지 완료가 아니다. 05와 생산자를 함께 준비하고, 승인된 confirm 모드에서만 실제 내림 전 gate가 작동한다. confirm 모드에서 dispatch/apply를 멈춰도 pending을 옛 즉시 내림으로 보내지 않는다.

새 job은 catalog·registry·stage/제외 사유·JOB_HOW·attention.work·pause/resume 동작을 함께 맞춘다. 현재 job control의 legacy/versioned/draining 차이를 보존하고 실제 새 consumer가 멈추지 않았는데 UI만 멈춤으로 표시하지 않는다.

현재 전체 운영16앱/21컨테이너와 공통 이미지 배포8앱 범위를 구분한다. 기존 [독립 워커 runbook](../../operations/independent-workers-runbook.md)에 따라 필요한 migration 확인 → 새 잡이면 scheduler 선배포 → 공통8앱 → git 빌드 소비자 순으로 계획한다. 역할 쌍은 mini 예비→M3 주, 기본 순차 배포를 사용한다.

인수인계의 **운영 배포·DB 쓰기·자동 적용·차단 해제 승인 조건**은 그대로다. 구현·오프라인 검증·설치물·dry-run·배포 계획을 먼저 구체화하고 실행 직전의 승인 단계로 남긴다. 현재 정상인12건 복구는 코드 PR에 섞지 않는다. 이번 개발에서 운영 배포·DB 쓰기·모델 서버 설정 변경·자동 기능 활성화·12건 차단 해제는 하지 않았다.

## 산출물 상태

원래 계획의 검증 목록과 실제 범위 실행 기록을 구분한다. 03의 디렉터리 fsync·root 소유 readback 검증은 설치물 보강이며 전원 차단 실험이나 실제 M1 도입 완료가 아니다. 06의 native 정규화 후 wire hash와 `context_strategy:raw` 보강(`6c634c6a`)은11에 통합할 대상으로 남아 있다. 뉴스는 원문·공개 상태를 바꾸지 않는 `draft/needs_review` 저장만 제공하고 기본 비활성이다.

최종 통합 SHA, fresh migration 124개, 전체 unit·전용 DB·build·typecheck·lint·필수 CI의 정확한 결과는 [PR11 최종 기록 표](PR-11-integration-rollout.md)에 통합 담당자가 채운다. 이 칸이 대기 중인 동안 개발 범위 회귀를 전체 통합 또는 운영 승인으로 바꾸어 보고하지 않는다.

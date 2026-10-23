# Qwen 중심 제품 보강 개발 기록

설계 순번01~11의 실제 구현과 범위 검증을 기록한다. 설계 기준 main은 `c37ae82f`, 최초 계획 커밋은 `12fbf0bc`다. 이 상태 문서의 기준 스냅샷은 `ea612754`이며 후속 범위 검증은 아래 증거 커밋을 참조한다. **최종 통합 SHA의 전체 검사와 운영 전환은 아직 별도 단계다.**

| 순번 | 실제 draft PR | 구현·범위 결과 | 운영/통합 상태 |
|---|---|---|---|
| 01 | [#628](https://github.com/JRVector9/nomorevibe/pull/628) | serving·근거·출력 계약, prompt, 오프라인 평가; unit3파일15건 | 실제 모델 품질 검증과 구분 |
| 02 | [#631](https://github.com/JRVector9/nomorevibe/pull/631) | direct8개 목적·native binding/terminal·대칭 fence; unit103, 최종 DB/HTTP23 | `globalReady=false` |
| 03 | [#630](https://github.com/JRVector9/nomorevibe/pull/630) | 인증 사설 relay·설치물·fsync/readback uid 보강; relay/readiness10 | 실제 M1 설치·혼합 추론 미검증 |
| 04 | [#632](https://github.com/JRVector9/nomorevibe/pull/632) | 공통 work/result/control, 중복 후보·확인 gate; DB58·binding5 | 기본 off |
| 05 | [#633](https://github.com/JRVector9/nomorevibe/pull/633) | native13; M1 대기 중 GPU 결과가 먼저 commit | 기본 off·실제 confirm 미실행 |
| 06 | [#629](https://github.com/JRVector9/nomorevibe/pull/629) | 명시 v3/shot2·근거 provenance; unit9파일69 | native 정규화 후 hash 보강은11에 합류 |
| 07 | [#634](https://github.com/JRVector9/nomorevibe/pull/634) | native8+기존12=20; 공식 이전·현재 페이지·CAS·보호·100/day | 최종 잠금 경합 검사 대기 |
| 08 | [#635](https://github.com/JRVector9/nomorevibe/pull/635) | native12+기존23=35; 별도 교정 호출·Sonnet 원행 보존 | 복구 3건 통합·전체 결과는 PR11 참조 |
| 09 | [#636](https://github.com/JRVector9/nomorevibe/pull/636) | native10+domain5=15; 별도 감사 잡·블라인딩·실제 주간 한도 | 기본 off·잠금 수정/경합 3건 통합 |
| 10 | [#637](https://github.com/JRVector9/nomorevibe/pull/637) | native20; 원문/공개 상태 보존·비공개 draft/needs_review | 기본 off·노출 제품 결정 대기 |
| 11 | [#638](https://github.com/JRVector9/nomorevibe/pull/638) | readiness 도구·runbook 범위 구현 | 정확한 통합 SHA의 전체 검증 대기 |

앞선8개 PR의 draft/head/base는 `gh pr list` 읽기 조회로 확인했다. 09~11 URL은 발행 뒤 [계획 JSON](../plans/2026-10-23-qwen-first/implementation-plan.json)의 `github_pr`와 함께 갱신한다. 서로 겹친 기존 회귀를 더해 고유 테스트 수나 모델 정확도로 보고하지 않는다.

## 검사 환경과 해석

Node `24.22.1`과 lockfile의 의존성을 사용했다. 범위별 unit/격리 PostgreSQL·localhost 가짜 HTTP/native 회귀와 필요한 정적 검사를 수행했다. 새 테스트는 자신이 만든 loopback 전용 DB·원격 fixture만 사용하고 원래 singleton·role/job lease·장부 행·immutable trigger 상태를 복구했다. DB 회귀는 실제 역할/업무/용량 원장과 적용 트랜잭션을 검증하지만 실제 모델 품질이나 운영 처리량의 실험은 아니다.

수동 전체 unit·전체 전용 DB·build는 모든 코드·회귀가 합류한 정확한 통합 SHA에서 한 번 수행한다. GitHub 필수 CI는 유지한다. 현재 최종 SHA·fresh125개 migration/적용 hash·전체 검사·필수 CI의 명령/종료 코드/산출물 hash는 [실제 PR11 본문](https://github.com/JRVector9/nomorevibe/pull/638)과 `/home/ubuntu/reports/nomorevibe-llm-development-2026-10-23`에 기록한다. 이 문서는 이를 통과로 대체하지 않는다.

## 주요 구현과 보존한 정책

- backend와 기반 모델을 구분한다. GPU/M1 Qwen은 같은 family이고 물리 자원만 별도다. exact serving readback hash·물리 한도·전체 caller/alias inventory가 없으면 전역 open 준비 완료로 표시하지 않는다.
- uptime의 기본 off는 기존 동작, shadow는 후보 관측이다. confirm 이후 gate는 latched이며 dispatch/apply를 멈춰도 pending이 옛 즉시 내림으로 돌아가지 않는다. 원문 microsecond revision·관리자 해제·광역 실패·401/403/429/999 제외를 유지한다.
- 저장소의 정체성·계보·공식 연속성을 나눈다. 현재 page/README/repo를 수집하고 페이지에 의존한 내림은 적용 직전 본문/URL/HTTP/완전성을 다시 비교한다. maker·claimed·운영자 keep·숨긴 링크·일일100건을 보호한다.
- 소개는 명시 needs_editor 요청만 재진입한다. 첫 사실 결과와 별도 native 교정 요청을 연결하고 실제 terminal/input/wire/response/contract hash를 검증한다. 원 Sonnet 성공행·attempts·original*는 유지한다.
- `product-automated-action-audit`는 maintenance에서 매시간20초 예산으로 생산한다. `product-llm-assist-audit-review`는 별도 reviewer/assist-audit 잡으로 105초 예산 안에서 독립 모델을 호출한다. DeepSeek를 대기시킨 동안 일반 Qwen이 새 job token으로 두 회차 완료하는 회귀가 있다. 예외·표본과 실제 UTC 주간 native 호출 한도는 명시 설정이며 기본 off다. 불일치는 record-only/human으로 남기고 자동 복구하지 않는다.
- 뉴스는 명시 수요를 `news_item` target과 전용 정책 source hash로 묶는다. 원문 `title/summary/state`와 공개 조회는 바꾸지 않고 `draft/needs_review`만 저장한다. source가 오래됐다는 이유로 현재 DB 세대를 새 수집 시각으로 위조하지 않는다.

## 실패와 수정 기록

1. PR01의 초기 평가 fixture literal type 오류는 수정 후 unit·ESLint·typecheck를 재실행했다.
2. PR02 첫 fixture가 `reviewWithQwenDirect`를 잘못된3인자 서명으로 호출하여 합성 입력3회가 실제 Qwen endpoint에 전달됐다. 운영 DB·설정 변경은 없었다. 해당 실행은 성공 검증에서 제외했고, 2인자 opts와 fixture env/request·global fetch/native request URL guard를 고친 뒤 loopback HTTP·model·thinking·response hash를 재검증했다. [상세 기록](2026-10-23-local-model-capacity-validation.md)을 보존한다.
3. PR04 초기 DB 별칭은 전용 테스트 DB 이름 가드에 거절됐다. 가드를 바꾸지 않고 격리 DB 이름을 맞춰 재실행했다. 0118 뒤0119 journal 등록·전체 신규 DDL 적용과 DB58건을 확인했다.
4. PR05 reaper의 varchar/uuid lease 비교 오류와 PR08 순환 import의 초기화되지 않은 schema 오류는 명시 cast·지연 schema 초기화로 수정하고 실제 native 흐름을 다시 검증했다.
5. PR07의 source page freshness와 PR10의 독립 가격 문장에 대한 전역 분모 상속을 보강했다. 뉴스 수정 `2077ca93`은 명시 분모 없는 독립 절을 unsupported→needs_review로 닫고 기존/신규 unit28건을 통과했다.
6. PR09 pause fixture는 예약 취소 행 자체가 없어야 한다는 과한 기대를 정상 `withdrawn`/미dispatch/attempts0로 고쳤다. 독립 리뷰의 repository/audit 잠금 순서와 reaper 시도 계수 수정은 후속 통합·복구·경합 회귀와 함께 최종 SHA에서 확인한다.
7. `6c634c6a`의 비권한 WeakMap 관측은 native 정규화 후 실제 전송 hash를 text/vision에 연결하고 raw context_strategy만 검증 후 제거한다. 별도 unit13/native DB4와 함께11에 통합했다. 당시 전체 tsc의 테스트 타입 오류1건은8a30253f에서 수정했고 원래 실패를 보존한다.

## 증거와 다음 기록

| 범위 | 증거 커밋/문서 |
|---|---|
| PR02 | `053f9e21`, `c0977d89`, [direct 검증](2026-10-23-local-model-capacity-validation.md) |
| PR03 | `48763ee5`, [사설 경로](local-model-private-ingress.md) |
| PR05 | `ebfed2f0`, native13 |
| PR07 | `7fbeedfa`, [저장소 개발](2026-10-23-repository-move-development.md) |
| PR08 | `3c58075e`, [소개 backend](../plans/2026-10-23-qwen-first/PR-08-backend-integration.md) |
| PR09 | `bfd2eec6`, [독립 감사](2026-10-23-automated-action-audit-development.md) |
| PR10 | `ac902ae3`, [뉴스 backend](../plans/2026-10-23-qwen-first/PR-10-backend-integration.md) |
| PR11 | `980feabe` readiness; `6c634c6a` wire 보강 합류 대기 |

기존261회/42개 합성 근거의 모델 비교를 새 schema·v3/shot2의 실제 정확도나 생산 용량으로 승계하지 않는다. 실제 근거의 사람 독립 라벨·holdout 비교·오내림/주소 오류/메이커 침범 검수와 운영 정책 승인은 남아 있다.

운영 배포·운영 DB 쓰기·모델 서버 설정 변경·새 자동 기능 활성화·현재 정상인12건 차단 해제는 수행하지 않았다. 코드/범위 검증 완료, 오프라인 증거 검토 자격, 실제 운영 승인·실행을 별도 상태로 기록한다.

최종 전체 검사에서 발견한 수정:

- 신규 assist·독립 감사·감사 생산 잡 3개를 비상 운영에서 명시 중단 분류하고 pause/aging/모델 검증 상태에서도 우회하지 않음을 확인한다.
- 최초 전체 unit의 schema 검사는0118 고정 가정으로 실패했다. 최신 CHECK를 비교하도록 보강하자 과거 assist OR 분기가 감사 task에 일반 consumer job을 허용하는 실제 차이를 발견했다. 0124에서 현재 Drizzle과 일치시키고 실제 DB 거절 회귀를 추가한다.
- 기존 SSRF 단위 검사의 example.com:443 요청은 테스트 전용 외부 연결 가드와 충돌했다. 해당 공인 문서만 명시 허용하며 실제 모델 endpoint 차단을 유지한다.
- 전용 PostgreSQL 초기 기동 중 일시 연결 reset과 호스트 /tmp inode 소진은 검사 환경 문제로 기록한다. TCP 준비 확인과 /home 전용 TMPDIR로 재검증한다. 운영 데이터나 다른 작업의 임시 파일은 정리하지 않는다.

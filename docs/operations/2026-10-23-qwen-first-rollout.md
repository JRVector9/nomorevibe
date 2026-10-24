# Qwen 보강 경로의 검증과 운영 전환

이 문서는 PR-11의 실행 준비물이다. 코드 PR 병합, 가짜 HTTP 회귀, 오프라인 manifest 통과는 운영 배포·전역 capacity open·자동 적용의 승인이 아니다. 실제 운영 DB 쓰기, M1 설치, 배포, 기능 활성화는 정확한 실행 계획과 증거를 검토한 뒤 기존 인수인계의 승인 단계에서 수행한다. 현재 정상으로 관측된 12건의 차단 해제는 이 작업에 포함하지 않는다.

구현 산출물은 `lib/operations/llm-assist-readiness.ts`와 `scripts/verify-llm-assist-rollout.ts`다. 도구는 제공된 JSON 한 파일의 일관성만 검사하며 DB·네트워크·환경 파일·배포 API를 열지 않는다. 출력의 `productionEligibleForReview`는 제출된 증거 묶음의 검토 자격이다. `productionReady`, `automaticApplyAuthorized`, `mutations`는 항상 false다. 산출물의 진위나 현재 운영 상태를 도구가 독립 인증했다고 해석하지 않는다.

## 먼저 기록할 결과

코드 개발 완료와 운영 적격성을 별도로 기록한다. 이 차수 전체 PR 개발이 끝난 **정확한 통합 SHA**에 전체 unit·전용 DB·build를 한 번 수행하고, 명령·종료 코드·산출물 hash를 남긴다. PR마다 전체 검증을 반복하지 않으며 GitHub의 필수 `check` CI는 그대로 유지한다. TypeScript·lint·필수 CI도 같은 SHA로 연결한다. 이후 코드가 바뀌면 이전 SHA의 통과를 새 SHA의 결과로 인용하지 않는다.

최종 기록에는 통합 SHA와 migration journal, 실제 적용 여부, 전체 검사 산출물, scoped 회귀와 수정 전 실패, 실제 모델 호출 여부를 함께 적는다. 다음 세 종류는 섞어 집계하지 않는다.

- 로컬 가짜 HTTP/CLI·격리 DB 회귀: 상태기·CAS·수용량·중단 동작의 검증이다.
- 실제 모델의 고정 근거 비교: 모델·prompt/schema·endpoint/quantization/adapter revision·wire hash·dataset을 연결한다.
- 승인된 운영 설치·배포·shadow·confirm 실행: 실제 실행 뒤 별도의 관측 결과를 남긴다.

현재 이 문서를 추가하는 작업에서 운영 모델 호출·DB 접근·배포는 실행하지 않았다. 최종 통합 SHA의 전체 결과와 실제 운영 증거는 통합 담당자가 기록한다. 기존 261회 합성 요청과 42개 근거 시험은 새 schema·프롬프트의 정확도나 운영 처리량으로 승계하지 않는다. 격리 테스트가 실수로 실제 endpoint를 호출한 경우도 가짜 서버 검증과 분리해 실패 기록에 남긴다.

## 오프라인 증거 검사

Node 24에서 아래 명령을 실행한다. `--schema`는 strict JSON Schema만 출력한다. manifest가 없거나 증거가 부족하면 닫힌 plan을 출력한다. `--apply`는 지원하지 않으며 기존 출력 파일을 덮어쓰지 않는다.

```bash
node --import tsx scripts/verify-llm-assist-rollout.ts --schema
node --import tsx scripts/verify-llm-assist-rollout.ts --manifest /검증한/rollout-manifest.json --out /새/rollout-report.json
```

종료 코드 0은 제공된 증거가 검토 자격을 갖췄다는 뜻이다. 1은 누락·불일치로 보류, 2는 인자·파일·JSON 오류다. 어느 종료 코드도 운영 변경을 실행하지 않는다. 최상위 필수 필드는 `version:1`, `integratedSha`이며 다른 묶음은 누락 시 기본적으로 보류한다. `asOf`와 `maxEvidenceAgeMs`를 명시해야 readback의 신선도를 판정한다. 도구에는 임의 운영 유효기간·처리량·정확도 임계값이 없다.

| 증거 묶음 | 포함할 실제 자료 | 검사 목적 |
|---|---|---|
| `codeChecks` | unit·integration·build·typecheck·lint·required_ci 각각의 정확한 SHA, 결과, artifact hash | 설계·부분 검사·옛 SHA 통과를 전체 개발 완료로 합치지 않음 |
| `contracts`, `verifiedContractHashes`, `readbacks` | backend/물리 group, 실제 endpoint·응답 model, quantization/adapter를 포함한 deployment revision, 실제 전체 context C, readback 시각과 artifact | config shape·추정 token·`max_tokens`를 실제 서버 계약으로 대체하지 않음 |
| `physicalLimits`, `policy`, `inventory` | 전체 활성 caller의 기대 목록과 관측 목록, route/provider/model, native terminal 계약 근거, 모든 gateway alias와 실제 물리 group·한도 readback | 새 local caller만 열고 기존 text/search/CLI caller를 미연결로 남긴 global open 방지 |
| `native` | 같은 SHA의 실제 원장 readback, 미정산 요청 ID, backend별 실제 native canary의 request/response/terminal hash·model·finish·usage | abort·EOF·lease·TTL·relay receipt를 원격 종료 증인으로 승격하지 않음 |
| `routing` | GPU/M1 backend, 주 처리 backend, 독립 감사 pair, 명시한 DeepSeek 예외/감사 한도·표본률 | 장비와 기반 모델을 구분하고 동기 DeepSeek 병목을 만들지 않음 |
| `m1Ingress` | worker 컨테이너에서 인증 사설 relay 접근, 실제 canary, 화면·텍스트 혼합 처리·물리 한 슬롯의 산출물 | renderer 접근·SSH loopback 시험·설치물 존재를 M1 분산 도입 완료로 세지 않음 |
| `comparison` | 실제 holdout snapshot, 모델 전에 고정한 사람 독립 라벨, case별 source/input/prompt/schema/policy, backend별 wire/response hash·소요 시간, 측정·수용 기준 artifact | 모델만 바꾸는 비교의 입력이 달라지는 문제와 합성 자료의 운영 정확도 승계 방지 |
| `policyApproval` | 정확한 통합 SHA·capacity policy hash·평가 dataset hash·범위와 승인 기록 artifact | shadow 허가나 다른 정책의 검토를 confirm 승인으로 합치지 않음 |

`expectedCallerIds`는 이 도구가 소스 코드에서 자동 추론하지 않는다. 실제 활성 설정·모든 caller와 gateway alias를 독립적으로 조사한 산출물에서 가져오며, 관측 목록과 정확히 맞춰야 한다. 미확인 입구는 목록에서 지워 통과시키지 않고 blocker로 남긴다. 도구가 증거의 진위를 확인하지 못한다는 한계도 최종 검토에 포함한다.

`comparison`은 같은 case의 source/input/prompt/schema/policy가 backend마다 일치하고 응답이 모두 있어야 통과한다. wire hash는 실제 backend의 thinking·model 필드를 포함하므로 backend마다 달라도 되며 반드시 보존한다. 실제 오내림·잘못된 URL·메이커 침범·근거 없는 사실 추가는 각각 실패로 드러내고 해결·보류 근거를 첨부한다. 한두 표본의 무오류를 운영 오류율 0으로 보고하지 않는다. 뉴스의 가격 분모·preview·연기·미재현·공개 범위는 별도 사실 검증과 사람 검토 대상이며 초안 저장이 게시 승인으로 바뀌지 않는다.

## GPU와 M1 단계

GPU 전용 전환은 M1 설치를 기다리지 않는다. `gpuShadowEligible`와 `gpuConfirmEligible`를 먼저 확인한다. 아직 활성 caller가 아닌 계획상 M1 계약의 증거 누락은 GPU 전용 경로를 막지 않는다. 다만 실제 활성 M1 caller가 있으면 전역 capacity inventory에 반드시 포함한다.

`primaryBackendIds`에 선택한 모든 backend는 계약·readback·caller 등록·native canary·실제 비교 자료의 대상이다. 계획상 backend를 선택한 primary로 적어 증거 검증을 생략할 수 없다. M1을 primary로 선택하면 `target:"gpu_m1"`로 검토하고 실제 M1 ingress 근거를 요구한다.

GPU+M1 단계는 `target:"gpu_m1"`로 평가하고 `gpuM1ShadowEligible`·`gpuM1ConfirmEligible`를 별도로 확인한다. M1은 사설 인증 ingress, worker 접근, 모델 canary와 화면·텍스트 공유 물리 1슬롯을 검증해야 한다. 로컬 가짜 두 HTTP 서버에서 GPU가 먼저 완료됐다는 회귀는 실제 M1의 지연·부하 측정을 대신하지 않는다. 실제 관측 전에는 분산 상시 도입 완료로 보고하지 않는다.

GPU Qwen과 M1 Qwen은 같은 기반 family다. backend·물리 자원·quantization이 달라도 독립 감사 두 표로 세지 않는다. 새 주 처리 경로는 Qwen이며 GPTOSS를 자동 결정의 기본 모델로 선택하지 않는다. Qwen 결정의 이기종 감사에는 검증된 다른 family를 사용한다. 원 family가 unknown이면 추측해 채우지 않는다.

DeepSeek는 충분한 근거에서 의미가 충돌하는 예외와 제한된 독립 감사만 소비한다. 용량 대기·transport·invalid JSON·빈 근거를 일괄 전송하지 않는다. 예외 주간 한도·감사 주간 한도·표본률이 모두 명시된 설정이 없으면 off다. 문서의 10%·5%·14.5% 계산 예시는 기본 활성값이 아니다. 비활성 예외 backend의 증거 누락은 `deepseekEligibleForReview`와 별도 blocker로 남기며 GPU 주 처리 검토를 막지 않는다. 실제 활성 caller이면 전역 inventory·계약 검증을 모두 충족해야 한다. GPU/M1 drain은 병렬이며 GPU 정상 완료를 M1·DeepSeek 응답 뒤로 직렬화하지 않는다.

## 승인받을 구체적인 운영 순서

1. 모든 코드 PR을 검토하고 정확한 통합 SHA의 전체 검사·필수 CI·migration journal·중단 호환성을 고정한다. 글로벌 caller·alias inventory와 실제 server C·물리 한도·native 종료 계약을 대조한다. 전역 `open` 전환은 미연결 caller를 멈출 수 있으므로 별도 항목으로 검토한다.
2. 필요한 migration, M1 사설 ingress 설치, 배포 대상·순서·현재/목표 SHA·image digest·복구 스냅샷을 구체화한다. [독립 워커 runbook](independent-workers-runbook.md)의 기본 순차 절차를 사용한다. 새 잡은 git 빌드 scheduler를 먼저 배포해 등록을 확인한 뒤 공통 이미지 8앱, 필요한 git 빌드 소비자 순으로 진행한다. 각 역할 쌍은 mini 예비→M3 주이며 전체 16앱/21컨테이너와 공통 이미지 8앱을 혼동하지 않는다.
3. 위 실행 계획이 검토된 후 기존 승인 절차에서 설치·migration·배포를 실행한다. 새 경로는 off로 배포하고 역할 owner·예비·scheduler·작업 등록·DB 풀/host 예산·모니터 관측을 확인한다. 병합만으로 스위치를 켜지 않는다.
4. 승인된 제한 shadow에서 후보·실제 근거·모델 결과·기권·추가 수집·예외·사람 큐·대기·성공·p95를 분리 측정한다. shadow 후보 생산은 기존 내림이 LLM으로 보호됐다는 의미가 아니다. 설정 동시 6이나 짧은 단건 중앙값을 처리용량으로 환산하지 않는다.
5. 사람 독립 라벨·업무별 실패 사례·수용 기준을 검토하고 승인한 정확한 정책으로만 confirm/apply를 연다. 새 정상 제품의 오내림, URL 변경, 소개 사실 추가와 메이커 보호를 먼저 확인한다. 실패 횟수·시간 예산·401/403/429/999 제외·광역 실패 보류·일일 저장소 내림 100건·관리자 해제 보호를 완화하지 않는다.
6. 작은 과거 적체를 명시적으로 산출해 범위·입력 revision을 고정한 뒤 별도 처리한다. 소개 needs_editor는 기존 성공 Sonnet 행·attempts를 초기화하지 않고 명시 요청으로만 재진입시킨다. 뉴스 초안 backend는 기본 off와 공개 노출 보류를 유지한다. 현재 정상으로 관측된 12건 복구를 이 단계에 자동 포함하지 않는다.

최초 uptime shadow는 기존 정책의 내림과 같은 TX에 남긴 감사·제품 revision에 묶어, 이미 내려진 후보의 모델 결과를 기록한다. shadow의 retain 결과도 제품을 복구하지 않으며 어느 결과도 confirm 적용 권한이 없다. 관리자 해제나 제품·관측 변경 뒤에는 그 후보를 보내지 않는다. confirmation latch를 연 뒤의 shadow는 기존 gate를 유지하며 최초 legacy 내림의 예외를 재사용하지 않는다.

## 중단·drain·되돌림

적용을 먼저 중지하고 새 dispatch를 중지한 뒤 소비자와 원 업무의 제어 상태를 확인한다. 원격 실행 중인 요청은 기존 native 종료·정산 경로로 drain하고 결과·후보·근거를 보존한다. 소비자 pause와 원 업무 pause는 새 queued claim/dispatch를 멈춰야 하며 이미 실행한 모델을 원격 종료한 것으로 표시하지 않는다. legacy/versioned/draining별로 지원하는 기존 제어를 사용하고, versioned에서 거절되는 legacy UI pause를 성공으로 표시하지 않는다.

confirm 이후 `confirmation_required`는 유지된다. mode off, dispatch/apply 중단, 모델 오류, 재배포는 pending을 기존 즉시 내림으로 돌려보내는 방법이 아니다. 원 관측 수집이 계속 후보를 보존할 수 있으며, 생산 자체를 멈춰야 하면 원 업무를 명시적으로 중지하고 관측 중단의 영향을 따로 기록한다. 확인 gate를 모르는 구형 코드로 돌아가야 한다면 uptime 자동 내림 경로를 먼저 실제로 멈추고 in-flight 작업을 drain한 다음 별도의 호환 복구 계획을 수행한다.

`indeterminate`는 시간이 지났거나 lease가 바뀌었다는 이유로 해제하지 않는다. relay의 `response_complete` receipt도 자체적으로 공통 native terminal 권한이 아니다. 실제 정산 증거 또는 별도 검토된 회수 계획 전까지 점유·후보를 보존한다. M1 receipt 저장은 upstream 시작 전 active/receipt와 디렉터리 동기화를 수행하고, 정상 종료 기록 후 active 삭제도 동기화한다. 코드 검토와 프로세스 재시작 회귀는 실제 power-loss 시험 통과를 뜻하지 않는다.

중단으로 기존 결과를 자동 복구하거나 차단을 해제하지 않는다. 이미 바뀐 제품은 원문·원 URL·결정 당시 근거·감사 ID로 사람이 검토한다. 실제 배포·중단·재개·복구 결과는 계획과 분리한 후속 기록으로 남긴다.

## 이 도구의 범위 검증

strict manifest·미연결 caller/alias·원격 종료 불명·정확한 SHA·독립 라벨·입력 불일치·GPU/M1 단계·같은 family·비활성 예외 backend·CLI plan/schema와 덮어쓰기 거절의 단위 회귀 13건을 실행했다. 변경 파일 ESLint, Next typegen 후 TypeScript 검사도 실행했다. 이 범위 검증은 전체 제품의 unit/DB/build나 실제 운영 증거 수집이 아니다. 최종 통합 담당자가 그 실행 결과를 별도로 연결한다.

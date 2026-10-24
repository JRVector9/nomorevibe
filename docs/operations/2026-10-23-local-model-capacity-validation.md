# 직접 로컬 모델 공통 슬롯 검증

PR-02 개발 기록. 운영 DB·서버·모델 설정·배포·global control은 바꾸지 않았다.

## 연결한 입구

`withLocalModelCapacity`를 다음 실제 작업의 `request` 경계에 연결했다. 업무 모델 이름은 보존하고 장부 transport provider는 `local-direct`로 구분한다.

| 작업 | 고정 route | 도메인 증명 |
|---|---|---|
| 공개 제품 Qwen 감사 | `local-audit` | 발행 원본, 제품/감사 항목/현재 campaign reviewer |
| 감사 두 번째 의견 | `local-second-opinion` | 열린 거절, 사람 결정 없음, 단계 스위치 |
| 공개분 사람 확인 거르기 | `local-published-filter` | 실제 second review와 발행 후보 |
| 화면 심사 | `local-screen` | 열린 감사 항목과 원본; 새 화면 글 외 필드 일치 |
| 보류 Qwen | `local-held-qwen` | running delegated attempt, actor/정책/현재 사유 |
| 사람 검토 DeepSeek | `local-human-deepseek` | running delegated attempt, 현재 generation actor |
| 갈림 Qwen | `local-qwen-tiebreak` | 현재 실제 관문/1차 판단/세대와 running 판가름 |
| 갈림 DeepSeek 확인 | `local-deepseek-confirm` | 같은 실제 관문과 Qwen 거절 후 running 확인 |

예약은 호출 권한이 아니다. dispatch TX에서 DR fence → model control → 예약 → 단계/원본/실제 업무 행 → job/role lease를 잠그고 다시 검증한다. audit 제품과 항목은 기존 writer와 같은 제품 → 항목 순서를 쓴다. candidate/split의 목적·attempt·모델 변경과 AI1/AI2 재진입, 동일 감사의 CLI 전환은 원래 활성 장부 행을 우회하지 못한다.

## 종료와 설정

`LOCAL_MODEL_SERVING_CONTRACTS`의 정확한 backend 계약, `LOCAL_MODEL_VERIFIED_CONTRACT_HASHES`의 backend별 readback 계약 hash, `LOCAL_MODEL_PHYSICAL_LIMITS`의 물리 group별 확인한 상한이 모두 있어야 open admission이 가능하다. 이 파일들은 실제 운영 readback을 대신하지 않는다. 확인한 같은 GPU의 direct/gateway alias를 하나의 group에 넣어야 하며 M1을 쓰는 모든 route의 group 한도는 1로 유지한다. 동시 6은 서비스 설정 상한이지 처리량 측정값이 아니다.

실제 전송 wire와 model/deployment revision을 binding에 묶고 전체 서버 context C를 보수적으로 charge한다. 완료된 native HTTP envelope의 정확한 응답 모델과 finish reason을 adapter가 확인해야 불투명 terminal을 발급한다. 응답 전체 hash도 기록한다. 업무 JSON이 잘못되어도 이 물리 종료는 정산하고 업무 판정은 거절한다. native 종료가 없는 200 JSON은 정산하지 않는다. usage가 없거나 불완전하면 0으로 만들지 않고 null/unknown으로 남긴다.

abort·반쪽 HTTP·socket 종료·로컬 localEnd·lease 만료는 원격 종료가 아니다. 기존 indeterminate/DR 회수 경로에 연결하고, provider 종료 계약/증거가 없는 회수는 거절한다. response-only backend의 unknown을 client-bound라고 선언해 풀어서는 안 된다. PR03 relay HTTP receipt도 단독 native terminal 권한이 없다. 독립적인 원격 hard deadline/readback이 없으면 unknown 점유가 오래 남을 수 있다.

disabled는 기존 8개 업무의 원래 wire를 보존한다. 새 assist는 `allowLegacy:false`로 무계량 fallback을 막아야 한다. draining은 새 호출을 defer한다. 미발급/미검증 admission은 endpoint/product 실패와 구분하고 기존 항목 시도 3회를 소진하지 않는다.

`localModelCapacityReadiness`는 부분 진단이며 **globalReady=false**다. 전체 활성 caller 배포 inventory, 실제 gateway의 물리 alias inventory, 기존 gateway/CLI 계약 readback이 미확인이다. route별 계약 통과를 전체 물리 cap 또는 운영 open 준비 완료로 해석하지 않는다. 이 PR은 global open을 전환하지 않는다.

## 실행한 검증

Node 24.22.1, 전용 PostgreSQL 17/pgvector 0.8.6 컨테이너 `nmv-llm-pr02-pg-20261023`, loopback port 55570을 사용했다. 다른 테스트 DB와 운영 DB에는 쓰지 않았다. 최종 0118을 포함한 journal 119개를 빈 DB에 적용했다.

- 신규 실제 DB/HTTP 7개: 발행 원본/lease dispatch, native 종료와 잘못된 업무 JSON 분리, terminal 위조 거절, source/job 변경 거절, generic dispatch 거절, 별도 reviewer/text 프로세스와 gateway alias의 동일 물리 cap1, 목적/모델/attempt/AI1/CLI 전환 fence, 원격 생성 중 abort, 반쪽 HTTP, 정책 변경 및 근거 없는 DR 회수 거절. 같은 테스트 안의 SQL negative 검사는 잘못된 backend binding과 event epoch를 거절한다.
- 최종 fence 변경 뒤 신규 7개 + 기존 CLI ledger 8개 + gateway terminal 8개 = **23/23 통과**.
- 앞선 최종 DDL 묶음에서 신규 5개 + 기존 Qwen auto 23개 + CLI 8개 + 번역 ledger 4개 + gateway terminal 8개 = **48/48 통과**. 추가 fence 변경의 직접 영향은 위 23개에서 재검증했다.
- 최종 관련 단위 **11개 파일 103/103 통과**. 변경 범위 TypeScript와 ESLint 통과. 전체 suite/build는 AGENTS 정책에 따라 최종 통합 단계에 남겼다.

여기서 자식 프로세스 경합은 실제 PostgreSQL 예약 경쟁이며 실제 모델 throughput 실험이 아니다. fake 원격 엔진을 종료한 뒤 테스트 장부를 지우는 teardown SQL은 운영 회수 근거가 아니다. 기존 target 전부의 실제 production 설정이나 M1 relay ingress/readback은 확인하지 않았다.

## 첫 실패와 수정

첫 DB 테스트의 fixture가 `reviewWithQwenDirect`를 잘못된 3인자 서명으로 호출하여 opts가 무시됐고 기본 실제 Qwen endpoint에 합성 입력 3회를 전송했다. 운영 DB·설정 변경은 없었으며 이 실행은 성공 검증에서 제외했다. 이후 실제 2인자 opts에 fixture env/request를 전달하고 global fetch, native `gatewayFetch`, 모델 request 경계에서 fixture URL 이외 전송을 거절하도록 바꿨다. 성공 검증은 loopback HTTP path·wire model·thinking·응답 hash까지 확인한다.

## 중단과 되돌림

신규 admission을 draining하고 dispatched/indeterminate는 정산 근거가 생길 때까지 보존한다. 완전 drain 전 disabled/옛 무계량 경로로 돌아가지 않는다. migration은 기존 CLI/gateway CHECK를 보존하는 추가 분기이며 장부를 삭제하거나 기존 증거를 변환하지 않는다.

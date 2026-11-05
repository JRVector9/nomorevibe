# 검수 업무 분산: PR2

## 범위

1차 검수는 기존 `reviewConcurrency` lane/refill과 현재 claim/dispatch 장부를 사용한다. 새 workload pool 모드에서만 새 후보 하나에 실제 사용 가능한 구성원 하나를 고른다. 기존 fallback 순위 모드의 고르기는 유지한다. 새로운 모델별 동시성 제한이나 추가 표를 만들지 않는다.

2차는 **단일 투표자 구성에서 서로 다른 후보를 분산**한다. `second-review` slot1의 최대4 구성원은 한 표를 맡을 대안이다. 같은 후보에 네 모델의 표를 추가하는 앙상블이 아니다. 기존 fallback 최대3 투표자 칸은 기존 실행을 유지한다. pool slot2/3는 지원하지 않는다. PR1의 양방향 저장 검증이 pool slot1과 기존 slot2/3 행의 공존을 막으며, 두 저장 경로는 동일 task advisory lock 아래에서 최종 재확인한다. 자동으로 설정을 지우지 않는다.

## 실제 실행 경계

- AI1: 새 후보에만 `chooseTaskWorkloadMember` 힌트를 적용한다. 살아 있는 waiting/reserved/dispatched 및 live attempt는 기존 identity에 묶는다. 고른 하나의 기존 claim→용량 요청→원자 dispatch→terminal 정산→도메인 기록 경로를 사용한다.
- AI2: 기존 candidate/domain 잠금 TX에서 새 표를 만들 때 구성원 하나를 고르고, 그 표와 `second_review_workload_assignments`를 같은 TX에 넣는다. 표의 provider/model/generation/vote 구조와 기존 logical work key는 바꾸지 않는다. association은 slot/revision/member/raw canonical metadata 스냅샷이며 입장권이나 추가 표가 아니다. live member FK나 기존 표 backfill은 없다.
- AI2 소비자는 저장된 표의 provider/model만 실행한다. 기존의 원본·1차 판단·세대·소유권 검증 후 고정 reservation intent, 용량 요청, 원자 item+dispatch, 실제 transport, terminal 정산, 결과 기록을 그대로 통과한다.
- 선택기는 용량 점유를 부여하지 않는다. 실제 물리 장비/group/helper 및 전역 정책 제한은 기존 `requestSlot`/claim TX만 부여한다.
- 용량 요청은 waiting/fence를 남길 수 있다. 요청 시도 뒤 같은 입력을 다른 pool 구성원으로 재시도하지 않는다. 다른 후보는 다른 사용 가능한 구성원으로 계속 진행할 수 있다.

## 기존 표와 발행 조건

pool 모드 전환만으로 association 없는 기존 slot1 primary/fallback 표를 재배정하지 않는다. 기존 행의 정확한 provider/model/endpoint 연결은 AI2 credential lookup에서 보존하고, claim은 실제 기존 표와 domain을 다시 검증한다. 이 lookup은 신규 enqueue 후보 목록이 아니다. 신규 표는 pool 구성원만 선택한다.

구성원을 삭제하거나 동일 구성원 ID의 연결/모델을 바꾸는 경우는 다르다. 현재 구성원과 더 이상 일치하지 않는 association 표는 기존의 `model_removed`/재검수 경로를 따른다. 이전 표의 스냅샷·dispatch binding·이력은 덮어쓰지 않는다.

pool 발행 관문은 한 slot의 현재 유효 root 또는 허용된 legacy fallback child의 승인 표 하나를 요구한다. root와 child의 후보·1차 판단·trigger·generation·input이 같아야 하고, fallback root는 실제 `resolved/fallback`이어야 한다. 1차와 독립된 실제 승인 표여야 하며 같은 1차 판단에 pending/failed/needs_human이 하나라도 있으면 공개하지 않는다. 반대·보류·입력 갱신·기존 발행 guard는 완화하지 않는다.

새 pool 표의 모델 독립성 비교는 저장 당시 실제 canonical metadata와 기존 serving contract의 관측 `responseModel`을 사용한다. `supa`/`auto` 같은 불명확한 별칭만으로는 새로운 독립 표를 추정하지 않는다. 이 추가 조건을 association 없는 기존 fallback 표에 소급 적용하지 않는다.

OpenCode catalog에는 weights 지문이 없다. 관측된 DeepSeek Flash/Pro의 provider/tier 별칭을 서로 독립적인 추가 표로 허용하지 않는 보수적 veto를 적용한다. 이는 동일 weights가 검증되었다는 뜻이 아니며, 실제 provider/model 및 canonical 스냅샷은 변경하지 않는다.

## 소비자 동시 업무와 관측

`jobs.second-review.consumerConcurrency`는 기존 runtime settings의 job knob다. 범위1~4, 기본1이며 AI2 **진행 lifecycle 수**만 제한한다. pool 구성원 수·투표자 칸·물리 슬롯 제한과 별개다. 기존 모델 한도 화면에서 설정할 수 있고 소비자는 다음 pass에 읽는다. 이 PR은 운영 값을 변경하지 않는다.

소비자는 root/fallback/priority hint를 같은 logical vote로 중복 제거한다. fatal/global defer 이후 새 claim을 중지하고 이미 시작한 lifecycle의 종료/정산을 모두 기다린다. 하나라도 진행 중이면 가장 오래된 실제 시작 시각을 running으로 보고하며 모두 끝난 뒤 idle을 보고한다.

기존 `pipeline_consumer.page`에 다음 pass 범위 관측을 남긴다.

| 필드 | 실제 의미 |
| --- | --- |
| pendingHints | 해당 bounded keyset page의 pending 표 수 |
| uniqueCandidateHints | 그 page의 서로 다른 후보 수 |
| scheduledVotes | priority/root/fallback 중복 제거 후 방문한 logical vote 수 |
| validatedInputHints | 기존 고정 도메인 admission에서 현재 입력이 유효하다고 관측된 표 hint 수 |
| inputReadyCandidateHints | 위 유효 입력 표가 속한 서로 다른 후보 수 |
| lifecycleLimit / lifecyclePeak | 설정된 lifecycle 상한 / 실제 진행 lifecycle의 최대 수 |

이 값들은 전체 ready backlog 수, 용량 grant 수, 실제 호출 수로 표시하면 안 된다. 실제 호출·완료는 기존 dispatch/terminal/기록 이벤트를 사용한다. AI1의 선택 로그는 `ai_task.workload_hint_selected`이며 선택 metadata만 남기고 키는 남기지 않는다.

## 검증 및 적용 상태

사용자 지시에 따라 수동 테스트·새 테스트·모델 호출·운영 설정 변경·DB 이전·배포를 실행하지 않았다. 필수 GitHub CI는 유지한다. 이 PR은 Draft로 검토하며 운영 활성화와 실제 처리량 검증은 사용자의 운영 테스트 이후 별도 진행한다.

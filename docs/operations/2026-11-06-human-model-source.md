# 사람 확인 AI 위임 모델 — 단일 출처 (2026-11-06)

## 정본 화면

- `/admin/models/human`이 사람 확인·AI 위임 모델의 정본 화면이다.
- `/admin/flow`의 `HumanModelSettings`는 정본 화면의 `#human-review`로 가는 링크만 둔다. 자체 DB 조회·`GET /models` 호출·중복 전체 폼은 없다.
- 기존 단계 모델 풀 화면과 배정 표 화면의 저장 경로·CAS·권한은 바꾸지 않는다.

## 실행 출처 우선순위

1. 배정 표(`assignments.tableReads`가 켜지고 표를 읽었으며, `human` 단계의 role `primary`·mode `live` 행 중 등록부 provider·wire 모델이 실행 단계와 맞는 행)
   - 런타임은 가장 낮은 rank의 행만 고른다. 같은 rank가 여럿이면 기존 hash 칸이 하나를 고른다.
2. 위 조건을 통과한 행이 없으면 저장된 `stageModelPools['human-review']`의 유효 키
3. 그것도 없으면 등록부 `modelForPurpose('human-review')` 기본값

배정 표 플래그가 켜졌다는 사실만으로 표를 출처라고 표시하지 않는다. 표를 읽지 못한 경우(unread)는 비었다고 해석하지 않고 `unknown`으로 닫아 저장을 막는다. 런타임은 유효한 human 배정 표 override가 있을 때만 사용하지 않는 human 풀을 무시하며, 다른 풀의 유효성 검사는 유지한다.

## 연결 확인

- 화면과 준비 판정은 실제 추론을 보내지 않는다. 실행과 같은 범위 해석기 `withAdminStagePools`로 좁힌 뒤 `GET /models` 메타데이터만 확인한다. 이 API 응답은 추론 결과가 아니다.
- 이 확인은 실행 중 상태나 추론 성공을 뜻하지 않는다.
- 출처를 읽지 못했거나 패널이 읽기 전용이면 추가 `GET /models` 확인을 보내지 않는다.

## 정본 편집기 저장

- 정본 편집기는 고정된 exact metadata target을 쓴다.
- action은 트랜잭션 밖에서 target을 probe하고, writer는 bounded lock 아래에서 source fingerprint와 rowversion을 다시 확인한다.
- 배정 표가 실제 출처가 되려면 항상 proof가 필요하다.
- pool/default 저장은 generation과 pool stale CAS를 유지한다.
- OFF 전환에는 source/metadata gate를 적용하지 않는다.

## 사람 확인 스위치

- 기존 `setHumanReview` 쓰기 동작, `webWriteAction`, 입력 검사, CAS(generation, model pool keys), 서버 필수 가드를 그대로 둔다.
- 활성화 준비 판정만 실제 유효 선택(배정 표 → 풀 → 기본값)을 쓴다. 출처가 unknown이면 준비됨으로 보지 않는다.
- 성공 뒤 클라이언트의 별도 새로고침은 없다. 기존 guarded action이 현재 human 화면과 Flow를 재검증하고, Next 16.4는 같은 action에서 갱신된 RSC를 돌려준다.
- OFF는 미리보기 밖이면 준비되지 않았어도 가능하다. 화면은 `readOnly || pending || (!enabled && !ready)`로 비활성화하고, toggle은 읽기 전용이면 즉시 반환한다.
- `변경은 다음 작업부터 반영` — 현재 진행 중인 호출을 즉시 재시작하지 않는다.

## 바꾸지 않는 것

- `ai_task_models`의 사람 검수 순위는 이 화면과 런타임에서 읽지 않는다. 마이그레이션하지 않는다.
- 판정·lease·재시도 동작은 바뀌지 않는다.
- 사람의 승인·반려 권한, 자동 승인 금지 조건, 공개 제품 동작은 바뀌지 않는다.
- CLI·새 쓰기 동작·새 모델 활성화 기능을 추가하지 않는다.

## 검증

- 사용자 수동 기능 테스트는 아직 실행하지 않았다. 완료된 검증으로 기록하지 않는다.

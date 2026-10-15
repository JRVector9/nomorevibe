# 연속 접속 실패 자동 내림 운영 관측

## 구현과 검증 — 2026-10-15 10:21 KST

정상 `uptime-ping` 작업이 기존 최근 적체와 새 10번째 실패를 같은 batch/budget 안에서 처리한다.
차단 전 lifecycle 잠금 아래 제품 ID/slug/현재 URL/public website와 관측을 다시 검사한다.
`setStatusWithAudit`의 상태 변경·제품 감사와 append-only 운영 감사·기존 CDN trigger는 같은 트랜잭션이다.
운영 감사가 실패하거나 lease를 잃으면 차단과 purge 등록도 롤백된다. 이미 내린 제품은 기록을 중복 생성하지 않는다.

관리자 `/admin/activity?group=takedown`의 ‘접속 실패 자동 내림’, 제품별 기록과 감사에서 확인할 수 있다.
운영 기록에는 actor `system:uptime`, 기준10회, 실제 횟수, 마지막 응답, 확인/실패 시작 시각,
제품 ID/slug/URL/이전 상태를 남긴다. 처리 시각은 감사 행의 `created_at`이다.
제품을 나중에 삭제해도 append-only 운영 감사의 snapshot은 남는다.

URL이 바뀌면 현재 연속 실패를 무효화하고 과거 일별 지표는 보존한다. 옛 URL의 늦은 응답·본문,
취소된 요청이나 잠금 대기 중 취소된 관측은 새 제품에 저장하지 않는다.
기존 health에는 URL 이력이 없어 실패 시작 이후 제품 수정은 귀속 불명으로 취급한다.
이 경우 다음 실패부터1로 세며, 이름·소개 수정과 수동 차단 해제도 포함될 수 있다.
따라서 정상 주소에서도 과거 관측을 이어 잘못 내리는 경우를 막지만 내림까지 시간이 더 걸릴 수 있다.

실제 검증 결과:

- 담당 agent: 관련 통합4파일60개(신규23개 포함)와 설정 단위7개 통과.
- root: 최종 관련 통합5파일99개, 전체 단위260파일2,529개, TypeScript/ESLint/i18n/build/bundle3routes/Python23개 통과.
- 독립 리뷰: 지적한 URL/취소/기록 표시 경계 반영 후 추가 P0/P1/P2 없음, 관리자 UI20개 직접 통과.
- 최초 root 전체 통합은145파일 통과/2파일 실패였다. 신규 테스트의 시계·Proxy spy2개와
  기존 source 테스트의 KST naive timestamp parse1개를 수정한 뒤 위99개를 같은 DB에서 실제 통과했다.
  최종 전체 CI·새 릴리스 배포·실제 자동 내림은 아직 확인 전이다.

## 배포 전 고정 기준 — 2026-10-15 10:08 KST

이 문서는 연속 접속 실패 10회 이상인 공개 웹사이트의 자동 `banned` 정책을 관측한다.
모델의 생성·심사 거절 횟수는 이 정책의 대상이 아니다.
아래 관측은 기존 운영 릴리스 `c8f04245e44cb60573cbc2f8685d2f6c4b6f0407`에서 수행했다.
**새 정책 배포 또는 자동 내림 성공을 뜻하지 않는다.**

DB 시각 `2026-10-15T01:08:15.594Z`에 `REPEATABLE READ, READ ONLY` 트랜잭션으로 기준을 고정했다.
`transaction_read_only=on`을 직접 확인했다. 운영 쓰기·모델 호출·설정 변경은 수행하지 않았다.

| 측정 | 실제 값 |
| --- | ---: |
| 공개 제품 (`seeded`, `verified`) | 44,015 |
| 공개 웹사이트 (`access_mode=website`) | 41,515 |
| 공개 웹사이트 중 연속 실패 10회 이상 | 535 |
| 그중 최근 6시간 health | 535 |
| 그중 6시간 초과 health | 0 |
| health 확인 이후 또는 같은 시각의 수동 unban | 0 |

09:19 KST 선행 집계의 534개와 별도로, 정상 uptime 처리 중 10:08의 실제 대상 **535개 제품 ID**를 고정했다.
이후의 공개 제품 수 증감만으로 이 정책의 처리 실적을 추정하지 않는다.
각 제품의 ID/slug/URL/status/access mode/생성·수정 시각, health 실패 수·응답 코드·확인·실패 시작 시각,
최근 차단 해제 시각과 당시 metadata를 비공개 원본에 보관했다.

기준 ID floor는 운영 감사 `12,222`, 제품 근거 감사 `5,817`, CDN purge `1,897`이다.
이 값은 행 수가 아니라 기준 시점의 최대 ID다. 새 정책은 기준 시점에 아직 배포되지 않았다.

당시 maintenance는 기존 릴리스의 primary, lease epoch `33`, 유효한 lease를 가지고 있었다.
`uptime-ping`은 runs `52,565`, 마지막 성공 `2026-10-15T01:07:52.272Z`, 오류 없음이었다.
신규 발굴 두 잡은 `not_before=2100-01-01`이며 runs가 GitHub `8,905`, Show HN `1,681`로 유지됐다.

비공개 디렉터리(권한 700):
`/Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/uptime-auto-ban`

- 고정 원본: `baseline-20261015T010815753392Z.json` (권한 600, 새 이름으로 생성하고 덮어쓰지 않음)
- 배포 전 재조회: `before-release-20261015T011038728168Z.json` (권한 600)
- 읽기 전용 관측기: `observe.py`, `observe-template.mjs` (권한 600)
- 관측기 로컬 합성 검증: `observer-offline-verification.json` (권한 600, 운영 실적과 별도)

## 같은 제품 ID의 배포 후 비교 방법

관측기는 위 고정 원본을 입력으로 받아 같은 535개 제품 ID를 다시 조회한다.
자동 정책으로 차단된 제품, 다른 사유 또는 근거 불명 차단, 회복·기준 미만,
제품 세대 교체·삭제·slug/URL/access mode 변경, 오래되거나 없는 health,
미래 관측, health 이후 제품 수정, 최근 수동 unban, 처리 대기를 구별한다.
`eligible_pending`은 조회 시점의 보수적 자료 조건이 맞는다는 뜻이며 정책이 이미 실행됐다는 뜻은 아니다.

새 운영 감사는 actor `system:uptime`, action `product-auto-ban-uptime`, policy/reason
`uptime_consecutive_failures`, threshold `10`으로 식별한다.
제품 근거 감사는 같은 actor/policy/reason과 `admin.product.ban`을 요구한다.
두 감사의 productId/slug/URL/previousStatus/status/threshold/실패 수/응답 코드/checkedAt/downSince 전체를 비교한다.
관측별 `(productId, url, checkedAt)` 중복, 감사 한쪽 누락, 형식 불일치와 미연결 행은 성공 집계와 분리한다.

CDN에는 policy나 product ID 외래키가 없다. 기존 `products_cdn_purge` 트리거 정의와
같은 slug·`reason=banned`·정확한 트랜잭션 `created_at`으로 감사와 연결한다.
같은 `xmin`은 아직 행이 수정되지 않았을 때만 추가 증거다.
발행 워커의 purge/confirm 갱신은 CDN 행의 `xmin`을 바꾸므로, 갱신 후 이를 불일치 오류로 간주하지 않는다.
CDN 등록, 실제 purge 완료, 재확인 완료와 오류를 각각 집계한다.

배포 전 관측기 실제 실행은 DB 시각 `2026-10-15T01:10:38.514Z`에 성공했다.
535개 모두 `eligible_pending`, 새 정책 운영 감사 0개, 새 정책 제품 근거 감사 0개,
정책 연결 CDN 행 0개였다. 실제 runtime은 여전히 기존 `c8f0424`였다.
관측기의 최초 실행에서 JSON 파라미터 직렬화 오류가 발생했으며 읽기 전용 트랜잭션은 롤백됐다.
`tx.json`을 사용한 수정 후 위 실제 재조회를 완료했다.
로컬 합성 자료로 14개 분류 경계, 고정 ID 535개 보존, 두 감사·CDN 연결과 중복 노출을 별도로 검증했다.
이 로컬 검증에는 운영 호출·쓰기가 없다.

배포 신호 전 그대로 다시 실행할 명령:

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/uptime-auto-ban/observe.py --baseline /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/uptime-auto-ban/baseline-20261015T010815753392Z.json --phase before-release --app maintenance-m3
```

배포 담당자가 maintenance의 실제 새 릴리스 적용을 확인한 뒤에는 아래 `DEPLOYED_SHA`에
그 전체 40자 SHA를 넣어 실행한다. 실행 결과는 항상 새 시각의 비공개 파일로 생성된다.
runtime SHA 불일치, 오래된 lease, 실행 대기 또는 부분 처리 결과를 완료로 보고하지 않는다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/uptime-auto-ban/observe.py --baseline /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/uptime-auto-ban/baseline-20261015T010815753392Z.json --phase after-release --app maintenance-m3 --expected-sha "$DEPLOYED_SHA"
```

## 고정 원본의 시각·상태 정합성 검토 — 10:12 KST

추가 운영 호출 없이 위 두 비공개 원본을 로컬에서 비교했다.
535개 중 `product.updatedAt > health.checkedAt`은 0개, `createdAt > checkedAt`은 0개였다.
미래 checkedAt, checkedAt 이후의 downSince, 마지막 2xx/3xx 상태, downSince 누락도 각각 0개였다.
01:08:15.594–01:10:38.514 UTC 사이 고정 535개의 slug/URL/status/access mode,
생성·수정 시각, 실패 수·상태 코드·확인·실패 시작 시각과 최근 unban 시각의 변화는 모두 0개였다.
로컬 근거는 비공개 `local-baseline-review-20261015T011257710083Z.json`에 보관했다.

기존 `product_health`에는 관측 URL 필드가 없다.
따라서 이 시각 정합성만으로 과거 URL 변경 뒤 기존 코드의 ping이 이전 URL 실패 수를 승계하지 않았다고 증명할 수 없다.
위 `eligible_pending` 분류 역시 과거 URL 귀속을 증명하는 분류가 아니다.
배포 신호가 올 때까지 추가 운영 조회는 대기한다.

## 연속 실패 시작 이전 URL 귀속 경계 — 10:13 KST

같은 고정 535개 원본만 로컬에서 다시 집계했다(운영 추가 호출 0회).
`product.updatedAt > health.downSince`인 제품은 **16개**이며 모두 `seeded`였다.
나머지 519개는 `updatedAt <= downSince`이고 downSince 누락은 없었다.
영향 16개의 마지막 health 상태는 404 5개, 연결 실패(0) 3개, 403 1개, 400 2개,
503 3개, 429 1개, 401 1개였다.
이 16개도 모두 `updatedAt <= checkedAt`이므로 최근 확인 시각만의 비교에는 걸리지 않는다.

이는 이전 URL의 실패 시작 이후 제품이 수정되고 기존 코드에서 다시 확인된 경계와 양립한다.
다만 `updatedAt`은 URL 외 수정에도 바뀌므로, 실제 과거 URL 변경 16건으로 단정하지 않는다.
귀속이 불분명할 수 있는 기존 연속 실패 16개와 나머지 519개를 구별해야 한다.
위 배포 전 `eligible_pending=535`는 downSince 경계를 추가하기 전 관측기 조건에 따른 값이다.
로컬 근거는 비공개 `local-streak-attribution-review-20261015T011348857525Z.json`에 보관했다.

## 확정된 downSince 경계와 관측기 정렬 — 10:14 KST

확정 정책은 기존 조건에 `products.updatedAt <= health.downSince`를 추가한다.
제품 수정 시각이 연속 실패 시작보다 늦으면 `uncertain_streak_attribution`으로 분리한다.
새 코드의 expected-URL 접속 확인에서 이런 기존 불명확 연속 실패는 새 관측부터 1회로 시작하며,
과거 일별 health 통계는 보존한다. URL 외 수정·수동 차단 해제에도 같은 보수적 경계를 적용한다.
이는 구현 정책의 설명이며 운영에서 리셋 또는 차단이 일어났다는 주장이 아니다.

비공개 관측기의 분류를 이 조건에 맞췄다.
운영 추가 호출 없이 저장된 01:10:38.514 UTC 관측 원본을 최종 관측기로 다시 분류한 결과는
**`eligible_pending=519`, `uncertain_streak_attribution=16`**, 합계 535개다.
수정 시각이 downSince와 정확히 같으면 허용하고 1밀리초 뒤면 불명확으로 분류하는 경계도 로컬에서 확인했다.
기존 535개 고정 원본과 세 ID floor는 보존했으며 원본의 SHA-256이 수정 전후 같음을 확인했다.
최종 로컬 근거는 비공개 `local-final-policy-replay-20261015T011448187719Z.json`이다.

관측기 업데이트와 로컬 재분류에는 운영 조회·쓰기·모델 호출이 없다.
새 정책 감사·CDN 행은 저장된 배포 전 관측상 여전히 0개이며 배포 완료 실적으로 해석하지 않는다.
이제 실제 새 maintenance 배포 신호를 기다린다. 이후 실행 명령과 고정 원본 경로는 위와 같다.

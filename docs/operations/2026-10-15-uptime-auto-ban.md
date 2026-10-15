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
  10:21 당시 최종 전체 CI·새 릴리스 배포·실제 자동 내림은 아직 확인 전이었다.
  이후 실제 결과는 아래 시각별 후속 관측을 따른다.

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


## 정상 병합·배포 준비 — 10:33 KST

[PR422](https://github.com/JRVector9/nomorevibe/pull/422)의 HEAD `ac088b4`에서
전체 quality·통합3개 묶음·필수 check가 성공했다. 최신 base c8f0424에서 정상 squash 병합했다.
main `94b025ef0083190cf8bb24d87b2484edd4cc93cc`의
[CI38665835062](https://github.com/JRVector9/nomorevibe/actions/runs/38665835062)도
quality·통합3개 묶음·필수 check가 실제 성공했다. 웹·워커 이미지는 아직 생성 중이다.
이 시각 운영은 c8f0424이며 자동 내림 실행 전이다.

새 릴리스 전용 helper와 13앱·18컨테이너의 기존 c8 설정 기준선을 별도로 보관했다.
운영 환경·모델·복제본·신규 발굴 중단을 유지하며 역할별 mini 예비→M3 주 순서로 배포한다.
이번 기능은 DDL이 없으며 기존 schema journal77을 읽기 전용으로 확인한다.

## 전체 자동 적체의 별도 점검 — 10:28–10:32 KST

자동 내림 고정 535개와 전체 자동 적체는 다른 집계다. 별도 에이전트가 기존 private helper의
읽기 전용 조회와 최근10분 다섯 역할의 bounded Docker logs를 실제 실행했다.
운영 쓰기·모델 호출·재접수·카운터 초기화는 없었다. 기준 원본도 덮어쓰지 않았다.
운영 릴리스는 c8f0424였다.

- 다섯 역할은 모두 present/전체 progress ok, jobs.last_error 없음.
  최근10분 job.failed0, 근거·저장소 스캔·공개 재검수·소개·텍스트 작업의 완료를 확인했다.
  이 로그 표본에는 scheduler를 포함하지 않았다.
- 근거 출처 due49,486, 최근1시간 저장1,889. 최근5분 완료130/error6/deferred240이었다.
  item 오류·정책 유예는 잡 전체 실패와 구별한다.
- 공개 재검수 campaign4는 running/pausedNULL/stalledfalse였다.
  44,018개 중 판정387, 자동ready43,627, backoff0/terminal0/skipped4였다.
  최근5분 성공20/실패0. 현재 사람이 확인할 공개 재검수109개와 소개102개가 있었다.
- 검색 문구 생성 정상selector ready373, 검수ready7,817, 최근1시간 생성173/검수237.
  후속 source/eligible 집계에서는 selectable363/backoff7/품질상한100이었다.
  두 집계는 시각과 조건이 다르므로 서로 합산하지 않는다.
- 한국어 문구 정상selector ready2,441, 저장1시간144. gaveUp2,776개는 모두 품질 거절 상한이며
  기술·공급자 오류0이었다. 이 수를 사람 needs_editor2,776건으로 해석하지 않는다.
- 이유 번역 pending11,380, 저장1시간77. 실패3개는 각각1회 timeout 뒤 미래 backoff였다.
- 소개 자동due0/현재 공개·같은 소개의 needs_editor102. 후보 needs_review209에는 모델 분할181,
  spam9/ambiguous4/빈소개13/repo_deleted1/심사상한1이 포함됐다.
  저장소 소멸 open human35/delist후보36 등과 중복 가능하므로 사람 큐 총합으로 더하지 않는다.
- 썸네일 정상due3,243/기존재시도예정21,122/최근1시간 저장1,596,
  stars due189/시간 관측1,004. README 재수집 현재 표본0.
- 신규 발굴 두 잡은2100 중단/runs8905·1681 유지. 당시 CDN pending0이었다.

자동 적체는 아직 남아 있다. 정상 처리와 기술적 실패, 품질 상한, 실제 사람 판단을 구분하며
기존 완료 cohort를 재실행하거나 품질 제한을 지워 완료로 만들지 않는다.

## 실제 새 릴리스 적용 후 관측 — 10:50–10:54 KST

배포 담당자가 maintenance mini→M3 순차 배포의 각 exit 0을 확인했다.
M3 적용 완료는 `2026-10-15T01:50:06.794Z`, 뒤따른 maintenance 원본 full gate의
`already_ready/readiness=ready/progress=ok` exit 0은 01:50:17 UTC였다.
실제 관측의 runtime과 maintenance role owner release는 모두
`94b025ef0083190cf8bb24d87b2484edd4cc93cc`와 일치했다.
Primary lease epoch는 `34`, 모든 관측 시점에 유효했다.

배포 담당자는 이어 전체 13앱 첫 릴리스 검증이 `01:51:28.225 UTC`에 exit 0으로 끝났다고 확인했다.
해당 전체 검증에는 source 5앱 각각 537파일 해시, 양쪽 공개 웹 health,
schema 77 및 소개 검수 not_before NULL 보존이 포함된다. HTML purge도 별도로 성공했다.
아래 제품별 상태·감사·CDN 결과는 이와 별도로 관측기가 운영 DB에서 직접 읽은 값이다.

| 실제 DB UTC 시각 | 고정 대상 중 정책 차단 | 처리 대기 | 귀속 불명 보호 | 정책 CDN 등록 | purge 완료 | 재확인 완료 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 01:50:38.270 | 0 | 519 | 16 | 0 | 0 | 0 |
| 01:51:45.190 | 300 | 219 | 16 | 300 | 45 | 0 |
| 01:53:06.650 | 450 | 69 | 16 | 450 | 45 | 45 |
| 01:54:19.990 | **519** | **0** | **16** | **519** | **90** | **45** |

초기 첫 관측에서 마지막 uptime 성공은 01:49:58 UTC로 새 코드 적용 전이었다.
이후 수동 접수 없이 정상 uptime 실행 4회가 진행됐고, 마지막 확인된 runs는 `52,611`,
lastSuccess는 `01:53:53.981 UTC`, 오류 없음이었다.
처음 처리 가능하던 **519개 ID 집합과 실제 정책으로 차단된 519개 ID 집합이 정확히 일치**했다.

최종 시점 새 정책 운영 감사 519개, 제품 근거 감사 519개, CDN 등록 519개를 각각 연결했다.
두 감사의 전체 정책 metadata와 `xmin`이 모두 일치했고, CDN은 정확한 slug·사유·트랜잭션 시각으로 연결됐다.
각 제품에 정책 운영 감사가 하나씩 있었으며 같은 관측의 중복, 한쪽 감사 누락,
불완전 metadata, 미연결 행, CDN 오류는 모두 0개였다. 관측기의 행 제한에도 걸리지 않았다.
따라서 차단과 감사·CDN 등록은 이 519개에서 실제 확인됐지만,
CDN **purge 미완료 429개, 재확인 미완료 474개**는 아직 완료로 표시하지 않는다.

처음 귀속 불명이던 **16개는 정확히 같은 ID 집합으로 남았고 모두 seeded**였다.
이 16개의 slug·URL·updatedAt·실패 수·checkedAt·downSince는 고정 원본과 같았다.
안전 경계 때문에 자동 차단하지 않았으며, 새 접속 확인에서 실패 수를 1회부터 시작하는 동작은
이 짧은 실제 관측 창에서는 아직 발생하지 않았다. 이 16개를 회복 또는 처리 완료로 세지 않는다.

최종 공개 제품 수 43,494개와 공개 웹사이트 수 40,994개는 참고 상태일 뿐,
다른 정상 작업의 변경이 섞이므로 정책 실적은 위 고정 ID·동일 정책 감사로 집계했다.
신규 GitHub/Show HN 발굴은 계속 2100년까지 중단됐고 runs `8,905`/`1,681`이 유지됐다.
모든 재조회는 read-only/repeatable read였으며, 관측자가 운영 쓰기·모델 호출·수동 job 재접수·설정 변경을 하지 않았다.

비공개 실제 관측 원본(각 권한 600):

- `after-release-20261015T015038443733Z.json`
- `after-release-20261015T015145461641Z.json`
- `after-release-20261015T015307001320Z.json`
- `after-release-20261015T015420377502Z.json`
- 로컬 동일 ID 집합·감사 연결 재검증: `local-post-release-conservation-20261015T015450463325Z.json`

고정 baseline 파일과 세 ID floor를 바꾸지 않았고 원본 SHA-256도 유지됐다.
이번 관측은 정상 실행을 기다린 네 번의 제한된 조회로 마친다.
남은 확인은 CDN 실제 purge/재확인 완료 및 귀속 불명 16개의 정상 다음 접속 확인이다.
향후 다른 릴리스가 적용되면 실제 SHA를 확인한 뒤 관측기의 expected SHA를 바꿔야 한다.


## 최종 캐시 확인과 새 실패 시작 — 2026-10-15 11:15 KST

후속 모니터 수정 [PR423](https://github.com/JRVector9/nomorevibe/pull/423)을 정상 병합·CI 후
UTC 02:10:57.671에 전체 13앱·18컨테이너에 배포했다.
이 관측의 runtime 및 유효한 maintenance primary lease는 모두
`347d647cc21a272e3e5b6acc1a0fd41f2190f173`였다.
이전 94b 정책과 같은 자동 내림을 관측하며 기존 고정 535개·세 ID floor는 유지했다.

UTC **02:15:34.969**의 read-only/repeatable-read 조회와 로컬 교차검증에서,
최초 처리 가능 519개 ID 집합과 실제 정책 차단 519개가 여전히 정확히 일치했다.
**운영 감사519 / 제품 감사519 / CDN 등록519 / 실제 purge519 / 재확인519**를 모두 연결했다.
전체 metadata·두 감사의 동일 트랜잭션·제품별 정확히1개 정책 기록을 확인했고,
중복·감사 누락·고아 기록·캐시 오류는 모두0이었다.
정상 작업자가 처리했으며 관측자가 수동 job을 접수하거나 실패 수·제품 상태를 수정하지 않았다.
공개 상세 `product-23`, `threatscan-download`, `attenza`도 실제 GET에서 모두404였다.

전체 CDN 큐는 별도 UTC 02:15:16.495 관측에서 pending0/오류0/confirmed2,419였다.
이후 다른 정상 작업의 새 요청이 추가될 수 있으므로 전체 큐의 영구적인0을 의미하지 않는다.
위519개 정책의 완료와 전체 CDN의 일시 집계를 구별한다.

처음 보호한16개 중 **3개**(`nabi-markdown`, `wxsm`, `medialane-sdk`)는
정상 접속 확인에서 연속 실패 수1, `checkedAt=downSince`로 새 실패를 시작했다.
마지막 응답은 각각404/연결실패0/연결실패0이므로 접속 회복으로 세지 않는다.
세 제품은 계속 공개seeded였으며 남은13개도 귀속 불명 보호 상태였다.
새 실패 시작은 실제 관측됐지만 이16개가 모두 처리·회복됐다고 주장하지 않는다.
다음 정상 확인 주기는6시간이고 과거 실패 이력은 보존한다.

최종 비공개 증거(권한600):

- `after-release-20261015T021535380821Z.json`
- `local-final-verification-20261015T021535Z.json`

전체 배포·AI backoff의 실제 확인과 이미지 digest는
[모니터 수정 보고서](2026-10-15-ai-not-found-monitoring.md)에 기록했다.
전체 자동 적체와 후보1개 회복은 [적체 회복 보고서](2026-10-14-backlog-catchup.md)를 따른다.

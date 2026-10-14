# 2026-10-15 — Cloudflare purge 인증 복구와 무료 캐시 한도 확인

## 완료한 운영 복구

사용자가 Cloudflare 로그인과 토큰 발급·적용을 승인했다. 실제 로그인된 Chrome에서
nomorevibe.com 한 zone의 Cache Purge:Purge 권한만 가진 토큰을 생성했다.
자격 증명은 private 파일과 기존 Keychain 항목에 저장했다. 값·Authorization·원시 환경은 공개하지 않는다.

2026-10-14 22:19:23 UTC 토큰 active와 해당 zone의 실제 tag purge API 성공을 확인했다.
양 publisher에 CLOUDFLARE_ZONE_ID/CLOUDFLARE_PURGE_TOKEN만 추가하고 같은 runtime b0879ea로 배포했다.
그 외 환경·모델·이미지·command·replica·source 정책은 보존했다.

재배포 동안 Mini standby가 작업을 인수했다. M3 primary는 유효한 예비 lease를 선점하지 않으므로
정상 Dokploy application.stop/start로 예비를 잠깐 중지하고 주 실행자를 복귀시켰다.
API 응답에 오류가 있어도 실제 서비스 동작은 완료된 경우가 있어, 상태를 다시 읽어 확인했다.
DB 역할 lease·cursor·attempts를 직접 수정하지 않았다.

22:38:19 UTC 양 publisher 1/1 healthy와 runtime credential hash 일치,
다섯 역할 ready·scheduler 2/2·worker progress ok를 확인했다.
22:30:53 UTC 기존 배포 helper purge_html()도 htmlPurge=ok/errorCount0이었다.
이 실제 성공 뒤 PENDING의 이전 인증 장애 항목을 제거했다.

## 실제 삭제 대기열 진행

| UTC | 전체 행 | 미확인 | 복구 뒤 두 번째 성공 확인 | 미확인 오류 |
|---|---:|---:|---:|---:|
| 22:20:49 | 1,894 | 1,894 | 0 | 0 |
| 22:22:00 | 1,894 | 1,849 | 45 | 0 |
| 22:34:07 | 1,894 | 1,579 | 315 | 0 |
| 23:04:50 | 1,894 | 904 | 990 | 0 |
| 23:23:43 | 1,895 | 455 | 1,440 | 0 |

기존 정상 cdn-purge 잡이 처리했다. first 성공을 purged_at에 저장하고 60초 이후 second API 성공을
confirmed_at에 저장한다. 이는 API가 두 요청을 받아들인 기록이며 Cloudflare가 제공한
전 세계 캐시 제거 완료 영수증은 아니다. 전체 backlog 소진은 아직 완료가 아니다.
unused 시험 tag의 성공이나 공개 HTML DYNAMIC/no-store만으로 객체 제거를 증명하지 않는다.

비공개 증거는 /Users/jr/.config/nomorevibe/cloudflare/2026-10-15 아래 700/600으로 보관한다.
api-proof/keychain-proof/html-purge-proof/deployment-proof와 시점별 progress JSON이 있다.
before.json 및 token 파일은 출력하거나 커밋하지 않는다. capture/apply를 다시 실행하지 않는다.

## 사용자 요청의 무료 사용량 80% 기준

사용자는 메모리 보호가 아니라 Cloudflare 무료 사용량 초과 비용 방지를 원한다고 정정했다.
일반 CDN Free에는 월 요청 수·전송량·저장 GB-month의 과금 allowance가 없다.
CDN 대역폭은 포함되며 별도 전송량 요금이 없다.
[Cloudflare 과금 설명](https://developers.cloudflare.com/billing/understand/how-charges-accrue/),
[Free 요금제](https://www.cloudflare.com/plans/free/).
따라서 현재 CDN을 월 무료 사용량 80%에서 끄는 기준을 만들지 않는다.

실제 nomorevibe.com UI에서 Free를 다시 확인했다. Cache Reserve는 Activate Cache Reserve 화면,
즉 비활성 상태였다. 유료 상품·플랜·캐시 규칙을 새로 활성화하지 않았다.
Cache Reserve는 일반 CDN과 다른 저장 과금 상품이며 무료 allowance가 없다.
[Cache Reserve 과금](https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/).

확인된 API 처리율은 tag/hostname/prefix/everything purge의 Free 5요청/분 보충률,
버킷25·요청당100작업이다. 같은 계정의 같은 플랜 zone들이 공유한다.
이것은 비용 한도가 아니다. 분당4요청 수준의 발송 보호를 추가한다면 초과분을 outbox에
보존하고 나중에 보내야 하며, 실제 발송하지 않은 건을 confirmed로 바꾸지 않아야 한다.
다른 앱/zone/dashboard 호출까지 통합하지 않으면 계정 전체80%를 보장할 수 없다.
[공식 purge 제한](https://developers.cloudflare.com/cache/how-to/purge-cache/).
새 API limiter/메모리 guard는 이 단계에서 구현하지 않았다.

Workers·KV·R2에는 상품별 다른 quota와 과금 규칙이 있다. 이 저장소의 조회 캐시와
제품 purge를 그 상품의 무료 저장량으로 계산하지 않는다. 이후 해당 상품을 사용한다면
실제로 선택한 플랜·계정 전체 사용량·초과 동작을 기준으로 별도 비용 차단을 설계해야 한다.

## 기존 별도 캐시 서버 확인

웹 M3 4개/mini2개 실제 컨테이너 모두 기존 Valkey 공유 조회 캐시가 설정돼 있었다.
2026-10-14 22:32:53 UTC 내부망 캐시에 5초 만료 자체 시험키 SET/GET을 수행해
6개 모두 성공했다. 쓰기·읽기 왕복은 1.01~1.39ms였다.
실제 캐시 적중률·p95·DB 절감량은 이번 시험으로 측정하지 않았다.
새 서버 주소·배치가 지정되지 않아 URL/ACL/서버 정책을 변경하지 않았다.
일반 CDN의 비용 초과 문제를 해결하려고 동일한 조회 캐시를 추가할 이유는 확인되지 않았다.

## 다음 관측

정상 잡의 미확인/first pending/confirmation pending/오류/confirmed 증가를 함께 관측한다.
전체 적체 회복·자동 일감과 직접 판단할 항목의 구별은 병렬 backlog 회복 보고서와 CODEX_HANDOFF를 따른다.

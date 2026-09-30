# 2026-10-01 — 태어난 프로젝트 감소 조사·최신 탐색 수정

## 운영 관측 (01:14~01:27 KST)

운영 crawler에서 PostgreSQL 읽기 전용 트랜잭션으로 집계했다. DB 설정·스키마는 수정하지 않았다.
공개 health `ok/db:ok`, 운영 릴리스 `50b02b7`. 첫 health 연결 reset 뒤 retry 성공.

- 공개 상태 `seeded` 20,502건, `banned` 35건. 수집 frontier `done` 114,117건,
  `skipped` 79건, `failed` 5건, 대기·수집 중 0건.
- crawl-seed 성공 01:11:51, 오류 null. fetch·judge·review·publish도 최근 성공·오류 null.
- 홈 “태어난 프로젝트”는 누적이 아니라 KST 오늘 자정 이전 완료된 최근 7일의 GitHub
  `created_at`이며 현재 공개 상태·자정 이전 발행 조건을 적용한다. 현재 집계 16건.
- 현재 공개 자료로 과거 날짜의 동일 조건을 재계산하면 9/24 179 → 9/25 98 →
  9/26 38 → 9/27 16 → 9/28 16 → 9/29 17 → 9/30 17 → 10/1 16이다.
  이는 보존한 과거 화면 스냅샷이 아닌 현재 자료의 재계산이다.
- 최근 8일 발행 변화는 추가만 있었고 취소(`delta=-1`)가 없다. 9/23 430,
  9/24 347, 9/25 296, 9/26 278, 9/27 323, 9/28 398, 9/29 242, 9/30 94건 추가.
- 워커가 죽은 것이 아니라 검색이 오래된 날짜를 처리 중이다. 전체 cycleWindow는
  9/15 20:11:40~9/18 20:11:40 UTC, Claude의 활성 창은 9/16 02:16:37~02:17:39 UTC.
  다른 11개 신호는 주기를 마쳤지만 Claude의 포화 구간이 남아 새 주기로 넘어가지 못한다.
- 저장된 설정은 `sort=relevance`, `windowDays=3`, `pagesPerTick=2`, seed 주기 10분.
  초당/분당으로 쪼개지는 대량 검색을 틱당 2페이지로 훑으며 약 12일 뒤처졌다.

감소 원인은 7일 창에서 과거 생성분이 빠지는 동안 최신 생성분의 수집·발행이 부족한 것이다.
공개 제품의 삭제나 워커 전체 중단으로 확인된 현상은 아니다. uptime 숨김은 일반 목록에만
적용되며 이 born 집계에는 들어가지 않는다. 집계 기준을 바꿔 수를 부풀리지 않는다.

## 수정 설계

1. 기본 정렬과 운영 저장값을 최신 활동순으로 맞춘다. 커밋 `committer-date desc`,
   저장소 `updated desc`. GitHub 검색 범위는 커밋 날짜/푸시 날짜이고 생성일 정렬이 아니다.
2. 포화 구간의 최신 절반부터 훑는다. 이전 절반은 저장하며 정렬만 바꿔도 기존 미완 구간을
   버리지 않는다. 다른 정렬에서 이어받은 페이지는 1부터 다시 확인하여 페이지 누락을 막는다.
3. 전체 탐색이 하루 이상 뒤처지면 페이지 예산 절반을 최신 구간의 신호별 첫 페이지에 먼저
   배정한다. 나머지는 전체 탐색을 진행한다. 예산 1이면 최신·전체를 번갈아 실행한다.
   최신 탐색을 끝내고 1시간이 지나기 전에는 전체 탐색에 모든 예산을 사용한다.
   최신 첫 페이지는 전체 탐색 완료로 간주하지 않는다. 오래된 전체 커서는 연속 날짜 구간을
   이어받아 나머지 결과를 수집한다. GitHub 자체 검색 제한으로 모든 프로젝트 발견을 보장하지 않는다.
4. 최신·전체는 같은 crawl-seed 잡/역할 lease 안에서 직렬 실행한다. 기존 URL/GitHub ID
   중복 검사, 원본 저장, 인증/쿼터 대기, 큐 10,000 중지·5,000 재개를 사용한다.
   두 커서를 페이지 부수효과 전에 함께 저장하여 DB 오류/재시작 시 저장 페이지부터 이어받는다.
5. 관리자에 활동일과 생성일의 차이, 최신 우선/미완 구간 병행을 명시한다.

## 실제 검사 결과

- 로컬 `npm test`: 161파일·1,286검사 성공. 수집 3파일·38검사(최신 탐색 10개) 성공.
- `next typegen`, `tsc --noEmit`, `git diff --check` 성공. lint 오류 0·기존 vendor 경고 1.
- 배포 자동화 Python 검사 8개 성공.
- PR #244 run `36745191372`, #245 run `36746542548`의 quality·통합 3분할·check 성공.
- main run `36747035679`의 quality·통합 3분할·check·두 이미지 빌드 모두 성공.

이전 main run `36745740075`는 통합 검사는 통과했으나 기존 Show HN 1,100건 단위검사가
5초 제한을 넘었다. HTTP는 모의 응답인데 URL 검사가 실제 Algolia DNS를 반복 조회했다.
끝나지 않은 비동기 테스트는 다음 테스트의 mock도 오염시켰다. 해당 테스트의 DNS만 공개
IP로 고정하여 외부 I/O를 제거한 뒤 후속 PR/main 검사가 성공했다. 운영 SSRF는 변경하지 않았다.
첫 TypeScript 검사도 테스트 반환 타입 추론이 좁아 실패했고 SeedCursor 반환 타입 명시로 고쳤다.
로컬 Docker daemon은 미실행 상태였으므로 실제 DB 통합 검증은 CI의 독립 PostgreSQL을 사용했다.

## 배포·운영 설정 적용 완료

운영 릴리스 `dd3a21f07fe98acd60148701cce1c1f8d1afdae8`:

| 이미지 | digest |
|---|---|
| worker | `sha256:38009bf5c3bbd512412a862984a83e8a40a278b2e18a6ed1164e9cbf53d0b444` |
| web | `sha256:49ef17b917384556e62af5a0c8ff58802bcdcde7984ab71a8c88ff87de2aa21d` |

`scripts/ops/deploy_shared_images.py run`으로 publisher→reviewer→crawler 각각 mini 예비→M3 주,
그다음 mini→M3 웹을 배포했다. 8앱 모두 deployment done/service healthy,
각 역할 쌍의 readiness ready/progress ok, 공개 m3-web·mini-web health ok/db:ok와 같은
release를 확인했다. DB migration은 없으며 DB 서버·스트리밍·서버 설정을 변경하지 않았다.

02:00:38 KST에 새 crawler의 release를 확인하고 `saveSettings`로
`discover.sort=relevance→recent`, `pagesPerTick=2→10`만 부분 수정했다.
`windowDays=3`, 검색 신호·판정/심사 기준은 기존 값이며 설정 저장 당시 cursor도 그대로였다.
정상 worker에 crawl-seed 3틱을 순차 요청하여 최신 신호 12개를 모두 훑었다.

## 실제 수집 검증 (02:15 KST)

| 항목 | 결과 |
|---|---:|
| 신규 frontier 발견 | 389 |
| 원본 저장 | 382 |
| 심사 후보 저장 | 382 |
| 기존 GitHub ID 별칭으로 제외 | 7 |
| 새로 저장한 GitHub ID 중복 | 0 |
| 수집 대기/진행 중/재시도 소진 실패 | 0 / 0 / 0 |
| 최근 7일 생성된 원본 | 112 |

최신 cursor의 창은 UTC `2026-09-27T17:01:22Z..2026-09-30T17:01:22Z`이다.
`doneSignals` 12개, `waiting=true`, 다음 최신 탐색은 03:01:22 KST 이후다.
그동안 전체 탐색 cursor는 기존 UTC 9/15~18 주기를 유지하며 활성 창을 9/16에서
9/18 20:10:38~20:11:40으로 진행했다. 과거 창을 버리지 않고 최신 탐색을 먼저 한 증거다.
seed의 `requested_version=processed_version=2994`, `last_success_at=02:11:45 KST`, 오류 null.
fetch·judge·1차 심사·publisher도 최근 성공/잡 오류 null을 확인했다.

중간 관측에서 원본·후보 수량이 달랐지만 원본을 읽어 후보를 만드는 judge가 따라간 뒤
382/382가 됐다. 별칭 7개는 원본을 두 번 저장하지 않도록 제외한 것이며 유실이 아니다.
이전에 저장된 GitHub ID 중복을 정리했다고 주장하지 않는다.

최근 생성 원본 112개 중 규칙 거절 83개(no_homepage 71/not_a_product 10/unreachable 2),
승인 상태 16개, 추가 심사 13개(ambiguous 11/second_review_split 2)였다.
이 112개가 모두 공개 제품이 되는 것은 아니다. 홈 born은 실제 공개된 제품만 세며
오늘 발행한 제품은 다음 KST 자정 이후 집계 대상이다. 당시 신규 생성 원본의 발행은 아직 0건이었다.

수정 전 읽기 전용 관측과 새 관측은 운영자 로컬 임시 경로에 보존했다. 환경 비밀을 포함한
배포 snapshot은 권한 0600으로 저장했고 저장소에 포함하지 않았다. 화면 시안 등 미추적 자료도
그대로 보존했다. 로컬 root main은 원격 운영 코드와 동기화했으며 이 최종 기록은 문서만 병합한다.

GitHub 검색의 정렬·검색 상한은 [공식 Search API 문서](https://docs.github.com/en/rest/search/search)를 따른다.

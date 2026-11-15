# 2026-11-15 운영 처리량·적체 읽기 전용 실측

품질 비교: **측정 없음** — 이 문서 작업에 적용할 저장소의 품질 점수 도구·이전 기준값이 없어 `이전 → 현재` 점수 비교를 하지 않았다. 실제 확인은 운영 SELECT/상태 조회, 수치 원본 대조, 문서 차이 검사로 구분해 아래에 기록한다.

- PR: [#972](https://github.com/JRVector9/nomorevibe/pull/972) (Draft 유지)
- 브랜치: `docs/ops-throughput-snapshot-20261115`
- 기준 main: `db1dc7aa0471330d9e48948b977b7bdc5608286d`
- 실측: 2026-11-15 **18:12:27–18:17:58 UTC (표본 기준 시각)**. 표의 시각은 각 읽기 전용 트랜잭션의 DB 시각 또는 앱/호스트 조회 시각이다. 모든 시각은 UTC다.
- 운영 데이터 쓰기·잡 제어·설정/env 변경·배포·재시작 없음. 이 문서와 해당 작업 브랜치/PR만 변경했다.

## 선택한 방법과 집계 기준

가장 영향이 적은 방법으로 기존 Dokploy 조회 도구와 감시 전용 SELECT 계정을 사용했다. 등록된 키는 `xa-key exec DOKPLOY_API_KEY=gpu3090/dokploy -- <조회 프로그램>`으로만 주입했다. 연결 값은 기존 앱 설정에서 메모리로 읽고 하위 조회 프로세스의 환경으로만 전달했다. 키·연결 문자열·호스트 주소·원본 환경변수는 파일/보고에 저장하지 않았다. `.env.local`은 변경하지 않았다.

DB는 `pg_is_in_recovery()=false`인 운영 주 DB다. Q1–Q11 및 T 집계는 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SET LOCAL TIME ZONE 'UTC'`, `SET LOCAL jit=off` 안에서 실행하고 `transaction_read_only=on`을 확인했다. 연결 설정은 프로세스의 `DB_POOLER_MODE=pgbouncer`, 연결 1개, `prepare=false`로 제한했다. SQL 문장 제한은 Q1–Q8 25초, Q9–Q11 및 text 집계 10초다. 운영 env를 저장하거나 바꾼 것이 아니다.

기간은 `(끝 시각 - 기간, 끝 시각]`이다. UTC를 담은 `timestamp without time zone` 열은 `now() AT TIME ZONE 'UTC'`와 비교했다. 서로 다른 표/단계의 유입·완료는 같은 후보 집단의 전환율이 아니다.

- 신규 발견: `crawl_frontier.discovered_at`. 원본 수집: `crawl_documents.fetched_at`의 현재 저장 행. 재수집마다 누적되는 이벤트 수가 아니다.
- AI1: `kind='automatic'`, `state='succeeded'`, `provider<>'rules'`, `reused_from_attempt_id IS NULL`의 `completed_at`, 후보 ID 중복 제거. 성공 시도 수도 별도 표시한다.
- AI2: `second_decision IS NOT NULL AND error_code IS NULL`의 `reviewed_at` 기준 **모델별 심사표**. 같은 표의 마지막 기록만 남으므로 모든 재시도를 세는 값이 아니다. 대기는 `status='pending'`이며 심사 중도 포함한다.
- text 대기는 `lib/operations/text-stage-progress.ts`의 `textStageProgressSql()`을 그대로 실행했다. `homeListSlugs()`가 실제 조회한 홈 제품 92개를 전달해 홈의 추가 품질 재시도 허용도 반영했다. 빈 홈 목록이나 근사 SQL로 대체하지 않았다. 준비 대상이 장부 fence·모델 용량 때문에 당장 실행되지 않을 수 있다.

## 최근 1시간·24시간

Q1 측정 시각: **2026-11-15T18:16:06.557Z**. 1시간 창은 `17:16:06.557Z–18:16:06.557Z`, 24시간 창은 `11-14 18:16:06.557Z–11-15 18:16:06.557Z`다. 24시간 열은 실제 합계이며 시간당 추정치로 환산하지 않았다. 명령/SQL은 아래 Q1이다.

| 항목 | 최근 1시간 | 최근 24시간 | 근거 |
|---|---|---|---|
| 신규 발견 후보(frontier) | 2,026 | 40,004 | Q1 |
| 원본 수집 저장소 | 1,999 | 40,145 | Q1 |
| AI1 성공 후보(중복 제거) | 312 | 6,311 | Q1 |
| AI1 성공 시도(참고) | 321 | 6,629 | Q1 |
| AI2 완료 심사표 | 266 | 5,580 | Q1 |
| 한국어 심사 사유 번역 완료 행 | 246 | 4,722 | Q1 |
| 한국어 한 줄 소개 오류 없는 저장 행 | 198 | 4,069 | Q1 |
| 검색 정보 생성 오류 없는 저장 행 | 347 | 5,925 | Q1 |

text 완료 3행은 각 결과 테이블의 시각·성공 상태를 센 값이다. 사유 번역은 현재 번역 대상과의 교집합을 요구하지 않았고, 한국어 소개는 공개 상태·현재 원문 일치를 요구하지 않았다. 아래 canonical 대기/5분 완료와 정의가 다르다.

## 시간별 실측

Q2 측정 시각: **2026-11-15T18:16:08.418Z**. 아래 경계의 초/밀리초는 모두 `:08.418`이다. 정각 창이 아니라 측정 시각에서 거슬러 올라간 24개의 완전한 1시간이다. Q1보다 끝 시각이 1.861초 뒤이므로 같은 창이라고 합산·비교하지 않는다.

| 시작 UTC | 끝 UTC | 신규 발견 | 원본 저장 | AI1 후보 | AI2 표 |
|---|---|---|---|---|---|
| 2026-11-14 18:16 | 2026-11-14 19:16 | 1,926 | 1,908 | 339 | 461 |
| 2026-11-14 19:16 | 2026-11-14 20:16 | 2,047 | 2,029 | 327 | 347 |
| 2026-11-14 20:16 | 2026-11-14 21:16 | 1,905 | 1,892 | 299 | 377 |
| 2026-11-14 21:16 | 2026-11-14 22:16 | 1,912 | 1,903 | 273 | 244 |
| 2026-11-14 22:16 | 2026-11-14 23:16 | 2,008 | 2,105 | 286 | 236 |
| 2026-11-14 23:16 | 2026-11-15 00:16 | 1,885 | 1,862 | 305 | 223 |
| 2026-11-15 00:16 | 2026-11-15 01:16 | 2,083 | 2,109 | 367 | 339 |
| 2026-11-15 01:16 | 2026-11-15 02:16 | 1,983 | 2,014 | 302 | 262 |
| 2026-11-15 02:16 | 2026-11-15 03:16 | 1,917 | 1,880 | 301 | 233 |
| 2026-11-15 03:16 | 2026-11-15 04:16 | 1,480 | 1,480 | 254 | 185 |
| 2026-11-15 04:16 | 2026-11-15 05:16 | 1,533 | 1,550 | 295 | 259 |
| 2026-11-15 05:16 | 2026-11-15 06:16 | 1,644 | 1,628 | 275 | 244 |
| 2026-11-15 06:16 | 2026-11-15 07:16 | 1,438 | 1,446 | 261 | 218 |
| 2026-11-15 07:16 | 2026-11-15 08:16 | 0 | 0 | 0 | 0 |
| 2026-11-15 08:16 | 2026-11-15 09:16 | 0 | 0 | 0 | 0 |
| 2026-11-15 09:16 | 2026-11-15 10:16 | 242 | 271 | 51 | 35 |
| 2026-11-15 10:16 | 2026-11-15 11:16 | 1,585 | 1,686 | 270 | 197 |
| 2026-11-15 11:16 | 2026-11-15 12:16 | 1,960 | 1,958 | 49 | 63 |
| 2026-11-15 12:16 | 2026-11-15 13:16 | 2,077 | 2,054 | 408 | 134 |
| 2026-11-15 13:16 | 2026-11-15 14:16 | 2,162 | 2,136 | 482 | 496 |
| 2026-11-15 14:16 | 2026-11-15 15:16 | 1,974 | 2,028 | 286 | 308 |
| 2026-11-15 15:16 | 2026-11-15 16:16 | 2,040 | 2,006 | 219 | 166 |
| 2026-11-15 16:16 | 2026-11-15 17:16 | 2,177 | 2,201 | 386 | 287 |
| 2026-11-15 17:16 | 2026-11-15 18:16 | 2,026 | 1,999 | 312 | 266 |

## 현재 대기와 짧은 간격 변화

T0=`2026-11-15T18:14:53.900721Z`, T1=`2026-11-15T18:17:58.303962Z`. 두 표본 모두 실제 홈 92개를 반영한 동일 canonical 집계다. 각 T1 행은 T1 시각 기준이며 명령은 아래 T다. `대기`는 즉시 준비 대상, `유예`는 재시도 시각 전, `중단`은 품질/시도 한도 등의 조건으로 구분한 값이다.

| 항목 | 즉시 대기 T0 → T1 | 증감 | T1 유예 | T1 중단 | T1 최근 5분 완료 | 명령 |
|---|---|---|---|---|---|---|
| 심사 사유 한국어 번역 | 108,298 → 108,324 | +26 | 7 | 0 | 27 | T |
| 제품 한국어 한 줄 소개 | 4 → 3 | -1 | 12 | 1,608 | 17 | T |
| 제품 검색 정보 생성 | 51 → 42 | -9 | 0 | 1 | 44 | T |
| 제품 검색 정보 검증(별도) | 40,229 → 40,249 | +20 | 0 | 0 | 13 | T |
| 원문 소개 없는 수집 후보 소개 생성(별도) | 0 → 0 | +0 | 0 | 0 | 1 | T |
| 제품 소개 검수(별도) | 2 → 1 | -1 | 0 | 41 | 4 | T |

사유 번역의 단위는 중복 사유를 합친 SHA-256 원문 해시다. 소개/검색 생성은 제품, 수집 후보 소개는 후보이므로 서로 합산하지 않는다. 호출 결과 중 공개 제품 외국어 번역은 이번 범위 밖이며 런타임 정책 초기화를 하지 않았으므로 수치를 채택하지 않았다. 이 약 3분 구간에서 사유 번역 대기는 **26 증가**, 검색 검증 대기는 **20 증가**했다. 장기 추세·원인·미래 소요 시간은 추정하지 않는다.

AI2 대기 별도 측정: **2026-11-15T18:16:23.088Z**, Q3.

| 상태 | 심사표 | 서로 다른 후보 | 가장 오래된 생성 UTC |
|---|---|---|---|
| agreed | 10,062 | 10,062 | 2026-11-03T02:05:55.946Z |
| needs_human | 2,482 | 2,482 | 2026-11-03T02:05:57.799Z |
| pending | 30 | 30 | 2026-11-15T18:06:03.209Z |
| resolved | 160,856 | 73,551 | 2026-09-11T08:06:14.697Z |

`pending=30표/30후보`다. `needs_human=2,482표`는 모델 대기가 아닌 사람 검토 상태로 분리했다.

## 미확인 모델 요청

**2026-11-15T18:16:23.331Z**, Q4: `indeterminate=388`, `dispatched=4`, `waiting=3`, `reserved=0`. 아래는 미확인 388건의 route별 실측이다. 미확인은 슬롯 점유나 실제 서버 실행 건수와 같지 않다.

| route | indeterminate 요청 | 가장 오래된 전송 UTC |
|---|---|---|
| crawl-agent-review | 121 | 2026-11-12T14:24:40.225Z |
| crawl-publish-classify | 2 | 2026-11-14T20:29:16.614Z |
| local-audit | 1 | 2026-11-13T00:08:02.559Z |
| local-held-qwen | 1 | 2026-11-13T07:56:05.029Z |
| local-human-deepseek | 3 | 2026-11-12T16:07:46.526Z |
| product-search-profile | 5 | 2026-11-14T02:29:15.095Z |
| product-search-verify | 51 | 2026-11-11T05:29:22.762Z |
| product-tagline-ko | 85 | 2026-11-11T15:47:17.744Z |
| product-translate | 111 | 2026-11-12T13:57:25.095Z |
| reason-translate | 5 | 2026-11-11T23:37:55.520Z |
| second-review | 3 | 2026-11-12T03:33:20.754Z |

**2026-11-15T18:17:57.523Z**, Q10 재확인: `indeterminate=388`, `dispatched=4`, `waiting=1`, `reserved=2`. 전송 중 4건의 가장 오래된 전송은 `18:17:46.801Z`, **30분 초과 dispatched=0건**이었다. 이는 장시간 전송 중 요청의 부재이며 고아 요청 확정 수를 뜻하지 않는다.

**2026-11-15T18:17:57.653Z**, Q11: 최근 1시간 `dispatch_indeterminate` 이벤트의 서로 다른 요청 **1건**, 최근 24시간 **43건**. 현재 잔존 388건과 신규 전환 이벤트 수는 별개다.

**고아 dispatched 확정 수: 측정 못 함.** Q5는 `2026-11-15T18:16:23.509Z`에 SQLSTATE `42501`로 실패했다. Q9(`18:17:57.497Z`)의 `has_table_privilege`로 감시 계정에 `dr_process_group_events` SELECT 권한이 없음을 확인했다(역할 lease·항목 lease·관측 표 SELECT는 있음). 프로세스 종료/후속 boot 근거를 읽지 못했으므로 확정 수 0이라고 쓰지 않는다. 다른 계정 전환·권한 변경·mark/close-review/dry-run 쓰기를 하지 않았다.

## M3·mini 운영 판

D 명령으로 Dokploy의 앱/최근 배포 상태를 읽은 뒤, R 명령으로 실제 Docker 서비스와 컨테이너의 이미지·`RELEASE_TAG`·running·health만 추렸다. 아래 시각은 실제 호스트 조회 시각이다. Dokploy 앱/최근 배포는 **18개 모두 done/done**, 런타임은 **18앱/23컨테이너 모두 running=true·healthy**, 모든 컨테이너 `RELEASE_TAG`는 **`db1dc7aa0471330d9e48948b977b7bdc5608286d`**로 같았다. M3 scheduler 2개·mini scheduler 1개를 직접 확인했다.

- W: worker 이미지 digest `sha256:bd868cda74e952e1bbd8095232b27f2c0742bc8c43c4d8501de5cd0f16536676`
- B: web 이미지 digest `sha256:9dfa384079aec15f117b2eecf000f60356badc854dfdaed460b83c4d6073a5e4`
- C: connect Git 빌드의 서비스/컨테이너 tag `latest`, 실행 image ID `sha256:389c043218d34836fcf33365397a1724a2692449ad12e06ae742bd1656b29770`. `latest` 자체로 Git 출처를 입증하지 않는다. 이번 커밋 비교는 실제 컨테이너의 RELEASE_TAG 관측이다.

| 호스트 | 앱 | R 조회 UTC(11-15) | 실행 수 | 릴리스 축약 | 이미지 | health | D 조회 UTC(11-15) | 최근 배포 생성 UTC(done) |
|---|---|---|---|---|---|---|---|---|
| M3 | publisher-m3 | 18:17:12.155164 | 1 | db1dc7aa | W | healthy | 18:17:07.598760 | 2026-11-15T17:48:28.136Z |
| M3 | reviewer-m3 | 18:17:12.219598 | 1 | db1dc7aa | W | healthy | 18:17:08.019527 | 2026-11-15T17:48:29.168Z |
| M3 | crawler-m3 | 18:17:12.283006 | 1 | db1dc7aa | W | healthy | 18:17:08.507916 | 2026-11-15T17:48:30.091Z |
| M3 | web-m3 | 18:17:12.350215 | 4 | db1dc7aa | B | healthy | 18:17:08.988378 | 2026-11-15T17:51:09.864Z |
| M3 | text-m3 | 18:17:12.483149 | 1 | db1dc7aa | W | healthy | 18:17:09.477835 | 2026-11-15T17:44:21.849Z |
| M3 | maintenance-m3 | 18:17:12.548675 | 1 | db1dc7aa | W | healthy | 18:17:09.956828 | 2026-11-15T17:44:20.827Z |
| M3 | scheduler-m3 | 18:17:12.611913 | 2 | db1dc7aa | W | healthy | 18:17:10.497793 | 2026-11-15T17:46:08.535Z |
| M3 | connect-agent-m3 | 18:17:12.697402 | 1 | db1dc7aa | C | healthy | 18:17:10.699731 | 2026-11-15T17:46:01.330Z |
| M3 | monitor-m3 | 18:17:12.764426 | 1 | db1dc7aa | W | healthy | 18:17:10.924923 | 2026-11-15T17:52:08.291Z |
| M3 | ai2-consumer-m3 | 18:17:12.829050 | 1 | db1dc7aa | W | healthy | 18:17:11.169334 | 2026-11-15T17:49:23.419Z |
| M3 | agent-scan-consumer-m3 | 18:17:12.894835 | 1 | db1dc7aa | W | healthy | 18:17:11.426902 | 2026-11-15T17:49:22.409Z |
| mini | publisher-mini | 18:17:09.478844 | 1 | db1dc7aa | W | healthy | 18:17:07.347143 | 2026-11-15T17:47:43.556Z |
| mini | reviewer-mini | 18:17:09.534048 | 1 | db1dc7aa | W | healthy | 18:17:07.816002 | 2026-11-15T17:47:44.414Z |
| mini | crawler-mini | 18:17:09.583799 | 1 | db1dc7aa | W | healthy | 18:17:08.274322 | 2026-11-15T17:47:45.241Z |
| mini | web-mini | 18:17:09.633594 | 2 | db1dc7aa | B | healthy | 18:17:08.739275 | 2026-11-15T17:50:25.063Z |
| mini | text-mini | 18:17:09.702649 | 1 | db1dc7aa | W | healthy | 18:17:09.227648 | 2026-11-15T17:43:36.257Z |
| mini | maintenance-mini | 18:17:09.753926 | 1 | db1dc7aa | W | healthy | 18:17:09.718173 | 2026-11-15T17:43:37.138Z |
| mini | scheduler-mini | 18:17:09.807248 | 1 | db1dc7aa | W | healthy | 18:17:10.195241 | 2026-11-15T17:45:22.889Z |

DB의 `service:*` 관측에는 mini 예비 역할의 옛 릴리스/옛 시각도 남아 있었다(Q7, `18:16:23.537Z`). 이를 현재 판 불일치로 단정하지 않고 실제 실행 컨테이너로 확인했다. 위 직접 조회에서는 M3·mini 릴리스 불일치가 없었다. 이 작업에서 배포한 앱·배포 준비 코드 변경은 없다.

## 잡 상태 및 확인된 이상

Q6 측정 시각 **2026-11-15T18:16:23.511Z**. 아래 UTC는 jobs의 timezone 없는 UTC 시각이다. 잡 마지막 성공은 항목 처리량과 별개다. 전체 오류 본문·cursor는 읽거나 싣지 않고 오류 존재 여부만 확인했다.

| 잡 | 마지막 실행 UTC | 마지막 성공 UTC | 잠금 시각 UTC | last_error 존재 |
|---|---|---|---|---|
| crawl-agent-review | 2026-11-15T18:15:48.715Z | 2026-11-15T18:15:56.663Z | 없음 | False |
| crawl-fetch | 2026-11-15T18:15:40.387Z | 2026-11-15T18:15:44.348Z | 없음 | False |
| crawl-judge | 2026-11-15T18:15:52.188Z | 2026-11-15T18:15:52.831Z | 없음 | False |
| crawl-seed | 2026-11-15T18:15:43.418Z | 2026-11-15T18:16:00.559Z | 없음 | False |
| product-search-profile | 2026-11-15T18:16:22.384Z | 2026-11-15T18:16:07.343Z | 2026-11-15T18:16:22.384Z | False |
| product-search-verify | 2026-11-15T18:16:15.036Z | 2026-11-15T18:16:10.006Z | 2026-11-15T18:16:15.036Z | False |
| product-tagline-ko | 2026-11-15T18:16:11.464Z | 2026-11-15T18:15:21.354Z | 2026-11-15T18:16:11.464Z | False |
| reason-translate | 2026-11-15T18:15:02.974Z | 2026-11-15T18:16:01.513Z | 없음 | False |
| second-review | 2026-11-15T18:16:07.546Z | 2026-10-25T23:41:15.981Z | 2026-11-15T18:16:22.562Z | False |

- Q2의 `11-15 07:16:08.418–08:16:08.418Z`, `08:16:08.418–09:16:08.418Z` 두 창에서는 신규 발견·원본·AI1·AI2가 **모두 0**이었다. 이 조회만으로 원인이나 정확한 장애 시작/종료 시각을 확정하지 않는다. 최신 1시간 네 항목은 모두 0보다 컸다.
- T0→T1 사유 번역·검색 검증 대기 증가와 한국어 소개의 중단 1,608건을 기록했다. 원인 조사나 수정은 하지 않았다.
- `second-review`의 jobs 마지막 성공은 10-25로 오래됐지만 Q1에는 최근 1시간 완료 266표가 실제로 있다. Q8(`18:16:23.575Z`)에서 ai2는 `items`, ai1/fetch는 `legacy`였다. 따라서 오래된 잡 성공 시각을 AI2 처리량 0으로 해석하지 않는다.
- 미확인 388건은 그대로 보존했다. 원인별 정산/회수, 잡·모델·설정 조정은 하지 않았다.

## 재현 쿼리와 명령(비밀 제외)

문서의 Q 번호는 다음 SELECT 본문에 대응한다. DB 연결은 기존 감시 앱의 SELECT 계정을 사용하고 연결 값은 출력하지 않는다. 각 Q를 다음 공통 보호 안에서 실행했다(정상 종료는 읽기 전용 COMMIT).

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL jit = off;
SET LOCAL statement_timeout = '25s'; -- Q9–Q11/T는 10s
SELECT now(), pg_is_in_recovery(), current_setting('transaction_read_only');
-- 해당 SELECT 본문
COMMIT;
```

T: 기존 코드의 SQL 생성기를 호출해 실행했다. `homeListSlugs()`와 두 집계를 하나의 같은 읽기 전용 Drizzle 트랜잭션에 연결했고, `work_mem=32MB`를 세션 내에 한정했다. 아래는 연결/오류 처리/출력 경로를 제외한 실제 호출이다. 결과값만 JSON으로 보존했다.

```ts
// drizzle(...).transaction(..., { isolationLevel: 'repeatable read', accessMode: 'read only' }) 안
const home = await homeListSlugs(); // 같은 TX의 SELECT, 92개
const reason = await tx.execute(textStageProgressSql(home, 'reason'));
const other = await tx.execute(textStageProgressSql(home, 'other'));
```

D: `scripts/ops/deploy_shared_images.py`의 기존 `Dokploy.app(short)`, `Dokploy.latest(short)`를 사용했다. 정체 검증 후 app 상태·설정 RELEASE_TAG·이미지 tag/digest·replicas와 마지막 배포의 상태/생성 시각만 추렸다. 읽은 API 경로는 `application.one?applicationId=<등록된 앱 ID>`, `deployment.all?applicationId=<동일 ID>`다. 앱 ID·API 접속 주소·env 전체 응답은 결과에 포함하지 않는다.

R: 같은 파일의 `app_metadata(short)`로 등록된 호스트·서비스를 확인하고 `ssh_python(...)`으로 다음 Docker 읽기 명령을 실행했다. 전체 응답은 원격 Python 메모리에서 처리하고 allowlist 필드만 반환했다. inspect 원문에는 env가 있으므로 원문을 출력/저장하지 않았다.

```sh
docker service inspect "$service"
docker ps --filter "label=com.docker.swarm.service.name=$service" --format '{{.ID}}'
docker inspect "$cid"
```

### Q1_rates

```sql
WITH w AS (SELECT now() AT TIME ZONE 'UTC' AS t), windows AS (SELECT t, h, t-h*interval '1 hour' AS since FROM w CROSS JOIN (VALUES (1),(24)) x(h))
SELECT h, since, t,
 (SELECT count(*) FROM crawl_frontier WHERE discovered_at>since AND discovered_at<=t) AS discovered,
 (SELECT count(*) FROM crawl_documents WHERE fetched_at>since AND fetched_at<=t) AS fetched,
 (SELECT count(DISTINCT candidate_id) FROM crawl_review_attempts WHERE kind='automatic' AND state='succeeded' AND provider<>'rules' AND reused_from_attempt_id IS NULL AND completed_at>since AND completed_at<=t) AS ai1_candidates,
 (SELECT count(*) FROM crawl_review_attempts WHERE kind='automatic' AND state='succeeded' AND provider<>'rules' AND reused_from_attempt_id IS NULL AND completed_at>since AND completed_at<=t) AS ai1_attempts,
 (SELECT count(*) FROM second_reviews WHERE second_decision IS NOT NULL AND error_code IS NULL AND reviewed_at>since AND reviewed_at<=t) AS ai2_votes,
 (SELECT count(*) FROM text_translations WHERE target_lang='ko' AND status='done' AND updated_at>since AND updated_at<=t) AS reasons_done,
 (SELECT count(*) FROM product_korean_taglines WHERE error_code IS NULL AND updated_at>since AND updated_at<=t) AS korean_table_done,
 (SELECT count(*) FROM product_search_profiles WHERE error_code IS NULL AND generated_at>since AND generated_at<=t) AS profiles_done
FROM windows ORDER BY h;
```

### Q2_hourly

```sql
WITH w AS (SELECT now() AT TIME ZONE 'UTC' AS t), buckets AS (SELECT t, n, t-(n+1)*interval '1 hour' AS lo, t-n*interval '1 hour' AS hi FROM w CROSS JOIN generate_series(0,23) n)
SELECT lo, hi,
 (SELECT count(*) FROM crawl_frontier WHERE discovered_at>lo AND discovered_at<=hi) AS discovered,
 (SELECT count(*) FROM crawl_documents WHERE fetched_at>lo AND fetched_at<=hi) AS fetched,
 (SELECT count(DISTINCT candidate_id) FROM crawl_review_attempts WHERE kind='automatic' AND state='succeeded' AND provider<>'rules' AND reused_from_attempt_id IS NULL AND completed_at>lo AND completed_at<=hi) AS ai1,
 (SELECT count(*) FROM second_reviews WHERE second_decision IS NOT NULL AND error_code IS NULL AND reviewed_at>lo AND reviewed_at<=hi) AS ai2
FROM buckets ORDER BY lo;
```

### Q3_ai2_queue

```sql
SELECT status, count(*) AS votes, count(DISTINCT candidate_id) AS candidates, min(created_at) AS oldest_created_at FROM second_reviews GROUP BY status ORDER BY status;
```

### Q4_ledger

```sql
SELECT route_id, state, count(*) AS requests, min(queued_at) AS oldest_queued_at, min(dispatched_at) AS oldest_dispatched_at FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate') GROUP BY route_id,state ORDER BY route_id,state;
```

### Q5_dispatched_owner (42501로 실패, 수치로 사용하지 않음)

```sql
WITH r AS (SELECT request_id,owner_instance_id AS inst,owner_boot_id AS boot,route_id,dispatched_at FROM model_capacity_requests WHERE state='dispatched'), facts AS (
 SELECT r.*, EXISTS(SELECT 1 FROM role_leases l WHERE l.owner_instance_id=r.inst AND l.owner_boot_id=r.boot::text AND l.lease_until>now()) AS role_lease,
 EXISTS(SELECT 1 FROM pipeline_item_leases l WHERE l.owner_instance_id=r.inst AND l.owner_boot_id=r.boot AND l.token IS NOT NULL AND l.lease_until>now()) AS item_lease,
 (SELECT max(observed_at AT TIME ZONE 'UTC') FROM operations_observations o WHERE (o.key LIKE 'candidate:%' OR o.key LIKE 'service:%') AND o.value->>'instanceId'=r.inst AND o.value->>'bootId'=r.boot::text) AS heartbeat,
 (SELECT max(recorded_at) FROM dr_process_group_events e WHERE e.owner_instance_id=r.inst AND e.owner_boot_id=r.boot AND e.kind='owner_exit_recorded') AS exit_at
 FROM r)
SELECT route_id,count(*) AS dispatched, count(*) FILTER(WHERE dispatched_at<now()-interval '30 minutes') AS older_30m,
 count(*) FILTER(WHERE NOT role_lease AND NOT item_lease) AS without_live_lease,
 count(*) FILTER(WHERE heartbeat>now()-interval '3 minutes') AS fresh_heartbeat,
 count(*) FILTER(WHERE exit_at>=dispatched_at) AS exit_recorded FROM facts GROUP BY route_id ORDER BY route_id;
```

### Q6_jobs

```sql
SELECT name,last_run_at,last_success_at,locked_at,next_scheduled_at,not_before,requested_version,processed_version,(last_error IS NOT NULL) AS has_error FROM jobs WHERE name IN ('crawl-seed','crawl-fetch','crawl-judge','crawl-agent-review','second-review','reason-translate','product-tagline-ko','product-search-profile','product-search-verify') ORDER BY name;
```

### Q7_runtime_observations

```sql
SELECT key, observed_at, value->>'instanceId' AS instance, value->>'release' AS release FROM operations_observations WHERE key LIKE 'service:%' ORDER BY key;
```

### Q8_modes

```sql
SELECT stage,mode,updated_at FROM pipeline_stage_modes ORDER BY stage;
```

### Q9_owner_permissions

```sql
SELECT v.table_name, has_table_privilege(current_user,'public.'||v.table_name,'SELECT') AS can_select FROM (VALUES ('role_leases'),('pipeline_item_leases'),('dr_process_group_events'),('operations_observations')) v(table_name);
```

### Q10_ledger_age

```sql
SELECT state,count(*) AS requests, count(*) FILTER(WHERE dispatched_at<now()-interval '30 minutes') AS dispatched_older_30m, min(dispatched_at) AS oldest_dispatched_at FROM model_capacity_requests WHERE state IN ('indeterminate','dispatched','reserved','waiting') GROUP BY state ORDER BY state;
```

### Q11_unknown_events

```sql
SELECT w.h,count(DISTINCT e.request_id) AS became_indeterminate FROM (VALUES (1),(24)) w(h) LEFT JOIN model_capacity_events e ON e.kind='dispatch_indeterminate' AND e.created_at>now()-w.h*interval '1 hour' AND e.created_at<=now() GROUP BY w.h ORDER BY w.h;
```

## 측정 못 한 항목·한계와 검증

| 항목 | 결과·정확한 이유 |
|---|---|
| 고아 dispatched 확정 수 | 측정 못 함. 감시 계정의 `dr_process_group_events` SELECT 권한 없음(42501, Q9 확인). 30분 초과 전송 중 0건은 Q10의 별도 실측이다. |
| crawl_candidates 자체의 신규 생성 건수 | 측정 못 함. 현재 스키마에는 최초 생성 시각 열이 없고 `updated_at`은 갱신 시각이다. 신규 발견은 frontier.discovered_at로 실제 집계했다. 이를 후보 행 최초 생성 건수로 바꾸어 쓰지 않았다. |
| 24시간 동안 모든 재수집·모든 재심사 시도 누계 | 측정 못 함. 원본 및 AI2 표의 시각은 마지막 기록으로 덮인다. 현재 저장 기록에 근거한 창 집계만 제시했다. |
| 적체의 24시간 순증·미래 해소 시간 | 측정 못 함. 동일 정의의 24시간 전 큐 스냅샷을 이번에 확보하지 않았다. 직접 읽은 T0→T1 변화만 기록했다. |
| connect Git 소스 커밋의 별도 출처 검증 | 미수행. 실제 tag·image ID·RELEASE_TAG만 조회했다. 운영 빌드 로그/소스 증명까지 확인한 것으로 쓰지 않았다. |

실제 검증:

- 운영 SQL 결과의 DB 시각·read_only=on·replica=false 확인. Q5 실패는 성공으로 세지 않았다.
- 저장한 JSON과 문서 표의 수치·미확인 route 합계 388·18앱/23컨테이너·이미지/릴리스 일치 대조.
- `git diff --check` 및 문서 변경 범위·비밀/내부 접속 정보 검사 수행.
- 문서 전용 변경이므로 앱 시험·전체 unit·전체 DB·build·브라우저/화면 검증은 미실행. UI 변경·화면 캡처 없음. 착수 커밋의 GitHub Actions [43745281737](https://github.com/JRVector9/nomorevibe/actions/runs/43745281737)는 Draft 관문으로 check 실패·나머지 주요 검사 skip이었다. 최종 머리의 상태는 PR 및 개발 보고에 남긴다. CI 통과로 간주하지 않는다.
- 초기 로컬 조회 래퍼 4회 실패: 트랜잭션 어댑터 초기화 오류 2회, `aws4fetch` 누락 1회, CJS/ESM 스키마 초기화 오류 1회. 작업 임시 경로의 의존성 보완과 기존 스키마 결합 수정 후 T0/T1 조회가 성공했다. 운영 코드/의존성/설정은 변경하지 않았다.

## 이 구역의 할 일

- [x] 최신 main의 새 브랜치·빈 시작 커밋·Draft PR #972 생성 및 정체 확인
- [x] 기존 운영 문서와 도구·집계 정의 확인
- [x] 수집·AI1·AI2의 최근 1시간·24시간/시간별 처리량 및 AI2 대기 측정
- [x] 번역·한국어 한 줄 소개·검색 정보 대기와 두 표본 변화 측정
- [x] 미확인/전송 중 요청 수 측정, 고아 확정 권한 차단과 이유 기록
- [x] M3·mini 18앱/23컨테이너의 실제 운영 판·health와 Dokploy 상태 조회
- [x] 수치·시각·명령·한계 및 이상 기록, 문서 검증
- [x] 커밋할 문서·원본 대조 결과·PR 요약·개발 보고 첨부 준비 (최종 커밋/접수 상태는 PR 및 개발 보고 참조)

이 작업에 해당하는 별도 미완료 목록이 없어 이 문서 안에서 진행 상태를 관리했다. 남은 운영 확인은 위 측정 불가/미수행 범위이며, 이번 읽기 전용 권한에서 임의로 조치하지 않는다.

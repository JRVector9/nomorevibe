# PR03b AI1 writer·공유 입력 실제 검증

PR03의 AI1 단위다. 기본 stage legacy/epoch1/계약0 및 새 consumer 비활성을 유지한다. item B5 인증, legacy 외부 호출 종료, 2배 처리량, Oracle DR의 완료 기록이 아니다.

## 구현과 검토

gpt-6.1-sol/xhigh 담당3명에게 AI1 source/unit, B5 최소 권한/기존 integration, 독립 actual DB 회귀를 배정했다. root는 공유 입력 controller와 runner/artifact 접점·문서·Git을 맡았다. 파일과 loopback DB를 분리했고 handback 뒤 root 직접 리뷰 및 두 담당의 읽기 교차 리뷰를 마쳤다. 마지막 소스에서 추가 미해결 P1/P2는 발견하지 못했다. 소스 commit은07051b0이며 실제 merged main254a5bb를 먼저 통합했다.

- claim/result는 필수 receipt를 사용한다. 실제 candidate·input/source/policy hash·snapshot·prompt/rules·attempt·origin과 legacy job/stage epoch 또는 actual item binding/owner/boot/token/epoch를 확인한다. item adapter는 아직 consumer에 연결하지 않았다.
- stage SHARE(fetch→ai1→ai2)→domain→attempt→item→jobs 순서다. 결과·item release·후속 job 요청은 같은 transaction이다. rowlock/outbox 대기 뒤 실제 DB wallclock으로 만료를 재검사한다. 외부 HTTP·모델 대기 동안 transaction은 유지하지 않는다.
- direct reuse 성공 이력은 불변이다. semantic reuse는 현재 token의 새 running attempt를 생성하고 budget 취소도 정산한다. 입력/관리자 결정이 바뀌면 자기 cleanup만 수행하며 건강한 다른 item 소유권을 producer/recovery가 해제하지 않는다. observe의 기존 후속 요청 동작과 publication/AI2 품질 gate를 보존했다.
- README·공개 README·text source·자동 규칙 판정·관리자 판정·설정 쓰기는 stage 잠금을 먼저 잡는다. 아직 전체 product/publication/evidence/reconsider controller의 S3 결합이 끝난 것은 아니다.
- B5 handlers-v5는 stage/item SELECT와 row lock에 필요한 제한된 열 UPDATE만 허용한다. 실제 mutation은 ALWAYS statement trigger 또는 기존 ACL로 거절한다. 이전 v4 artifact를 v5로 재표기하지 않는다. runner는 prepare/eachtick/seal 전에 default legacy/epoch1/계약0/item row0만 허용한다.

## 실제 RED와 수정

- 독립 actual handler: items/draining에서 README·모델·domain 쓰기, healthy foreign item의 running attempt takeover를 재현했다. 정상 legacy control1 PASS와 행동 RED3을 분리해 기록했다. 최종38 PASS에는 actual item claim/result, 두 owner 경합, receipt 위조8종, direct/semantic 재사용, source/human/settings invalidation, heartbeat, expiry·재할당·late result, drain, atomic outbox rollback·중복, downstream wait expiry, semantic budget 취소, healthy owner exhaustion·source producer가 포함된다.
- B5 제한 role의 stage/item row lock 권한 actual RED2→최소 권한과 immutable trigger 적용 뒤 profile17 PASS. runtime claim/renew/release42501 및 실제 row 불변도 확인했다.
- root source controller는 실제 stage UPDATE lock 뒤 대기하는지, domain row를 먼저 잠그지 않는지 두 연결로 검증했다. 기존 controller5 FAIL→5 PASS. polling은 실제 pg_blocking_pids barrier를 기다리며 sleep 시간 자체를 증거로 쓰지 않는다.
- artifact v4 수락 actual RED1→39 PASS. unsupported certified items/draining에서 기존 runner가 artifact를 반환한 actual RED2→수정 뒤2 PASS/기존4 skip 단독 실행, 최종 공유 DB에서는 파일 전체를 실행했다.
- 기존 runner/dispatch unit mock이 신규 verified DB session API와 receipt를 반영하지 않아 full unit26개가 실패했다. 모의 DB API/fixture shape만 보완했고 기존 deadline/teardown·transport·writer 결과 assertion은 유지했다. 두 파일38 PASS 뒤 전체2,853 PASS. 이 fixture 실패는 행동 RED로 세지 않는다.

## 담당 결과

- AI1 unit24 PASS, scoped lint·전체 tsc exit0.
- B5 profile17 PASS, 배정 기존 integration8파일91 PASS(29.87초), scoped lint exit0. 담당의 중간 tsc는 다른 파일과 typegen 전 오류로 실패했으며 root의 최종 전체 tsc로 닫았다.
- 독립 ownership38 PASS(5.68초), scoped lint·tsc exit0.
- 55474/55476의 자체 fixture·connection0 및 세 stage 기본값 복원을 확인한 뒤 컨테이너를 중지했다. 55475는 생성하지 않았다. cleanup이 append-only audit까지 TRUNCATE하려던 한 차례는42501로 전체 rollback됐고 audit를 유지한 채 자기 fixture만 정리했다.

## root 최종 결과

- unit277파일 **2,853 PASS**(8.30초).
- 공유 integration11파일 **79 PASS**(62.98초). 해당 실행은 전체 suite에 가산하지 않는다.
- next typegen·tsc --noEmit --incremental false·전체 lint·i18n·Python23·build·bundle exit0. lint 기존 vendor warning1. bundle 세 경로 모두 기준 한도 이내다.
- 첫 전체 integration166파일은1파일5 FAIL/1,848 PASS/기존TODO1(380.23초). 실제 global handler가 앞 파일의 foreign 후보까지 처리하고, 원본 catalog job을 매 test에 다시 넣어 새 요청 기대값과 충돌한 fixture 격리 문제다. 원본 후보를 시험 동안 입력 universe에서 명시 제외하고 종료 시 전체 행을 원상 복원·exact 검사하며, catalog 원본도 afterAll에만 복원하도록 수정했다. 기존 dispatch/결과/원자성 assertion은 유지했다. 첫 정리안은 job 없음 증명의 기대값에 원본 job을 사용해37 PASS/1 FAIL였고 실제 pre-claim snapshot 비교로 정정했다. 수정된 파일38 PASS(4.27초), 최종 전체 suite 재실행 중이다. root 자체 DB55477은 최종 readback/정리 전이다.
- 두 번째 전체 DB는9파일14 FAIL/1,764 PASS/75skip/기존TODO1(343.74초). 최초 오류는 first-final 마지막 case의 profile 설치 `CREATE TRIGGER replay_handler_change ... ON public.crawl_candidates` lock timeout이며 blocker는 아직 미확정이다. 55477은 조사용으로 보존했다. setup 실패 때 이미 생성한 bootstrap을 release하지 않아 이후 already_provisioned가 연쇄 발생한 별도 P2는 확인·수정했다. 실제 beforeProvision 실패/CREATE TRIGGER 경합/cleanup 실패 전달3 RED→3 GREEN, 기존 first-final15와 합친 최종2파일18 PASS(20.55초), tsc·scopedlint exit0. timeout·권한·immutable guard를 바꾸지 않았다.
- 원본 fixture의 DB timestamp µs 손실도 raw to_jsonb 비교로 실제 RED(38 body PASS/teardown FAIL)를 재현했다. candidate는 suspend한 decidedBy만 복원하고 jobs/settings은 raw JSON populate로 복원해 최종38 PASS(4.35초), scopedlint exit0이다. 중간 JSON cast 오류와 미정리 자기 sentinel 중복은 fixture 수정 실패로 기록하며 행동 RED에 합산하지 않는다. 위 '전체 행 복원'은 이 제한된 열 복원+전체 raw 검사로 대체한다.
- HEAD66ca2c8(source07051b0/fixturef2370a5 포함). 새55482의 최종 전체 integration **167파일/1,856 PASS·기존TODO1**(396.06초), session97101 exit0. 기본 deadlock_timeout1s·기존 runtime lock1s/statement5s timeout을 유지하고 읽기 전용 pg_blocking_pids 관측과 서버 logging만 추가했다. 원래77의 일시적 CREATE TRIGGER blocker는 재현되지 않아 미확정으로 남긴다. 결과는 `/tmp/nomorevibe-pr03b-root-db-full-fresh-20261016.log`, 관측은 `/tmp/nomorevibe-pr03b-root-db-locks-20261016.jsonl`. 앞 문단의 '최종 전체 재실행 중'보다 이 결과가 우선한다.
- 최종55482 readback:3stage legacy/epoch1/contract0, item0, replay schema/role/trigger0, 자체fixture0, 다른connection0 및 PUBLIC database/schema ACL 원복 확인. 기록은 `/tmp/nomorevibe-pr03b-root-db-final-readback-20261016.log`. 실패55477은 원본 오류 자료를 보존하며 운영DB는 변경하지 않았다.
- 로그: `/tmp/nomorevibe-pr03b-root-{unit-verified,shared-db-final,db-full-verified,typegen-final,tsc-final,lint-final,i18n-final,python-final,build-final,bundle-final}-20261016.log`.

## 남은 경계와 적용 순서

stage inactive handler의 정상 반환을 기존 runner가 ACK하는 동작은 남아 있다. 전용 blocked outcome과 token CAS 해제로 요청·cursor·notBefore·성공/실패 이력을 보존하는 후속 단위를 진행한다. 일반 done=false의 기존 의미 전체를 바꾸지 않는다.

preflight와 실제 dispatch 사이의 간격은 durable 외부 호출 종료 증명이 아니다. job90s·running0·TTL·AbortSignal만으로 legacy 호출 종료를 인증하지 않는다. stage 입장 장부와 실제 원격 종료·공통 model permit은 별도 후속 계약으로 남으며, 미정산 호출은 전환을 막아야 한다. full input controller 및 stage/item projection·journal·writer authority·artifact item 인증도 아직 남아 있다.

운영 DDL·배포·실제 provider 호출·consumer 활성화·신규 발굴 재개는 수행하지 않았다. 마지막 운영 확인 릴리스8020dca. 향후 적용은 drain→**0077 migration exit0**→역할 image 교체→canary 순서다. 이미지 빌드 성공을 운영 적용으로 보고하지 않는다.

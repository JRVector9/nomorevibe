# 2026-10-14 — 수집 복구·관리자 크롤러 활동·운영 배포

## Current objective / authorization

사용자는 변경의 커밋·푸시·운영 배포·마이그레이션과 모든 크롤러의 관리자 활동 표시를 지시했다.
`이어서해`·`배포 이어서해`에 따라 같은 릴리스를 끝까지 완료한다. 새 승인을 반복해서 요청하지 않는다.
사용자가 중단한 소개 검수는 재개하지 않는다. 모든 서브에이전트·직접 CLI는 gpt-6.1-sol/xhigh다.

## Completed work / exact current state

- PR416 정상 병합: main cb6b719e5222064c0657b36d2b45a0efd573ff93. main CI38551249622 전체검사와 양이미지 발행 성공.
- 13앱 설정·양서버pull·웹키 일치 preflight, 11워커 drain, 직접5432 migration0076 exit0와 복제본복구 완료.
  실제 DB journal77; quality_rejections integer/NOTNULL/default0; 38,593행 backfill mismatch0/invalid0.
  소개 검수 not_before2100-01-01·lease없음 보존. 원래 migration.json이 실제 증거이며 재실행하지 않는다.
- 첫 배포의 text2만 cb6b719/나머지11은2b1bd31인 혼합 상태에서 SQL gate를 수정했다.
- SQL 후속 PR417 정상 병합: runtime **9baf31ab5c48d0104c913e53299b776cbd106679**.
  최종 PR CI38563244180과 main CI38563927498의 전체 검사·필수check·양 이미지 발행이 모두 성공했다.
- 양 서버 pull/13앱 정책·웹키·flags preflight 뒤 새 runtime으로 **13대상앱/18컨테이너 모두 교체 완료**.
  text→publisher→reviewer→crawler→maintenance는 각mini→M3→전체monitor gate를 통과했고
  scheduler2복제본과 웹mini2/M3 4복제본도 ready다. source5는 각각532개 runtime파일 hash가 일치한다.
  19단계실행시간합계277.03초이며 단계사이orchestration/이전코드/CI/migration대기는포함하지않는다.
- migration은 이미 검증한 결과를 재사용했다. 최종DB확인은journal77/quality컬럼존재/소개2100·미임대보존이다.
  공개 양웹health/홈200/새runtime참조/정적자산17개200/공개관리자404를 확인했다.
  정상password/CSRF로그인 뒤private크롤러탭200/13수집기·주/예비·최근실행·미측정대기 표시를 확인했다.
- HTMLtag purge는 기존토큰 Authentication error로 실패했다. 홈은DYNAMIC/private no-store이므로
  새SHA와자산을별도로검증했다. 기존PENDING인증항목을보존하고purge성공으로표시하지않는다.
- 이 완료기록은 README/PENDING/handoff/rollout의4문서를 정리한 docs-only 후속 기록이다.
  해당 PR 상태는 아래 head명으로 조회한다. docs-only main push는 새 이미지를 생성하지 않으며 runtimeSHA와 구별한다.
- 관리자 `/admin/status?tab=crawlers`: 전체13개수집기, 주·예비 인스턴스/작업줄, 마지막저장회차,
  재시도·오류·중단·미측정대기를 표시한다. 기존 조회를 재사용하며 이 UI의 추가migration은 없다.
  원시error/cursor/detail/토큰을 투영하지 않는다. failed스캔신호·오래된예비·독립요청오류 표시회귀를 수정했다.
- X는 공식API 수동파일럿이고 상시scheduler/공개HOT는 구현·활성화하지 않았다.
  로컬토큰으로 실제2요청HTTP200/10post/6publicmetrics를 확인했다. 목적승인은 아직 검증되지 않았다.
  로컬X토큰을 운영환경에 주입하지 않는다. 토큰파일은 저장소 밖600이다.
- 사용자질문: 80k는 로컬/CI 성능회귀용 가상데이터이며 운영에 삽입하지 않았다.
  실운영 약4.4만공개제품/8.9만근거출처는 총보유건수로 전체대기물량이 아니다.
  PC종료시 로컬Codex orchestration은 멈추지만 이미접수된GitHubCI/Dokploy작업은 서버에서 계속함을 안내했다.

## Modified files / key decisions

현재 SQL후속은 `lib/operations/worker-progress-query.ts`, `tests/integration/worker-progress-query.test.ts`와
문서handoff/rollout/PENDING이다. 기존 URL mode별식·agent WHERE·수요범위·버전·정책·집계·3초제한은 유지한다.
canonical URL fastpath는 원래식을 fallback하고14,407변형의DB비교에서차이0이다.
ai_public/현재버전5필드ai_current를MATERIALIZED로공유해중복정규화·긴PK반복조회를제거한다.
repository_ai_levels.repository_key의단일PK/NOTNULL에근거해seen LEFTJOIN은기존EXISTS와동일하다.
agent의동일UNION입력을agent_inputs MATERIALIZED로옮기고같은GROUPBY/min을적용해병렬locale정렬을없앤다.
실패진단은 전용TEST_DATABASE_URL에서만12초readonlyEXPLAIN의안전한plan/settings를출력하고sanitized57014로다시실패한다.
테스트외곽40초는진단용이며query3초/80kfixture는변경하지않았다.

이미병합된관리자파일은 crawler-activity/statuscomponents·CSS/page/OperationsCenter/actionlinks,
agent scan emitter·budgettests, 관련spec/plan/README이다. 이전CI deadline수정은
`lib/domain/evidence/providers/github.ts`와 `tests/integration/github-evidence.test.ts`다.
전체원래구현범위와실제검증은 `docs/operations/2026-10-14-pipeline-recovery-implementation.md`,
배포과정/실패내역은 `docs/operations/2026-10-14-pipeline-recovery-rollout.md`에 있다.

## Tests actually executed / failures

- 최종원래소스: 단위256파일2468통과, 관리자집중5파일59통과, Nexttypegen/TypeScript/i18n/lint/build/bundle exit0.
  lint는 기존vendor warning1. 번들home148.6/detail158.9/launch136.1KBbr, 기준선10%이내.
- 최신base통합 후 원래전체3shard143파일1546사례(464/444/638)통과, 기존todo1미실행.
  deadline수정 후 rootfullshard3는47파일638통과/todo1,120.48초. Pythondeploy23/CI scope4통과.
- 첫PR416 CI의deadline1실패는내부combinedabort검사누락을고정RED로재현/최소수정했다.
  hanging진입·취소원인·빠른반환·늦은응답후쓰기없음까지GREEN; 이후PR/mainCI전체성공.
- SQL PR417의CI38557315298/38558982971/38561746654는80k회귀만57014로실패했고병합하지않았다.
  로컬/운영성능개선과실제CI의최장주소fixture성능은구별했다.
  마지막실패의안전EXPLAIN3286.562ms: agent2241ms/AI1035ms; 병렬external locale sort가새주병목이었다.
- 최종agentinput집중은실제1파일15검사통과(잘못지정한없는두번째파일은검사수에포함하지않음).
  두파일lint0, rootTypeScript0/3.04초; 최종CI=true/TZ=UTC fullshard2는48파일446통과/66.12초.
  native최종리뷰CLEAN/directCLI No findings/OK는staticonly이며테스트를실행한것으로계산하지않는다.
  이후최종GitHubPR CI38563244180과mainCI38563927498 모든required검사/양이미지발행성공.
- 읽기전용동일snapshot A/B: originalprod4261.188→final1411.068ms/세집계전체동일/EXPLAIN1490.680ms.
  80k localcustom1070.842→925.507ms/generic1045.951→947.346ms 모두동일집계/정렬경로제거.
- 직접CLI8회모두gpt-6.1-sol/xhigh: 입력8,100,798(캐시7,424,128포함), 출력57,262.
  private review-usage.json이증거다. native사용량은추정하지않는다. read-onlyCLI의실행못한Vitest는통과로계산하지않는다.
- 전용localtestDB3개는모두중지했다. 사용자컨테이너는건드리지않았다.

## Remaining work / exact next commands

운영 배포·migration·실제runtime/관리자검증은 완료했다. 추가 앱 교체나migration/drain은 필요 없다.
완료 문서 PR은 `docs/pipeline-recovery-rollout-proof-20261014` head로 조회해 상태를 확인한다.
아래 읽기 전용 확인 외의 새 운영 작업은 PENDING의 장기관측·처리량·purge 인증 항목이다.

```sh
git status --short
gh pr list --state all --head docs/pipeline-recovery-rollout-proof-20261014 --json number,state,url
gh run view 38563927498 --json status,conclusion
# runtime 소스는9baf31a와동일해야함; 문서변경만있는main에서도실행가능:
python3 /Users/jr/.config/nomorevibe/releases/2026-10-14-progress-query-fix/release.py verify
```

source5는GitHubprovider/main을유지하고actualsourcefilehash로검증한다. shared8은immutable digest다.
환경·명령·복제본·키·기능flags·소개검수중단을보존하며token/settings/rawlogs를출력하지않는다.
main은PR/latestbasecheck필수이므로직접push/bypass하지않는다.

private evidence: `/Users/jr/.config/nomorevibe/releases/2026-10-14-progress-query-fix`(700/files600).
현재mixed baseline before.json은이미capture했으므로덮어쓰지않는다. rollout은19단계모두exit0다.
원래snapshot은이전상태복구증거로보존하며이번완료기록과혼동하지않는다. target/preflight/롤아웃체크포인트와
schema77재확인을연결한migration.json, safestats/plans/CLI사용량/actualtestreceipts가있다.
원래baseline/실행증거는 `/Users/jr/.config/nomorevibe/releases/2026-10-14-cb6b719`,
helpers는 `/private/tmp/nomorevibe-pipeline-release-20261014`와 `/private/tmp/nomorevibe-pipeline-implementation-20261014`.
Git useruntracked PT/assets/packages/prototypes/mistake.md는보존하고gitadd.하지않는다.

장기관측24h·capacity목표·backup복구·외부monitor수신·X목적승인/예산/연결품질/공개HOT는
이번배포완료와별개이며PENDING의미완료로유지한다.

이전 날짜의 상세 인계는 Git commit9baf31a의 이 파일에 보존돼 있다. 현재 문서는 이번 배포 완료 상태로 정리했다.

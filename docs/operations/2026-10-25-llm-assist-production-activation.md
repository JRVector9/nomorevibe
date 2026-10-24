# LLM assist 운영 활성화 — 2026-10-25

main `be71a75aade94858218faca0e2c012ed5dd69dc8`의 **17개 앱·22개 컨테이너 배포와 운영 처리 재개를 완료했다.** Capacity는 open, AI2는 items/epoch2/contract1이다. 6개 assist 모두 dispatch true/apply false이며, 업무 적체와 품질 관측은 계속된다. 자동 반영의 독립 사람 평가를 완료했다고 주장하지 않는다.

문서 날짜는 KST이며 별도 날짜가 없는 아래 실행·관측 시각은 **2026-10-24 UTC**다. 10월24일 기록과 아래 c486 표는 과거 단계다.

## be71 최종 배포·복구 확인

| 항목 | 실제 결과 |
|---|---|
| 코드·CI | [PR649](https://github.com/JRVector9/nomorevibe/pull/649) admission 수정, [PR650](https://github.com/JRVector9/nomorevibe/pull/650) macOS 경계, [PR651](https://github.com/JRVector9/nomorevibe/pull/651) historical owner 지원. [main CI40140565907](https://github.com/JRVector9/nomorevibe/actions/runs/40140565907) 전체 성공 |
| DB | Journal130개/최신0129. 0127·0128·0129는 실제 각각 한 번 적용하고 기존 제약·함수/OID·원장 불변식을 검증 |
| 실제 앱 | 17앱/22컨테이너. Worker 계열16컨테이너 각각998 source hash, web6 OCI revision/digest·health 확인 |
| 제어 | Open 확인23:23:07.114Z/audit19453, epoch1/rev2/policy ec1dd 유지. 원4잡 재개는 과거 audit19439–19442 한 번뿐 |
| 역할·AI2 | 5역할 primary ready/progress ok, scheduler fresh2, AI2 consumer source998/health exit0/실제 stop grace60초 |
| 기록·환경 | local-end16앱/child-group11앱, 16 caller 계약 환경, 모든 Nomorevibe autoDeploy=false 유지 |
| 최종 증거 | `actual-final17-verification-v2/verification.safe.json` SHA `b2ce36894ad6722b6bef28a526e74d626bdf49ab8920a58ed092fd9b077bc58a` |

```text
ghcr.io/jrvector9/nomorevibe-worker@sha256:fabaff6972ddadd16531b5c6886144ed0fd7ed01e2b43b00089c05ce9c4c637d
ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:2c90b0c80048a063f735585b3d0c1eb20b54b1c7b98683defeb80ee93bb67bfa
```

M3의07ef 요청은 원 owner의 실제 DB group 종료 기록과 현재 ingress·양 gateway·macOS launchd의 실제 종료를 구분한 v2 증거로 회수했다. Dry-run은 정확히 rollback했고 실제 apply는 한 번/audit19452, withdrawn/provider_boundary_exit/event·audit 각+1이었다. 원 charge/token/binding은 보존했고 settledAt은 NULL이며 모델 성공·usage를 만들지 않았다. 이후 Mac 새 PID34995/동일 source·설정/두 모델 loaded·health200, 양 gateway와 reviewer의 새 container·원 image/spec·health를 확인했다. 실제 종료·복구·migration·release marker는 재실행하지 않는다.

첫 Linux 종료 후 읽기 도구의 임의 container 선택 실패는 원문을 보존했다. 종료 코드를 추정하지 않고 해당 current owner만 별도 원복한 뒤 새 계획·새 프로세스로 진행했다. 수정된 도구는 같은 Engine의 bounded 후보·정확한 프로세스 identity를 검사한다. Mac의 느린 종료와 로딩은 제어 명령을 반복하지 않고 별도 읽기 확인으로 검증했다. 최종 웹 검증기의 NEXT_DEPLOYMENT_ID 누락도 실제 저장 fixture로 RED→GREEN 수정했으며 앱 설정을 다시 바꾸지 않았다.

의도적 draining 중 진행 감시는 publisher no_progress/primary_quarantined를 보고했다. 실제 예비 lease는 유효했고 격리는23:23:07Z에 자연 만료했다. 독립 Git6를 먼저 배포하고 정상 용량을 재개한 뒤 기존 progress·role 관문을 통과해 shared10을 배포했다. 강제 격리 해제·가드 생략은 하지 않았다. 모든 실행은 원 사용자 worktree를 보존한 별도 worktree에서 진행했다.

## be71 운영 관측과 남은 업무

최종 배포 검증 뒤 별도 관측 시작은 **2026-10-24T23:31:18.360Z**이며 open 시각과 구분한다. 실제 T0 DB 시각은23:31:18.911Z였다. unknown0/old generation0/native terminal 누락0, 5역할·scheduler2·AI2 health 관문 통과, findings=[]를 확인했다. 이 표본의0.551초 구간 native 정산은0건이며 이를 업무 품질 성공으로 세지 않는다.

T0 기준 소개99건은 done10/human13/나머지76, native25·공통 결과12·적용0이었다. 저장소42건은 human30/obsolete1/나머지11, native30·공통 결과1·적용0이었다. 감사11490은 원 표본·원 작업을 보존한 waiting_capacity/attempt0/common0/finding0이며, 누적 pre-dispatch withdrawn42건을 새로운 버그로 단정하거나 재등록하지 않는다. 감사의 work priority는 native 슬롯 우선권에 전달되지 않는다. 뉴스197487의 기존 original_name_missing 실패와202004·198055도 보존했다.

후속 T5/T10/T15/h6를 실제 due 뒤 각 한 번 읽는 background driver를 PID78284로 시작하고 source/T0 hash·시작 영수증·프로세스 생존을 확인했다. series는 `/Users/jr/.local/state/nomorevibe-be71-postrollout-observation-v1/series`, driver는 같은 root의 `driver-once`다. h6 due는 **2026-10-25T05:31:18.360Z (KST14:31:18.360)**다. 예약·프로세스 시작을 미래 관측 통과나 연속6시간 정상으로 보고하지 않는다. 실패/timeout이면 원문을 보존하고 자동 재시도하지 않는다.

자동 driver의 **T5는23:36:18.894Z에 실제 통과**했다. native 정산은 시작 후30건, AI2 검수는8건이고 unknown/구세대/terminal 누락은 모두0이다. 기존 역할·scheduler·AI2 health 관문도 통과했다. 소개는 done11/human16/나머지72, 공통 결과13/적용0으로 진행했다. 감사는 여전히 waiting_capacity/attempt0/common0/finding0이며 원 요청을 반복 등록하지 않았다. T5 파일 SHA는 `3d897ad50fad25ba25e1b689cfbb2eb722ce37778c85fadf63a14cacef6a0875`다. 표본 사이의 연속 상태·사람 품질 통과는 주장하지 않는다.

자동 driver의 **T10도23:41:18.849Z에 실제 통과**했다. 시작 후 native 정산69건·AI2 검수22건, unknown/구세대/terminal 누락0, findings=[]/기존 health 관문 성공이다. 소개는 done13/human19/나머지67·공통15/적용0으로 진행했다. 감사 원작업은 관측 시 claimed/attempt0/native waiting1/common0이며 아직 전송·업무 성공을 확인하지 않았다. SHA는 `f306bc6f409b57f3775602e199e27c92fbfc3340bcd9a4d5194bfd13ecdcda74`다. T15·h6는 후속 driver의 실제 결과로 확인한다.

독립 사람 holdout5건은 아직 미응답이다. Uptime은 confirm/확인 필수, 나머지5개는 shadow이며 자동 반영은 모두 false다. Native 정산·개발 테스트·운영 health는 사람 평가를 대신하지 않는다. [테스트·배포 시간 검토](2026-10-25-deployment-time-review.md)는 실제 앱 갱신9분59초, 테스트 중복·검사 범위·병렬화·단계 축소 방안을 분리해 기록했다.

## c486 초기 배포와 제어 기록 — 과거

| 항목 | 실제 확인 결과 |
|---|---|
| 코드 | [PR648](https://github.com/JRVector9/nomorevibe/pull/648), main `c4864a844f60b5855f3cd3fc45564e53d70b4287` |
| CI | [main run40124571973](https://github.com/JRVector9/nomorevibe/actions/runs/40124571973) 전체 성공, web/worker 이미지 발행 성공 |
| DB migration | c486 최초 배포 때 journal127개/최신 `0126` 적용. 이후 앱c486 유지 중 `0127`·`0128`을 각각 한 번 적용해 journal129개까지 진행 |
| 배포 | Git6 완료20:34:51Z → shared10 완료20:36:33Z → monitor 마지막 완료20:37:32Z. Inventory complete=true / pending=[] |
| 실제 컨테이너 | Worker 계열16컨테이너 전체994 source hash, web6 OCI revision/digest/health, 전체17앱22컨테이너 검증 |
| 용량 정책 | 27 route, 최초 open20:44:28.988Z / audit19438 뒤 복구를 위해 draining22:21:31.082Z / audit19450, epoch1 / revision2 / policy `ec1dd63d9264ae29a1df2c6cdb70ac54a4d1adb2ef4898c9f2370d69c3fbf9f0` |
| 일반 잡 | 점검 pause19431–19434의 원4잡만 CAS 재개, audit19439–19442. NotBefore NULL·요청·cursor 보존 |
| AI2 | Items / epoch2 / writer contract1. 실제 독립 consumer와 owner·child group 기록 확인 |
| Assist | Uptime confirm·확인 필수, 나머지5개 shadow. 모두 dispatch true / apply false |

```text
ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:9582b683754200514916750281c054c50a25b8277f75028d1b56b2ab4b21b691
ghcr.io/jrvector9/nomorevibe-worker@sha256:0e6aa1baa0a42052500ef372ca7e2177f13f287185b46cb32afea85dbea8e6c5
```

다섯 역할과 scheduler2의 ready/progress, 양 웹 직접·공개 health, HTML purge를 확인했다. Monitor는 새 컨테이너 이후 primary/external UP receipt를20:37:31Z에 확인했다. 전체 Nomorevibe 앱의 autoDeploy=false를 유지한다.

로컬 종료 기록은16앱21컨테이너, child-group 기록은11앱11컨테이너에서 실제 활성 플래그를 대조했다. AI2 실제 Swarm stop grace는60초다. 새 AI2 owner의 owner_opened→spawn_intent→spawned와 PID/PGID38이 실제 child 환경·native9건의 owner/binding에 일치했다. 9건 모두 upstream terminal/usage로 정산됐다. Owner attestation=false와 local-end0을 실제 종료 증거로 해석하지 않는다.

웹의 GA_PROPERTY_URL은 배포 전부터 API의 unquoted # 뒤가 Docker 환경에서 주석으로 해석됐다. 이전 두 웹의 원문·해시와 같은 렌더링임을 입증하고 이 한 키만 고정 예외로 검사했다. 다른 환경·명령·mount·OCI·health 관문은 유지했고 이 점검으로 GA 설정을 변경하지 않았다. M3 공통 그룹 예산1은 장비 전체의 atomic semaphore를 의미하지 않는다.

## 미확정 요청 복구와 모델 서버 수정

이전 AI2 요청 `2bfed63a-42d5-4255-ae42-e7c61543a104`는 timeout 후 원격 terminal이 없는 indeterminate였다. 실제 이전 AI2 owner·양 gateway·Supa engine 전체 종료와 원 PID/cgroup 부재를 입증한 뒤, 새 migration0126의 제한된 단건 경로로 withdrawn/provider_boundary_exit 처리했다(audit19437). 모델 terminal·upstream usage와 업무 결과는 생성하지 않았다. Terminal_evidence에는 실제 경계 종료의 provider_boundary_exit proof/hash만 저장했고 settledAt은 NULL이다. 이후 네 서비스를 복구하고 후속 릴리스를 배포했다. 이 단건 복구·중단·복구 marker는 반복 실행하지 않는다.

abcLLM [PR6](https://github.com/JRVector9/abcLLM/pull/6)의 response_format 전달을 양 gateway 새 컨테이너에서4개 source hash·health200으로 확인했다. 점검용 autoDeploy=false는 원 true로 복구했다. Supa 출력3000·라우팅·모델 시간 제한은 유지했다.

oMLX GPT-OSS에서 실제 Harmony return 토큰이 grammar EOS로 마스킹되어 length 종료·중복 JSON이 발생했다. 실제 tokenizer가 Harmony end/return 쌍인 경우에만 grammar EOF를 매핑하고 final return을 종료로 처리하는 immutable overlay를 설치했다. Server source `e442b3d57f6f…`, grammar `c9904fde07ab…`, entry `422a80d6dcfa…`다. 기존615 source 중613·grammar281·모델/settings/plist를 보존하고, atomic entry 전환과 SIGTERM1회 뒤 old PID11113 종료/new PID66193을 확인했다. 실제 native4매핑·cache·health·loaded2를 확인했다.

같은 max128 wire의 패치 후 protocol은 HTTP200 / finish stop / schema 유효 / usage81+30 / warning 없음이었다. 누적4회는 원 Supa PASS, M3 length 실패2회, 패치 후 PASS1회이며 원 실패를 보존한다. Schema·전송 준비를 감사 업무 성공으로 세지 않는다. 이에 따라16 caller 앱의 정확3개 계약 환경 키만 stage하고 실제 배포 환경을 검증했다. Qwen 계약·27-route 정책·한도는 유지했다.

## 작업별 업무 상태

| 작업 | 실제 실행 | 남은 확인 |
|---|---|---|
| Uptime·복구 | Fresh 근거와 기존 CAS로8+2개 seeded 복구. 현재 기능 실패3개는 차단 유지 | 새 판정 품질·장기 재발 관측 |
| Repo 이전 | 비보호42개 fresh HTTP 관측·기존 producer 등록 완료. 제품 상태 변경0 | Native·공통 결과. 기존 invalid quote/human은 보존 |
| 소개 재검수 | Sonnet 원행·attempt 보존, 명시 작업50+49=99개 등록 | 후속 제안·검증. be71 T0 done10/T5 done11이며 전체99개 완료 전 |
| 표본 감사 | 원주2026-10-19의 비어 있지 않은 표본 생성. Fresh 증거 확보 뒤11490 원작업만 requeue(audit19445) | 현재 waiting_capacity / attempt0 / common0 / finding0. 재등록 금지 |
| 뉴스 | 기존202004 invalid_evidence_quote·198055 original_name_missing 보존. 수정 prompt 배포 후 미사용197487을 기존 producer로1회 등록(audit19447) | 20:54:29Z dispatch→20:54:36Z native settled(stop/usage4262+950), 이후 human / attempt1 / original_name_missing / common0 / draft0. 실패 행 재설정·197487 재등록 금지 |
| 의미 예외 | Shadow·dispatch true / apply false | 새 미사용5표본의 독립 사람 라벨 미응답 |

## 실제 확인한 assist 진행 결함

운영 잡 ACK 성공과 일반 native 정산이 증가했지만 감사·뉴스에는 native dispatch가 없었다. 원장·이벤트·job 실제 시각과 코드에서 두 원인을 확인했다.

1. Capacity deferred 후 잡은 끝나고60초 뒤 재실행된다. 다른 caller가 그 사이 waiting을 reserved로 바꾸면30초 예약이 다음 실행 전에 만료한다. 뉴스197487의 요청은20:50:31Z queued,20:50:49Z reserved,20:51:19Z 만료 기한,20:51:21Z 실제 reservation_expired였으며 dispatch/binding은 없었다.
2. Defer가 prepared input을 지우고 다음 collection이 관측 시각을 새로 만들므로 input hash/workKey가 바뀐다. 동일 audit11490·owner/boot의 연속 요청이 서로 다른 hash를 가져 기존 pending을 찾지 못하고 logical fence에 막혔다. 두 원요청은 waiting 상태에서120초 큐 만료로 끝났으며 native0이었다.

Assist 두 호출에만 기존 signal/tick 기한 안의 admission polling을 적용해 같은 claim/input/request를 유지하고, 전송 전 포기할 때 자기 unbound waiting/reserved만 control mutex 아래 정리하도록 수정했다. Waiting 취소는 실제 대기 취소임을 기록하는 wait_cancelled 이벤트로 구분해 슬롯 반환 집계를 왜곡하지 않는다. TTL·모델 재시도·시간 제한·정책 한도는 늘리지 않고 dispatched/indeterminate/bound 요청은 취소하지 않는다. 수정은 [PR649](https://github.com/JRVector9/nomorevibe/pull/649), commit3002fe53에 고정했다. 관련unit35·실제PG72·typegen/tsc/scopedlint와 독립 리뷰를 완료했고, 첫 [CI40133505043](https://github.com/JRVector9/nomorevibe/actions/runs/40133505043)는 기존 fixture2개 때문에 실패했다. 두 테스트만 수정한 후속 commit5a37d93c에서 실제 RED2→GREEN2·관련PG65개·타입/lint 검증과 독립 리뷰를 마쳤고, [새 CI40134327058](https://github.com/JRVector9/nomorevibe/actions/runs/40134327058)는 전체 성공했다. 21:35:51Z main0c9dd1a2로 병합했고 main CI40134926200 필수 검사와 새 web/worker 이미지 발행도 성공했다. 운영0127은 실제 한 번 적용했고 기존 CHECK 보존을 검증했다. 새 Git7/API17 baseline 수집 뒤 재배포 전 확인에서 M3의 새 미확정 요청이 발견돼 경계 종료 지원을 보완했다. 이후 be71의 최종17앱 배포를 완료했다. 기존claim/tick/runner deadline 중 가장 이른 기한과 전송 여유5초를 지키며 native HTTP 재시도를 추가하지 않는다. 최종 CI·배포 결과는 위 be71 확인 표를 따른다.

## 새 M3 미확정 요청

재배포 전 실제 원장에서 `07ef95d7-4f7a-4064-8928-bf5cb81c7970`을 확인했다. AI1/m3-reviewer/GPT-OSS 요청은21:18:09.977Z 전송 후21:18:11.298Z transport_unknown이 됐다. 업무 시도114534는 gateway_error이며 구체 HTTP 원인은 미확정이다. 정확한 local-end 기록2616과 이전 child-group 종료23은 있지만 모델 terminal·usage는 없다. HTTP 종료·오류 callback 횟수1을 모델 종료로 취급하지 않는다.

기존 회수는 입증된 provider hard deadline이 없어 정당하게 차단한다. macOS launchd/oMLX의 실제 프로세스 경계 지원은 PR650/main253d2517에 병합했고 migration0128을 실제 한 번 적용했다. 새 mainCI40138059095의 검사·이미지 발행도 성공했다. 종료 전 fresh 수집에서 원 reviewer 컨테이너가22:17Z 자동 교체됐고 원 컨테이너·Swarm task가 수거된 사실을 확인했다. 원 startTicks/PID namespace를 재구성할 수 없어 기존 strict 경로가 정상 거절했다. 원 owner boot의 durable group 종료를 동일 트랜잭션에서 검증하고 현재 ingress의 실제 종료를 별도로 요구하는 경로를 PR651로 추가했다. 이전 Supa 증거를 재사용하거나 가짜 cgroup/namespace를 넣지 않는다. 이 요청은 위 be71 복구에서 실제 한 번 회수·서버 복구를 마쳤다. 아래 c486 T0–T15 뒤에 생긴 사건이므로 과거 표본의 unknown0을 다른 시각으로 연장하지 않는다.

## C486 릴리스의 완료된 관측

기준은 capacity 재개 후20:45:00Z다. DB와 health 관문은 각각의 실제 실행 시각이며 표본 사이의 연속 무오류나6시간 완료를 주장하지 않는다.

| 표본 | 실제 DB 시각 | Native 정산 누적 | AI2 검수 누적 / pending | unknown / 구세대 / terminal 누락 |
|---|---|---:|---|---|
| T0 |20:45:30.517Z|9|4 / 1|0 / 0 / 0|
| T5 |20:50:07.988Z|35|12 / 6|0 / 0 / 0|
| T10 |20:55:09.802Z|60|22 / 2|0 / 0 / 0|
| T15 |21:00:09.691Z|90|28 / 4|0 / 0 / 0|

T15의 dispatched1은 정상 진행 중인 호출이며 종료를 주장하지 않는다. 각 완료 표본에서5개 역할 ready·scheduler fresh2·progress ok·AI2 source994/health0을 확인했다. Native 정산과 업무 성공은 별도이며 위 감사·뉴스 common/draft는0이다. 뉴스197487은 T15 전에 한 번 실제 전송됐지만 original_name_missing으로 거절됐으며 정산과 품질 통과를 구분한다. T0의 로컬 다중행 JSON 파서 실패는 원 DB raw를 다시 조회하지 않고 stream parser로 읽고 별도 health 관문을 실행해 보완했다. 원 실패·raw·실제 두 실행 시각을 보존했다.

이전 e0ef 릴리스17:19–17:33Z의15분4표본과 현재 series를 합산하지 않는다. c486 open 시각의6시간 뒤는 **2026-10-25 02:44:28.988Z(KST11:44:28.988)**지만 중간에 draining과 교체가 있었으므로 c486의 연속6시간 정상으로 해석하지 않는다. be71은 위의 별도 관측 series를 사용한다.

## 보존한 증거와 다음 단계

원문·인증·환경 값은 비공개 경로에 보존하며 이 문서에 복사하지 않는다. Private base는 `/private/tmp/nomorevibe-llm-activation-20261024/`다.

- C486 당시17앱: `/Users/jr/.local/state/nomorevibe-final17-harmony-c486-20261025-v1/actual-final17-rendered-ga-v1/verification.safe.json`, SHA `68c42fada25f4f81183cb834128102e72e397154544a77e4d0788bade3ee34e1`.
- 경계 종료: `provider-boundary-operation/execution-c486-127-20261025-v1/`와 단건 release audit19437. 중단·복구·migration marker 재실행 금지.
- Protocol4 성공: `schema-canary.protocol-four.success.safe.json`, SHA `90fbd720d9c4a838889bb3cc9e89170df0d5300415496c385b840ad555265586`.
- C486 당시 open/원4잡 재개/감사·뉴스1회 등록: `final-activation-operations/c4864a844f60b5855f3cd3fc45564e53d70b4287/`.
- C486 최종4표본: `/Users/jr/.local/state/nomorevibe-c486-observation-20261025-v1/OBSERVATION_RESULT.safe.json`, SHA `b9423f5ea578434896cc20b6e0162498521235ca453d789b2393767c2395d267`.
- C486 표본: `/Users/jr/.local/state/nomorevibe-c486-observation-20261025-v1/`의 각 observation.safe.json. 과거 릴리스와 구별한다.
- 실제 recorder: `postdeploy-recorder-business-readonly/`의 owner/native·childgroup 관측. Admission 결함은 `postdeploy-capacity-block-readonly/current-v2.safe.json`과 `exact-audit-pair.safe.json`.

Admission 수정은 회귀·독립 리뷰·필수 CI·main 병합·0127 적용을 완료했다. 경계 종료 지원·회수·새 main 고정17앱 배포는 완료했다. 이미 등록한 감사의 native/공통 결과와 적체 처리는 위 be71 series에서 계속 관측한다. 독립 사람 holdout·장기 관측은 실제 결과가 생겨야 완료된다. 모든 assist apply는 그 전까지 false를 유지한다. 썸네일은 최초 인계의 보류 범위다.

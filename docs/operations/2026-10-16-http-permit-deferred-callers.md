# 공유 HTTP permit 대기 호출자 처리 (PR07c)

운영 enable·배포·외부 HTTP 검증은 수행하지 않았다. PR07b의 기본 disabled 경로와 transport/장부/0079는 그대로다.

| 실제 경로 | permit 대기 처리 | 기존 정상/사이트 실패 처리 |
| --- | --- | --- |
| 등록 URL·소유권 파일/메타 확인 | typed 오류 전파 → 실제 API route 503 | unreachable/verification_failed 응답 유지 |
| 등록·발행 완료 뒤 부가 OG | 성립한 성공·발급 키 보존, 기존 thumbnail job 요청 | 기존 OG null/캐시 성공 유지 |
| 썸네일 resolver/worker | fallback·시도·캐시 쓰기 없이 전파, 병렬 작업 모두 정산 | 일반 이미지 실패 fallback 유지 |
| README 본문/캐시 | 부정 캐시 없이 전파; 같은 8초 abort 뒤 실제 Promise 정산 | 실제 다운로드 실패 unavailable 캐시 유지 |
| 뉴스 | 대기 출처의 실패/cursor를 기록하지 않고 모든 진행 작업 정산 뒤 전파 | 일반 feed 실패 cursor 유지 |
| 저장소 재검수 meta refresh | 대기를 링크 부재·제품 실패 근거로 사용하지 않음 | 관측한 HTTP 상태와 일반 incomplete 처리 유지 |
| crawl fetch | 기존 frontier 반환 후 명시 deferred | 일반 budget·quota 경로 유지 |
| 근거 수집 source/media·강제/주기 job | 기존 진행 checkpoint 보존 + optional deferred 전파 | 일반 source 실패/backoff·부분 결과 유지 |
| README fallback·review-document·AI1·Show HN | 기존 전파를 회귀로 확인; 대기를 README 없음/인증 fallback/model dispatch로 소비하지 않음 | 기존 흐름 유지 |

사이트 지문의 abort→null 수동 race도 실제 permit 오류 정산을 기다린다. 후속 PR08의 입력/정책 CAS와는 별도 변경이다. reader/native 정산·crash 복구를 새로 증명하는 변경은 아니다.

`runJob`은 handler의 `HttpOriginPermitError` 또는 명시 `deferred:"http_origin_permit"`만 미처리로 남긴다. heartbeat 정산 후 현재 job token을 DB wall로 확인하고 lock/token만 해제한다. producer request/processed, 현재 cursor, pause/notBefore, 과거 성공/실패 이력은 유지한다. 정상 done:false는 기존처럼 ACK한다. claim 자체의 runs/lastRunAt/updatedAt 갱신은 종전대로 발생한다. 소유권을 잃었으면 이전 실행이 새 token을 수정하지 않는다.

API 503은 일반적인 임시 이용 불가 문구와 request_id만 노출한다. 이미 저장한 등록의 editToken을 잃는 503으로 바꾸지 않는다. 일반 rate limit과 SSRF 거절, 실제 4xx/5xx·사이트 실패 규약은 유지한다.

운영 활성화에는 PR07b 고정 host 등록·instance 매핑·native 종료/미확정 점유 정책과 전체 통합 검증이 여전히 필요하다. 이 PR의 테스트는 외부 transport를 모의한 실제 caller 및 전용 로컬 DB runner/CAS 범위이며 실제 인터넷·멀티 host 운영 합격 증거가 아니다. DB 작업·선행 완료된 출처의 사실 쓰기는 이미 완료될 수 있으므로 batch 전체 rollback을 주장하지 않는다.

## 최종 리뷰와 영향 검증

B의 독립 읽기 리뷰에서 추가 production P1/P2는 없었다. 기존 news-refresh 원행 복원 fixture는 실제 JSON 이중 인코딩22023 Assertion RED1을 재현한 뒤 `$1::text::jsonb` 한 곳 수정으로 같은 신규·영향2case PASS/7skip1.15초, tsc/scopedlint0을 확인했다. 원8case 전체는 반복하지 않았다. 보고 `/tmp/nomorevibe-pr07c-b-news-restore-final-report-20261016.md`.

root는 C의 production diff/runner 실제 driver·로그와 해시를 검토했다. 기존 fingerprint integration의 미정산 mock2개만 실제 Promise를 정산하도록 바꿨으며 시간 한도·무기록 기대는 유지했다. 이 기존 파일은 전역 resetTables fixture라 원복 검증 DB와 분리한 새 loopback55526에서만 실행했고7PASS/1.46초 exit0이다(`/tmp/nomorevibe-pr07c-root-fingerprint-green-20261016.log`). 전체 테스트가 아니다.

원55523은 root가82개 table rawµs/ACL/catalog/settings exact readback exit0 확인 후 정상STOP(exited0/OOMfalse)하고 자기 container/volume만 제거했다(`/tmp/nomorevibe-pr07c-root-cleanup-20261016.json`). 이미 제거한55523에 재접속하거나 재생성하지 않는다. 새55526의 기존 표준 fixture 잔류는 readback 뒤 정상 STOP/exited0/OOMfalse/자기 volume 제거로 처리했으며 이를 raw baseline 복원으로 주장하지 않는다. 운영 활성화·배포는 하지 않았다.

## 필수 CI 잠금 실패의 제한된 조사

최신main 통합head9d649c55의 CI38836281314는 quality/통합1·2 성공, 통합3 first-final in-flight human 1case가 raw55P03로 실패했다. 원SQL/holder가 CI로그에 없어 원인은 미확정이다. 새 own55528에서 원본문 human/input2case는 actual2PASS/13skip(3.74초 total). 실제 relation holder128→provision129/CREATE TRIGGER ShareRowExclusiveLock 대기→55P03 합성진단은 가능한 메커니즘만 보여주며 CI원인/운영결함 증명으로 세지 않는다.

원 test15본문/기대값·timeout/production을 그대로 두고 test prepare/run/release 실패의 고정 phase/SQLSTATE/allowlisted operation·관계명/PID/state/wait만 진단하도록 보강했다. rawSQL/메시지/파라미터/암호/env출력0, 진단도 실제await뒤 원error동일재throw. 최종source SHA `1a4a6d5591697ded6c3bf340a1ba2cb7075d22d8a497f86b75e7987c79f5822b`. 같은2case2PASS/13skip4.47초·tsc/scopedeslint0; 원455 unit221/actualrunner8 및 전체suite/build는 재실행하지 않았다. 보고 `/tmp/nomorevibe-pr455-a-first-final-ci-report-20261016.md`, logs `...-pair-diagnostic-green-...`, `...-scoped-eslint-...`, `...-tsc-...`.

Root는 전체 diagnostic diff/보고/원실패로그를 직접 읽었다. own55528 finalreadback도 독립 비교해 replay schema/roles/trigger0·다른연결0·items0·3stagelegacy1contract0·defaultACL/timeouts와 fixture2doc/1candidate/1attempt/1job을 exact확인했다. 일반 fixture 행이 남은 사실을 보존한 뒤 정확 owncontainer 정상STOP/exited0/OOMfalse/container+exclusive volume제거0. `/tmp/nomorevibe-pr455-root-cycle-{readback,cleanup}-20261016.json`. **55528 재접속/재생성 금지**. 초기resource생성전 실패반환 미확인 실수는 A보고에 기록됐고 타자원사용0이다.

다음 필수CI에서 실제실패가 생기면 이 안전한 진단으로 phase/SQL을 확인한다. 지금은 원인수정 완료라고 주장하지 않으며 timeout증가/재시도/기대삭제0, 운영배포/DDL/활성화0이다.

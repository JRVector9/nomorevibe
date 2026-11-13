# 배포 차단 요청의 하위 워커 종료 복구 · 2026-11-13

PR: https://github.com/JRVector9/nomorevibe/pull/935 · 격리 브랜치 `xaegis/7c0784db` · base main `25824182`.

## 확인한 원인

요청 `69781c87-fc49-40d6-af75-db39343102a7`은 `product-search-verify`/`supa-direct`, owner `m3-text`/`c861b385-c3cd-4592-af5e-a6ea7eb6beb6`다. 05:36 UTC에 전송 중 상태와 같은 boot의 살아 있는 역할 lease를 재확인했다. 운영 소스 `capacity-overdue.ts`·`capacity-repository.ts`는 release `5b058e83`과 해시가 일치했다.

요청 전송은 00:04:45.742 UTC, 그때 호출할 수 있었던 child seq1(run `ad0e0a40…`, PID 51)의 `group_exited`는 00:05:17.815 UTC다. 이후 seq2(PID 3702)는 00:05:17.845 UTC부터 시작했다. 하위 워커 교체가 메모리의 overdue 추적을 잃게 했으나 상위 감독은 같은 owner boot로 역할 lease를 계속 갱신했다. 기존 owner-gone의 live-lease 거절은 올바르지만, 이 경우를 해결할 별도 경로가 없었다.

작업 중 05:44:47 UTC에 기존 seq2도 종료됐으며 text 컨테이너가 다른 작업에 의해 교체됐다. 이 작업에서 재시작한 것이 아니다. 05:46 UTC 재조회에도 해당 요청은 dispatched, 접수는 OPEN, epoch1/revision36이었다. 이 변화를 감지해 이전 컨테이너를 대상으로 쓰기를 실행하지 않았다.

## 변경과 선택

추가 서비스 재시작 대신 저장된 **실제 child 종료 근거**를 사용하는 방법을 선택했다. 영향 범위를 요청 한 건으로 제한하고 전체 서비스 중단·한도 변경을 피하기 위해서다.

- 새 `mark-exited-caller` 명령은 명시한 요청 ID만 최대 20건 처리하며 기본값은 dry-run이다.
- DR writer fence SHARE → 요청 UPDATE 잠금 → 같은 DB clock으로 프로세스 그룹 기록을 다시 판정한다. lock 1초/statement 5초/transaction 15초 제한을 유지한다.
- 기존 `evaluateLocalCallEnded`를 재사용해 dispatch 시점까지의 모든 spawn-intent 번호와 run/PID/exit 일치를 확인한다. 후속 boot 관측은 기존 동일 커널·PID namespace 검증을 유지한다. 이후에 시작한 child는 이전 요청의 호출자로 취급하지 않는다.
- 실제 종료 기록이 전송 이후이고 현재 시각 이전인, 허용된 HTTP gateway binding과 binding hash가 있는 요청만 받는다. CLI/native·미결 child·기록 공백·미확인 종료는 거절한다.
- 전환은 `dispatched → indeterminate`, reason `process_exit`, evidence `caller_process_exited`다. event와 감사 `model-capacity-caller-exited`를 같은 TX에 남긴다. provider 종료·성공·사용량을 만들지 않고 token/binding/terminal/settled_at을 보존한다. 기존 unknown hold와 늦은 정산 규칙도 유지한다.
- maintenance의 기존 유한·공정 스캔에서 이 경로를 먼저 확인한다. 현재 singleton owner 및 유효한 maintenance 잡 lease를 잠금 후 다시 확인한다. 기존 owner-gone 판정과 조용한 시간 조건은 그대로다. 스캔의 30분 나이는 후보 선택일 뿐 종료 증명이 아니다.

## Oracle의 한국어 검수 순서

`docs/operations/2026-10-28-oracle-korean-discovery.md`와 `lib/crawl/korean-discovery` 경로를 확인했다. 검색어/공유 검색 결과에서 후보를 먼저 staging에 저장하고, 설명·README의 실제 한국어 문장을 판별한다. `yes`만 M3 `crawl-ko-apply`가 공통 수집 큐로 넘긴다. 대기열에는 미판별 `unknown`도 포함된다. 한국어 판정은 한국인 제작자·한국 소재 보장이 아니며, 제품 여부·AI 근거·일반 규칙 심사·공개 발행은 후속 단계다.

## 실제 검증

Node24.18.0에서 범위 단위 3파일 37건 통과. 새 전용 PostgreSQL17/pgvector0.8.6 컨테이너 `nmv-blocker-7c0784db`의 loopback 32798 DB에서 owner/caller 복구 10건, 기존 실제 search-verify dispatch 17건이 통과했다. 같은 live supervisor·동시 적용 한 번만 전환·dry-run 롤백·장부 보존·다른 owner 거절·잡 lease 소실 거절·자동 maintenance 경로를 포함한다. Next typegen, 전체 tsc, 변경 7파일 ESLint, diff 공백 검사도 통과했다.

처음 추가한 fixture의 jsonb 매개변수 이중 인코딩, jobs token의 varchar/uuid 비교, 누적 append-only 이력 조회에 boot 조건 누락으로 테스트가 실패했고 fixture를 수정했다. 실패 로그를 별도로 보존했다. 단위 첫 실패는 successor method fixture 오기였다. 운영 코드 오류나 성공으로 재분류하지 않는다. 수동 전체 unit/DB·build·브라우저는 실행하지 않았다. GitHub 필수 CI와 운영 복구 결과는 아래에 실제 결과로 기록한다.

## 운영 결과

복구 실행 전. 앱 배포·병합·capacity mode/정책/한도 변경 없음.

# PR460 검수 records fixture의 jobs 격리

역할 전환 테스트가 실제 전역 drain을 거절한 원인은 앞선 검수 records 테스트 마지막 case가 직접 만든 healthy crawl-agent-review lease를 남기는 경로였다. 전역 drain guard와 원20case 본문·기대·시간제한을 유지하고 fixture jobs lifecycle만 보강했다.

## 변경

고정4 jobs(crawl-agent-review/crawl-fetch/crawl-publish/second-review)의 기존 raw baseline을 저장한다. healthy 기존 소유자가 있으면 준비를 거절한다. 원래 있던 행은 exact raw CAS UPDATE, 없던 행은 ON CONFLICT DO NOTHING+RETURNING1로만 준비한다. 경쟁 충돌은 준비 transaction 전체를 rollback한다. 전역 jobs DELETE는 제거했다.

정리는 고정행 잠금과 fixture 소유권/runner counters/history 검사 뒤 실행한다. 기존행은 jsonb_populate_record로 원 µs/cursor/pause/history를 in-place 복원하고, 원래 없던 fixture 소유행만 exact 현재 raw CAS로 삭제한다. 미등록 token/실제 runner는 정리하지 않고 오류를 전파한다. 원19it선언/expanded20case의 첫 it 이후 본문 전체는 SHA bd72b4c54d45a8bb02a09b8ef5c0a26738fd782f895f7730aa7b0de863767619로 동일하다.

## 실제 좁은 검증

C가 전용55536에서 원 records 마지막1 PASS 뒤 원 batch drain1 FAIL(:173 job_batch_not_drained)을 재현했다. 최소 fixture 보강 후 같은 pair 각각1PASS. 별도 nonempty baseline의 unmanaged healthy sentinel·관리행 원µs/cursor/pause/history 전체 jobs raw equality control도 PASS.

B 독립리뷰가 사전 부재 fixed job의 동시 생성 경쟁 P2를 발견했다. 실제 두PID와 runJob을 setup검사→첫DML 사이 barrier에 넣자 원 upsert가 healthy runner의 runs1/token을 reset하여 AssertionRED 및 job_lease_lost가 발생했다. 기존행 rawCAS/absent DO NOTHING 보강 후 동일 주입·case·기대가 GREEN1, whole runner raw 보존·setup rollback·runner 정상 deferred 정산을 확인했다. 최종 보강 후 원 records 마지막1도 PASS. 지정 tsc/eslint actual exit0. 최종 source SHA27ab537a6be055877df9f8549c6deb61ea0215f2f482f8db8c2ea56e24b3feba.

원20case/전체17batch case/수동전체suite/build/typegen은 재실행하지 않았다. 사용자 지시에 따라 전체 검사는 모든 PR 개발 후 실행한다. CI의 원1FAIL/753PASS·item5timeout은 보존했으며 개선 후 필수CI로 확인한다.

## 증거와 실패 접근

C 보고 /tmp/nomorevibe-pr460-c-records-fixture-final-report-20261016.md, B 보고 /tmp/nomorevibe-pr460-b-fixture-independent-review-20261016.md에 정확한 명령·raw proof·원로그가 있다. C 첫 ANY 배열42809 setup오류, B /tmp copy생성 assertion/옛copy재실행은 별도진단으로 보존하고 기능RED/정상pair 증거에서 제외했다.

root는 최종 파일/diff를 직접 읽고 실제DB를 독립 readback하여 B final과 exact를 확인했다. public89, jobs0/raw exact·stage µs·catalog/ACL/role/schema/column/function/trigger/settings·83journal/default exact, 다른연결0. 원 records driver의 domain/append-only감사6table 실험 delta는 보존하여 whole raw equality=false로 기록했다. foreign업무행을 임의복원·삭제하지 않았다.

/tmp/nomorevibe-pr460-root-final-fixture-readback-proof-20261016.json 및 ...pr460-root-fixture-cleanup-20261016.json: 정상STOP/exited0/OOMfalse 뒤 자기container/volume만 제거했다. 55536은 retired/재접속0. 운영DDL/배포/실모델/consumer활성화0.

# HTTP rival fixture 관측과 실패 정산

기존 CI38861807082(PR453)와38861009681(PR460)의 통합3은 HTTP rival.result 및 cleanup allSettled가 끝나지 않았다. 새 변경은 그 내부 단계를 관측하고 실패 child를 실제 정산한다. Production transport/permit/pool, 원20case의17callback 본문, 원100ms/test20초/hook60초는 바꾸지 않았다. 기존 CI의 내부 원인 확정이나 해결을 주장하지 않는다.

Worker는 DB 최초 접근 전에 application_name만 parent/child PID로 구분한다. 고정 IPC phase는 native fetch/end/reject·PG end·disconnect를 구분하고 parent는 actual close까지 소유 기록을 보유한다. 별도 read-only observer는 정확한 child 라벨의 모든 PG PID/state/wait/blocker만 조회하며 URL·SQL·행·credential은 출력하지 않는다. timeout signal 관측은 명시 opt-in이며 첫 실제 실행은 OFF다. 관측 연결이 실행 timing/부하를 바꿀 수 있다는 제한을 둔다.

Vitest가 이미 실패로 판정한 body는 실패를 유지한 채 abort/consume을 요청한다. Await 전에 독립 TERM1초/KILL2초를 설치하고 actual close와 IPC/stdio/work 정산을 기다린다. 강제 종료는 오류로 보존하며 HTTP permit 정상 반환 증거로 사용하지 않는다. 정상 result 이후 close가 멈추면4초 fixture settlement 오류를 먼저 남긴다. Child/관측 work 정산과 정확한 DB label의 backend0을 확인한 뒤 기존 fixture DB 복원을 수행하고, DB 실패 시 소유 기록을 유지한다.

실제 범위 검사:

- Root 전용55558/timeout observer OFF: 원 unread1+cancel/follower1 각1회, 2PASS/18skip/6.98초/exit0. Held child→PG108 idle/ClientRead/blocker[]를 관측했고 rival은 fetch.begin→약102ms 뒤 reject→PG end→disconnect→actualclose였다. 강제 종료0.
- 실제 TERM 무시 tinychild의 동일 exact-AST helper driver: 원 helper는 watchdog이 필요해 AssertionRED/exit1, 최종 helper는 자체KILL/actualclose/잔류0/강제종료 오류 보존으로 exit0. DB/permit 증거와 구분한다. 최초 불완전 expect harness 결과는 제외했다.
- 두 파일 scoped TSC·ESLint exit0. Root 직접 리뷰/A 독립 추가P1/P2=0. 마지막 cleanup 기록 보유 위치 수정 뒤 native driver/static만 확인했고 DB 두 case를 반복하지 않았다. 실제 Vitest body timeout→afterEach→drain 전체 통합 조합은 미실험이다.
- Root 독립 readback은87표 raw(µs 포함)/catalog·ACL·role·default·function·trigger/82journal=baseline=agentfinal exact, 다른 연결0을 확인했다. Event sequence1(false)→9(true)는 정상 INSERT 진행으로 그대로 보존했다. 전체 sequence exact로 표현하지 않는다. Own container/volume 정상STOP/exited0/OOMfalse/삭제 후55558 retired.

Source SHA256: parent0592cffb595311375b3e3c822a0e2330c28d151044b4c2fb05b982ba84f36b33, workerddf751965873d3527450bdfc940061fcf84eb5509075e6adde7d7518093839f0.

상세 원 증거: /tmp/nomorevibe-http-rival-c-final-report-20261016.md, /tmp/nomorevibe-http-rival-a-final-review-20261016.md, /tmp/nomorevibe-http-rival-root-independent-proof-20261016.json, /tmp/nomorevibe-http-rival-root-db-cleanup-20261016.json. 전체 수동 suite/build는 모든 PR 개발 뒤 수행한다. 새 CI는 변경 head에서만 확인하며 무변경 재실행이나 기존 실패의 소급 PASS는 하지 않는다.

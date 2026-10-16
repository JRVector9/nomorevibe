# Korean tagline shared-capacity validation

기존 공개 제품의 한국어 한 줄 소개 경로에 고정 배치 예약과 native 완료 근거를 연결하는 중이다. 이번 초기 commit은 native4/ledger6과 이 검증 문서만 포함한다. Runtime의 현재 제품·cache·role·job 권한, 실제 DB 경합·writer/ACK 검증은 후속 개발이며 아직 완료하지 않았다. Production resolver는 null이고 운영 배포·활성화는 하지 않았다.

## Native transport

원 8개·1200자 packing, name/display-name·tagline/leadClause의 실제 wire, 여섯 문장 system prompt, temperature0.1, reasoning low, max_tokens=min(3000,600+count150), 모델·parser를 보존한다. Native는 실제 전송1회·manual redirect·retry0이며 준비 객체와 terminal의 private brand/one-use, full ordered wire/sourceHash/contract/C를 검사한다. EOF/abort/TTL만으로 완료를 인정하지 않는다. 실제 native 완료와 한국어 품질 판정은 별개다. Unknown usage는 full C를 유지한다.

C가 실제 loopback POST·원 wire·parsed result까지 통과하는 실행 가능한 scaffold에서 opaque proof 누락1 AssertionFAIL+legacy control1PASS를 확인하고, 동일 두 body를 2PASS로 만들었다. NEW native23개 최초1회 PASS, 기존 product native 영향2개 PASS, 네 파일 범위 TypeScript/ESLint exit0이다. 원 gateway711행 전체 prefix와 다른 translate 경로 전체는 정확히 보존했다. 새 sourceHash는 SHA256(JSON.stringify(["product-tagline-ko-wire-v1",실제 name,실제 전송 tagline]))이며 실제 DB 원문/cache 권한으로 쓰지 않는다.

B 독립 리뷰의 운영 코드 추가 확정 P1/P2=0이다. 신규 fixture의 watchdog이 await run 이후 finally에서 시작하는 정리 경계1건을 root가 전체 읽기로 확인했다. 같은 2000ms timer 시작만 listen/contract 확정 뒤 run 직전으로 이동했다. 강제 close는 errors에 남아 반드시 실패하며 원23개 body·expectation·timeout과 production3는 그대로다. 원247행 전체 역변환 exact, 최종248행 SHA9a69cf2a3b169b737bc86e6a5adc1cab88847f58903b614e45dfdd6b0aba8e92. 영향 abort/body-timeout2개만 한 번 실행해2PASS/21skip, 변경 test 범위 tsc/ESLint exit0이다. 기존23을25distinct로 세지 않는다. 이 문제는 코드 경로 리뷰이며 실제 hang 재현 또는 production timeout 실패 원인으로 주장하지 않는다.

## Ledger and additive DDL

Target은 productId만으로 고정해 source/cache/model/owner/boot 변경으로 중복 실행을 우회할 수 없게 한다. Member는 productId/slug, 원 sourceIdentityHash, 실제 sent-wire sourceHash, absent 또는 전체 raw-row hash·attempts·qualityRejections를 가진 present cache다. Raw network attempts나 quality count에 4/6 상한을 추가하지 않는다. Semantic hash는 복사본을 정렬하고 실제 wire binding은 순서를 유지한다. 첫 waiting INSERT부터 membership을 저장하고 같은 TX의 private one-use dispatch와 opaque historical terminal settlement를 사용한다.

실행한 범위 검증은 shape5 AssertionFAIL+5control→동일10PASS, repository2 AssertionFAIL+17control→동일19PASS, 범위 TypeScript/ESLint exit0이다. Recording transaction은 실제 PostgreSQL 경합·권한 증거가 아니다. C 독립 source6 리뷰 추가 확정 P1/P2=0이며 전체 기존 본문 inverse·원 CHECK·DDL을 독립 재구성했다.

Root가 76행 builder와 source/unit/보고서를 전체 읽고 첫 write 전 AST prefix만 실행해 operations schema와0090 SQL442492bytes/10statement 전체가 정확히 일치함을 확인했다. Writing builder 전체나 SQL을 실행하지 않았다. 기존5 CHECK 전체를 왼쪽 alternative로 보존하고0084–89 SQL·기존90 journal entry를 유지했으며 새0090 tail로91개다. Table/column/index/function/GRANT/backfill을 추가하지 않는다. Root proof `/tmp/nomorevibe-pr05b10-root-ledger-native-conformance-20261016.json`, source10 manifest `/tmp/nomorevibe-pr05b10-root-source10-final-shas-20261016.json`.

## Pending runtime and actual checks

A가 현재 제품·cache raw µs·실제 text 또는 versioned translation 역할·job/final DB wall·commit ACK 후 POST·현재 writer를 구현 중이다. Positive 저장 충돌은 원 counter 증가 전에 중단하고 legacy writer는 sorted product SHARE prefix만 추가해 잠금 순서를 맞춘다. 기존 8/1200·solo2·45s/54s/25s/35s·quality4+home2·network 무상한 재시도·home snapshot은 유지한다. 아직 최종 source/실제 검증 결과를 주장하지 않는다.

B는 별도 NEW actual ledger4case와 guard/readback 계획을 작성 중이다. 실제 DB는 아직 배정하지 않았고 SQL0/activeownedDB0이다. Driver/helper 전체 리뷰·고정 localhost guard·새 root-owned DB 배정 뒤에만 실제 검증한다. 실제 serving C/identity/termination, physical host aggregate, Oracle ARM 상시업무와 DR, 같은 품질 두 배·24시간 관측은 별도 gate다. 수동 전체 test/build/typegen은 모든 계획 PR 개발 뒤 실행한다. 운영DB·SSH·실provider·배포·activation0이다.

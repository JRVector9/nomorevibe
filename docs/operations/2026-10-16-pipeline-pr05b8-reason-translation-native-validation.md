# PR05b8 사유 번역의 예약·호출·저장 연결 — 2026-10-16

사유 번역 한 묶음이 예약 장부의 한 요청과 실제 모델 호출 한 번을 사용하도록 연결한다. 최초 waiting INSERT부터 정렬된 멤버 키를 남겨 소유자·부팅·모델·묶음 순서가 달라도 겹친 번역의 중복 호출을 막는다. 응답의 물리 정산은 현재 작업 권한과 분리하고, 실제 저장은 현재 역할·작업 권한과 전체 캐시 행을 다시 검사한다.

원 모델·프롬프트·wire·출력 파서·품질 검사·묶음4/1600자·단독 재시도·45초 호출/54초 tick·250ms 권한 poll·실패 backoff를 보존한다. 기존 disabled 동작을 유지하고 production serving resolver는 null이다. 이 PR은 실제 provider 전체 토큰 상한이나 Oracle 운영 가동을 증명하지 않는다.

## 소스와 리뷰

새 migration0088은 이전0084–87와 journal88개를 그대로 두고 멤버 메타데이터·reason dispatch/terminal/event CHECK만 추가한다. Root가 builder의 쓰기 이전 prefix를 읽기 전용으로 실행해 전체211814bytes SQL과 schema의 역변환·journal88+tail1을 확인했다. Builder 전체 실행은 하지 않았다.

Native preparation·one-use dispatch/proof, ledger의 control/request 직렬화와 raw 멤버 비교, runtime의 commit ACK 뒤 native 호출·historical settlement·private one-use writer를 root가 직접 읽었다. A의 ledger6 독립 리뷰와 B의 runtime5 독립 리뷰 추가 P1/P2는0이다. Runtime 저장은 raw to_jsonb 전체 캐시 행의 마이크로초를 보존하고 absent INSERT 충돌이나 present CAS 불일치 때 묶음 전체를 되돌린다. 원 source selectors·disabled cache writer·readers/progress·기존 job9 본문은 보존했다.

## 실행한 범위

Native23은21 Assertion FAIL/2controls→동일23 PASS, 추가2회귀는 각각 실제 RED→동일 GREEN이며 최종25 PASS다. 기존 translate control3 PASS/6skip, 범위 TypeScript·ESLint exit0다. Ledger shape7 FAIL/3controls→동일10 PASS, protocol3 FAIL/12controls→동일15 PASS, snapshot1 RED→동일1 GREEN이며 최종19 PASS다. 이전 profile control2 PASS/10skip, 범위 정적검사 exit0다.

Runtime의 실행 가능한 원10 case는7 feature FAIL/3controls→동일10 PASS다. 최초 syntax/setup 실패는 기능 RED로 집계하지 않았다. 기존 job9 PASS와 최종 scoped TypeScript·ESLint exit0을 확인했다. 이 unit 결과는 실제 PostgreSQL 권한·잠금이나 물리 모델 상한의 증거가 아니다.

## 실제 로컬 검증

Root가 서로 다른 전용 localhost DB55578(runtime)·55579(ledger)를 생성하고 source·pinned image·full CID·loopback·sole volume·메모리·metadata를 확인했다. Agent는 서로 다른 DB만 단독 사용한다. 실제 결과와 독립 readback은 검증 반환 뒤 기록한다. 현재 이 문단은 PASS를 주장하지 않는다.

전체 수동 테스트·build/typegen은 모든 계획 PR 개발 뒤 실행한다. 필수 자동 CI는 별도다. 운영 DB·SSH·실 provider·배포·consumer 활성화는 이번 단계에서 하지 않았다. 다른5 text caller, 실제 hard-C/종료·호스트 전체 예산·Oracle ARM 권한/상시 번역·등록후 관리/DR·같은 품질 두 배와24시간 관측은 남는다.

Ledger 실제4개는 최초 실행 모두 PASS다. Root 독립 readback은 raw90표10행·journal89·captured catalog/ACL·기본값/ALWAYS·agent/root sequence 일치를 확인하고 정상 전용DB 폐기를 완료했다. full pg_class는 agent 시점 true, root의 이후 관측에서는 migration2개 관계의 pages/tuples 변화로 false이며 원형과 원인 미관측을 보존한다. 두 backend의 차단 assertion은 실행됐으나 숫자 PID가 원로그에 없으므로 별도 값 캡처를 주장하지 않는다.

Runtime 첫 실행은 테스트의 존재하지 않는 jobs.failures 조회로42703 중단됐다. 실제 last_error 이력 조회로만 두 치환했고, 나머지15 소스와 driver 역변환 whole bytes를 확인했다. 실패 뒤 독립 readback에서 raw/managed/catalog/fullpgclass·기본값/ALWAYS·타연결0이 기준과 같았고 수동 복구나 sequence reset은 하지 않았다. 이 실패는 기능 RED가 아니다. 수정 후 미성공 subset의 결과는 후속 기록한다.

수정 후 runtime 실제9개는3 PASS+미실행6 PASS로 완료했다. 성공한 케이스는 반복하지 않았다. 실제 legacy text 및 versioned translation role/job→one native POST→historical settlement→부분 품질/원attempt·backoff/ACK를 확인했고, present cache1µs 변경 POST0·absent 동시 INSERT의 전체 writer rollback·late job DBwall의 캐시/원ACK0·EOF fullCunknown과 새boot 재호출0을 확인했다. Local descriptor의 C8000과 capability는 fixture 값이며 실제 provider·Oracle 권한 증거가 아니다.

Root가 반환 뒤 같은 readback을 독립 실행해 raw90표10행+journal89·managed·captured catalog/ACL·기본값/ALWAYS·agent/root sequence 일치·타연결0을 확인했다. Runtime full pg_class는 담당 final 시점 true/root 이후 event4관계 pages·tuples 차이로 false이며 원인 미관측을 보존했다. 전용55578과55579를 정상STOP/exited0/OOMfalse 확인 후 sole container·volume만 폐기했다. Root proofs는 `/tmp/nomorevibe-pr05b8-root-{ledger,runtime}-final-db-proof-20261016.json`이다. 새 actual13 distinct(ledger4+runtime9)와 범위 정적검사 완료이며 수동 전체는 반복하지 않았다.

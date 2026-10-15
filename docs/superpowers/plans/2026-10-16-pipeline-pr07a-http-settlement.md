# PR07a HTTP 본문 정산과 origin 반환 Implementation Plan

> **For agentic workers:** 승인된 파이프라인 병렬 개발의 PR07 선행 수정이다. root가 배타 파일·TDD·직접/교차 리뷰·Git을 관리한다. 모든 agent/CLI는 gpt-6.1-sol/xhigh다.

**Goal:** 현재 수집 HTTP가 본문 취소를 요청한 시점에 origin을 조기 반환하지 않고 실제 reader/cancel 정산까지 기다리며, 정리 실패 뒤 추가 redirect 요청을 보내지 않게 한다.

**Architecture:** 기존 `lib/net/fetch.ts`와 undici/SSRF Agent를 그대로 쓴다. 기존 process-local origin 자원의 수명만 바로잡고 공통 DB permit을 붙일 transport 경계를 만든다. 새로운 DB·API·scheduler·fetch 엔진을 만들지 않는다.

**Tech Stack:** TypeScript, Node Web Streams, undici, Vitest.

**사용자 검증 정책 — 2026-10-16 추가 지시:** 앞으로 PR별로 변경 범위 회귀와 필요한 정적 검사만 실행한다. 수동 전체 unit·전체 DB·종합 테스트은 남은 모든 PR 개발 후 통합 단계에서 실행하며, PR마다 반복하지 않는다. 이미 실행한 결과/실패는 보존한다. 저장소가 병합에 요구하는 필수 GitHub CI는 유지한다. 아래 과거 전체 검증 명령은 이 정책으로 대체한다.

## 기준과 소유권

원격과 일치한 최신 main `99a9cefcd9c82dcc86441b798332137a3604fe36`에서 만든 WT `/Users/jr/Desktop/projects/nomorevibe-http-settlement`, branch `codex/pipeline-pr07a-http-settlement-20261016`를 사용한다. 기존 node_modules만 symlink했다. 원본 X 브랜치와 이전 PR의 소스·DB는 건드리지 않는다.

- C: `lib/net/fetch.ts`와 새 `tests/net-fetch-settlement.test.ts`의 최소 회귀. 처음에는 테스트만 작성한다.
- B: 독립 `tests/net-fetch-settlement-adversarial.test.ts`만. 별도의 fixture와 실제 ReadableStream을 쓴다. C helper를 공유하지 않는다.
- A: 이번 PR 소스 쓰기0. M3 관리되는 serving 상한의 후속 접점을 읽는다. 완료 뒤 source 교차 리뷰를 맡을 수 있다.
- root: 이 계획·operations 검증·handoff·delivery status와 모든 Git. 공유 fixture/설정/package/마이그레이션 변경0.

root는 설치 Next.js의 Vitest 및 server/client guide를 읽었다. 이 변경은 Node HTTP utility이며 Next.js API·React component를 바꾸지 않는다.

## 고정 동작과 범위

1. safeFetch background의 final body는 정상 EOF 또는 reader 오류가 정산되면 origin을 한 번 반환한다. caller가 body를 읽지 않는 경우 signal abort는 reader 취소를 시작한다. **abort 이벤트 자체는 release 근거가 아니다.**
2. caller cancel과 signal abort가 겹쳐도 실제 reader.cancel은 한 번만 실행한다. cancel 시작 상태는 호출 전에 latch한다. 취소가 pending read를 done/error로 먼저 깨워도 cancel Promise와 진행 중 read 정산 전에는 release하지 않는다. 취소 실패는 origin을 유지한다. cleanup 오류는 새 unhandled rejection을 만들지 않는다. signal abort 때문에 깨어난 done/error를 정상 EOF로 바꾸지 않고 원 signal.reason으로 body를 error 처리한다. wrapper를 설치하기 전에 이미 aborted인 signal도 같은 의미를 따른다. caller의 명시적 prefix cancel은 원 prefix 결과를 유지한다.
3. protocol상 body가 없는 응답의 기존 즉시 반환을 유지한다. 정상 본문·prefix·status·headers·최종 URL·기존 timeout 범위와 최대 redirect 수는 유지한다. interactive에 background origin queue를 새로 적용하지 않는다.
4. `readBodyCapped`는 prefix 상한에 도달하면 reader.cancel을 실제 await한 뒤 prefix를 반환한다. 취소 실패도 await하고 원 prefix를 보존한다. 기존 공통 wrapper가 취소 실패의 origin을 반환하면 안 된다.
5. redirect는 이전 body 취소가 성공한 뒤 다음 hop을 보낸다. 정리 실패면 추가 hop0이다. safeFetch는 기존 실패 표현 null, fetchCapped는 원 redirect status의 `{ok:false,reason:'http',status}`를 반환한다. retryable HTTP·비표준 status는 원래 상태·Retry-After/오류 의미를 보존하면서 cleanup 성공 때만 origin을 반환한다.
6. 바이트 상한으로 확정한 too_large·명시 prefix 및 원 HTTP 오류를 cleanup 오류로 덮지 않는다. 현재 readBodyPrefix/strict의 실제 chunk 초과 경로는 cancel reject를 http0으로 바꾸므로, 이 두 경로도 원하는 prefix/too_large 결과를 먼저 회귀로 고정해 수정한다. 각 URL의 SSRF/DNS·headers·body 상한을 유지한다. fetchCapped의 테스트 전용 request 주입을 생산 권한으로 확장하지 않는다.
7. 이 PR은 현재 process-local 자원을 바로잡는 것이다. 서버 공통 origin1/Oracle 합2, crash 뒤 점유 회수, 독립 모델 종료·원격 side effect 정산·Oracle 활성·2배는 별도 후속이다. 취소 실패 후 origin이 유지되면 그 origin의 background 요청은 기존 deadline에 중단되며 자동 TTL 반환을 추가하지 않는다.

## 1. 기존 경로에서 기능 RED

- [x] C는 실제 ReadableStream/Response와 지연 cancel Promise를 사용하여 final body cancel pending 중 두 번째 같은-origin 요청이 시작되지 않아야 함을 재현한다. 단순 mock release 횟수로 대체하지 않는다.
- [x] abort 시 cancel Promise가 아직 pending이고 pending read가 먼저 done으로 깨어나는 경우도 같은-origin 진입0이어야 한다. partial body가 정상 성공으로 반환되지 않고 원 abort 오류가 유지되는지 확인한다. 이미 aborted인 signal 및 abort와 cancel이 겹쳤을 때 cancel1회 control을 둔다.
- [x] readBodyCapped의 결과 Promise가 cancel 정산 전에는 완료되지 않고 정산 뒤 원 prefix를 돌려주는 사례를 둔다.
- [x] B는 독립적으로 redirect cancellation 실패의 다음-hop0, 취소 실패 뒤 background origin 유지, prefix/HTTP/Retry-After 결과 보존과 정상 성공 control을 작성한다.
- [x] 각 실제 Promise/reader/cancel/waiter를 try/finally에서 정산한다. assertion이 실패하는 원 source에서도 cleanup이 끝나야 한다. 외부 인터넷/DB/실 provider 호출0. fixture timing 오류나 import 오류를 기능 RED로 세지 않는다.
- [x] root가 원 driver·원 로그·source hash를 읽어 기능 RED를 수용한 뒤에만 C source 편집을 연다.

정상 control은 현재 final EOF→다음 요청, 정상 redirect→다음 hop, interactive 병렬 및 기존 원 결과를 포함한다. 예시는 기존 `safeFetch`를 실제로 실행한다.

```ts
const fetched = await safeFetch('https://held.test/a', 'background');
const cancelling = fetched!.response.body!.cancel();
await cancelEntered;
const follower = safeFetch('https://held.test/b', 'background');
await nextEventLoopTurn();
expect(secondRequestStarted).toBe(false);
finishCancel();
await cancelling;
await follower;
```

위 helper는 테스트 파일 안의 실제 deferred/고정 fixture로 구현하며 production에 테스트-only release API를 넣지 않는다. 실패 시에도 finishCancel과 모든 follower의 abort/정산을 finally에서 실행한다.

## 2. 최소 source 수정과 같은 GREEN

- [x] C만 기존 함수 안에 필요한 private 상태를 추가한다. cancel-before-call latch·동일 Promise 재사용·pending read 정산·release once를 구현한다. 범용 lifecycle framework나 caller Boolean으로 권한을 만드는 새 public API0.
- [x] cancelUnusedBody의 성공 여부를 내부에서 구분하여 redirect와 기존 status 정리 경로에 적용한다. 오류를 삼켜도 점유 반환이나 다음 hop을 성공으로 처리하지 않는다.
- [x] readBodyCapped의 fire-and-forget cancel을 await된 best-effort cleanup으로 바꾼다. prefix 바이트와 반환 형태는 유지한다.
- [x] 원 C/B 회귀를 같은 내용으로 GREEN 확인하고 관련 기존 tests를 실행한다. 새 finding은 먼저 기능 RED로 고정한다.

## 3. 검증·리뷰·PR

```sh
cd /Users/jr/Desktop/projects/nomorevibe-http-settlement
npx vitest run tests/net-fetch-settlement.test.ts tests/net-fetch-settlement-adversarial.test.ts tests/net-fetch-deadline.test.ts tests/net-fetch-recovery.test.ts tests/net-fetch-conditional.test.ts tests/link-evidence.test.ts
npx next typegen
npx tsc --noEmit --incremental false
npx eslint lib/net/fetch.ts tests/net-fetch-settlement.test.ts tests/net-fetch-settlement-adversarial.test.ts
git diff --check
```

위 변경 범위 회귀는 이미 C/B가 실행했다. 변경/새 finding이 없으면 반복하지 않는다. 사용자 지시 전 root가 실행한 전체 unit 3,757 PASS·lint 0error/기존 warning1·i18n PASS는 기록만 보존한다. `next typegen` 뒤 tsc exit0. 전체 build는 외부 node_modules symlink에 대한 Turbopack root 제한으로 exit1이며 PASS가 아니다. 이를 위해 설정/의존성을 바꾸거나 전체 build를 다시 실행하지 않는다. 종합 검증과 bundle은 모든 PR 개발 후 통합 단계에 남긴다.

- [x] root는 source 전체 diff·두 driver·실제 로그를 읽는다. B 또는 A가 C source를 교차 리뷰하고 C는 B driver를 읽는다. 반환 race/취소 실패/unhandled rejection/동일-origin redirect deadlock/SSRF를 확인한다.
- [x] 실제 실행한 결과만 operations 검증·handoff·delivery status에 기록한다. DB/DDL 변경0이므로 새 테스트 DB를 만들지 않는다. 필수 PR CI의 기존 통합 shard 결과는 별도로 확인한다.
- [ ] root만 정확한 파일을 commit·feature push·PR 생성한다. 최신 base 필수 check 뒤 exact-head 정상 병합·main CI/image를 확인한다. 이번 단계에서 운영 배포/새 consumer/Oracle 활성은 하지 않는다.

## 자체 검토

사용자가 승인한 PR07 HTTP 수명 요구의 실제 현재 호출 경계를 먼저 바로잡는다. 공유 DB 기반만 추가하고 transport 연결을 미루는 접근을 피하고, 다음 PR에서 이 고정 transport에 per-hop permit을 결합한다. 기존 timeout·비용·모델·발굴 pause·제품 심사 기준을 바꾸지 않는다. 단일-process 회귀를 multi-host 상한이나 Oracle 실제 처리 증거로 보고하지 않는다.

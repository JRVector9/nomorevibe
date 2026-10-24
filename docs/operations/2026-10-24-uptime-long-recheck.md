# 연결 실패 비동기 확인의 긴 재접속

2026-10-24 KST, 기준 `c3f4e8e84f5fdb40f5b65e6f3b27f9e57493b8f1`.
사용자는 남은 작업의 병렬 진행·운영 활성화·배포를 지시했다. 이 분담 범위는 긴 재확인 코드와 로컬 검증이며
운영 활성화·배포·Oracle 경로는 상위 작업이 담당한다.

## 원인과 설계

`collectUptimeAssist`는 별도 비동기 확인이지만 일반 `safeFetch(..., "background")`와 같은 전체 10초를 썼다.
잠든 호스팅이 응답을 준비하는 동안 원래 생존 확인과 같은 시점에 포기하므로 긴 재확인 요구를 충족하지 못했다.

공통 수집기를 복제하면 SSRF·리다이렉트·origin 직렬·본문 종료 정산의 두 구현을 유지해야 한다.
기존 공통 경로에 선택 옵션 `backgroundTimeoutMs`만 추가하고 확인 수집기가 `60_000`을 명시하는 최소안을 채택했다.
옵션은 background에서만 1~60,000의 정수로 허용한다. 0·음수·소수·NaN·무한대·상한 초과와 interactive 오용은
DNS·HTTP 요청 전에 `RangeError`로 거절한다.

DNS 검증·origin 대기·최대 5번 리다이렉트·최종 본문은 총기한 하나를 공유한다. caller의 중단 신호도 합성하므로
소비자의 남은 시간이나 worker 중단이 60초보다 빠르면 그 신호가 먼저 끊는다. 기존 100초 consumer tick이나
90초 이하 caller 신호를 늘리지 않는다. 일반 HTTP의 10초와 `uptime-ping`의 25초 예산은 그대로다.
TCP 연결 단계에 적용되는 undici의 기본 connect timeout도 변경하지 않는다. 늘린 것은 전체 재확인의 응답 대기 예산이다.

기존 body 512,000바이트·텍스트 32,000자 상한과 401·403·429·999/체크포인트의 blocked 처리를 유지한다.
실패·차단·잘림·본문 오류를 종료 증거로 바꾸지 않으며 기존 consumer가 추가 근거 대기로 보존한다.
모델 호출·적용·원격 종료 불명 원장과 실패횟수·관리자 해제·세대/CAS·lease 정책은 바꾸지 않았다.

## 실제 검증

Node 24.18.0, 기준 worktree의 lockfile 설치 `node_modules`를 심볼릭 링크로 사용했다.
DB·외부 페이지·실제 모델·운영 서버는 사용하지 않았다. 실제 HTTP 검증은 localhost 서버와 undici로 실행했다.

- RED: 새 옵션·collector 전달 테스트를 먼저 추가해 18건 중 12건 실패를 확인했다.
  10초 기한 뒤 응답이 사라지고, 60초 대신 10초가 전달되며, 옵션 오류가 거절되지 않는 assertion 실패였다.
- GREEN: 최소 구현 뒤 동일 18건 통과. 본문 크기·차단과 실제 HTTP 회귀를 더한 3파일 26건 통과.
- 최종 관련 회귀: 14파일 141건 통과. SSRF, 일반 기본값, origin 직렬·실제 취소 정산, caller abort,
  native undici abort, GC 중 timeout source 보존, uptime gate를 포함한다.
- 실제 HTTP의 느린 응답은 일반 요청에서 시간 초과·긴 확인에서 complete가 됐다. 테스트 벽시계만
  일반 50ms·긴 확인 1.5초로 줄이고 프로덕션 인자 10,000/60,000을 따로 검증했다.
  리다이렉트는 총기한 하나이며 끝나지 않는 본문은 기한에 실패하고 같은 origin의 다음 요청은 200이었다.
- `npx next typegen && npx tsc --noEmit`, 수정 TypeScript 5파일 ESLint, `git diff --check`: 실제 exit 0.

Vite의 `configLoader: native` 향후 기본값 경고는 기존 설정 경고로 보존했다.
의도한 RED 외의 구현 실패는 없었다. 별도 collector 구현은 비교만 했고 작성하지 않았다.
전체 unit·DB 통합·build·GitHub CI·운영 쓰기·배포·활성화는 이 분담에서 실행하지 않았다.
Oracle 등 다른 네트워크 확인과 실제 운영 품질 표본은 별도 검증이 필요하다.

재현 명령:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-uptime-confirm-long-recheck
npm test -- tests/net-fetch-background-timeout.test.ts tests/uptime-assist-evidence.test.ts tests/uptime-assist-reconnect.test.ts tests/net-fetch-deadline.test.ts tests/net-fetch-guard-deadline.test.ts tests/net-fetch-recovery.test.ts tests/net-fetch-settlement.test.ts tests/net-fetch-settlement-adversarial.test.ts tests/net-fetch-undici-abort.test.ts tests/net-fetch-timeout-source.test.ts tests/net-fetch-conditional.test.ts tests/ssrf.test.ts tests/uptime-gate.test.ts tests/crawl-fetch-concurrency.test.ts
npx next typegen
npx tsc --noEmit
npx eslint lib/net/fetch.ts lib/domain/products/uptime-delist-review.ts tests/net-fetch-background-timeout.test.ts tests/uptime-assist-evidence.test.ts tests/uptime-assist-reconnect.test.ts
git diff --check
```

실행 원본은 `/tmp/nomorevibe-uptime-confirm-long-recheck-{red,green,native,regression,types}-20261024.log`에 보존했다.

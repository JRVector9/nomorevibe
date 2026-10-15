# PR07a HTTP 본문 정산 — 실제 검증 기록

2026-10-16 KST. [고정 계획](../superpowers/plans/2026-10-16-pipeline-pr07a-http-settlement.md)을 따라 실제 기존 HTTP 호출을 수정했다. base `99a9cefcd9c82dcc86441b798332137a3604fe36`, 작업 branch `codex/pipeline-pr07a-http-settlement-20261016`다.

## 변경 결과

background `safeFetch`는 abort 이벤트나 취소 요청만으로 origin을 반환하지 않는다. 실제 reader.cancel과 진행 중 read가 정산된 뒤 반환하며, caller cancel/abort가 겹쳐도 취소는 한 번만 실행한다. abort로 깨운 read를 정상 EOF로 바꾸지 않고 원 signal.reason을 보존한다.

본문 정리 실패 뒤 redirect의 다음 요청을 보내지 않는다. 확정된 prefix·too_large·HTTP status·Retry-After는 cleanup 실패로 덮지 않는다. `readBodyCapped`의 fire-and-forget 취소는 await로 바꿨다. 기존 byte 보존 의미·SSRF/DNS 검증·헤더·timeout·redirect 상한·interactive 병렬은 유지했다.

production 변경은 `lib/net/fetch.ts` 하나다. 동결 SHA-256은 `d69349eb88a6e1262d688879e8497538576594889d25569b4d506aea7ca19fac`다. 새 설정/의존성/DB/마이그레이션/공개 API는 없다.

## 실제 RED → 같은 GREEN

C와 B가 독립 fixture로 실제 ReadableStream/Response/reader.cancel을 사용했다. undici 외부 transport와 timeout signal 생성만 stub했다. root가 원 driver 전체·실패 로그·원 source SHA를 읽어 기능 실패를 수용한 뒤 C만 production 소스를 수정했다.

| 검사 | 원 source에서 실제 결과 | 같은 원 driver의 수정 후 결과 |
| --- | --- | --- |
| C 7개: cancel/read 대기, prefix 대기, abort/이미 abort된 signal, 정상 controls | 4 Assertion FAIL / 3 PASS, exit1 | 원 C+B 합17 PASS, exit0/111ms |
| B 독립10개: 정리 실패·redirect·origin 유지·prefix/too_large·HTTP | 8 Assertion FAIL / 2 PASS, exit1 | B가 독립 재실행10 PASS, exit0/112ms. C와 합17 PASS, exit0/114ms |
| 기존 deadline/recovery/conditional/link-evidence 4파일 | 기존 회귀 | C 실제48 PASS, exit0/427ms |
| C source/driver scoped ESLint | driver 초기 exit0 | 최종 exit0 |

C driver `tests/net-fetch-settlement.test.ts` 249행 SHA `7613611d2215277b13ecd3557162226166e306dd5e6988fa1522f8583aef7edf`, B driver `tests/net-fetch-settlement-adversarial.test.ts` 220행 SHA `44afb66a1e0731e87626652b643d6272e32c5d5971720e466afa6cbbb559b0a0`는 각각 원 RED 파일과 byte 동일하다. 초기 import/setup/unhandled 오류를 기능 실패로 세지 않았다. assertion 실패 경로에서도 finally에서 실제 reader/cancel/follower를 정산했다.

원 로그는 `/tmp/nomorevibe-pr07a-c-initial-red-20261016.log`, `-b-baseline-red-20261016.log`, `-c-original-17-green-20261016.log`, `-c-existing-related-green-20261016.log`, `-b-frozen10-green-20261016.log`, `-b-combined17-green-20261016.log`에 보존했다.

## root 검증과 검증 정책 변경

사용자가 **이후 PR별 수동 전체 테스트를 반복하지 않고, 남은 모든 PR 개발 후 통합 단계에서 실행**하도록 지시했다. 앞으로 변경 범위 회귀와 필요한 정적 검사만 PR별로 실행한다. 저장소의 필수 병합 CI는 유지한다. 아래는 지시 전에 이미 실행한 결과이며 다시 실행하지 않았다.

| 실제 실행 | 결과 |
| --- | --- |
| `npm test` | exit0, 294파일 **3,757 PASS**, 15.83초 |
| `npm run lint` | exit0, error0/기존 vendor `_ctx` warning1 |
| `npm run check:i18n` | exit0, 4 locales/8 namespaces/11 public pages |
| `npx next typegen` 후 `npx tsc --noEmit --incremental false` | 각각 exit0 |
| 전체 build | **exit1**, 외부 node_modules symlink가 Turbopack filesystem root 밖을 가리켜 거절됨. 앱 compile PASS가 아님 |

C의 typegen 전 tsc는 미생성 PageProps6개로 exit2였다. root가 typegen 후 source 수정 없이 tsc exit0을 확인했다. 전체 build를 위해 설정/의존성을 변경하거나 재실행하지 않았다. bundle은 실행하지 않았다. 종합 build/bundle과 전체 DB 검사는 모든 PR 개발 후 통합 단계에 남긴다. 새 테스트 DB를 만들거나 이전에 정리한 DB에 재접속하지 않았다.

root 원로그: `/tmp/nomorevibe-pr07a-root-{unit,lint,i18n,typegen,tsc,build}-20261016.log`.

## 직접·교차 리뷰와 한계

root가 production 전체 diff/helper/호출 문맥과 두 원 driver를 읽었다. A가 동결 source 전체를 독립 읽기 리뷰하고 B가 원8개 실패의 해결을 diff와 대조했다. 추가 미해결 P1/P2는 없다. A/B/C 모두 source/driver SHA 동결을 확인했다. 리뷰는 `/tmp/nomorevibe-pr07a-a-source-review-20261016.md`, `-b-final-review-20261016.md`, C 반환은 `-c-final-report-20261016.md`다.

이 결과는 **process-local origin의 reader/cancel 정산**을 검증한다. 실제 socket/native transport 종료, multi-host 공통 permit, crash 회수, 외부 모델 종료, Oracle 실제 가동이나 2배 처리량을 증명하지 않는다. 취소 실패한 origin은 유지되며 후속 background 요청은 기존 deadline에 중단된다. 자동 TTL 반환을 추가하지 않았다.

다음 PR07b에서 공통 DB 장부와 고정 per-hop adapter, safeFetch/fetchCapped 실제 연결, 실제 DB/loopback을 함께 검증한다. 운영 배포/DDL/새 consumer/발굴 재개는 이 PR에서 수행하지 않았다.

## PR 상태

코드·변경 범위 검증·직접/교차 리뷰 완료. PR 제출·필수 CI·정상 병합 결과는 실제 확인 후 갱신한다.

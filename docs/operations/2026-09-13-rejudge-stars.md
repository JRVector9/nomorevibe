# C-1 스타 구간 재판정 — 운영 적용 완료

근거: [사용자 제공 C 트랙 인계 문서](https://claude.ai/code/artifact/258acc8e-c763-45cc-9aea-62c360b6ac56), C-1 및 4번.
사용자의 승인 후 프로덕션 상한을 99999로 변경하고 검토한 318건을 적용했다. 코드 배포 및 C-2–C-4 결과는 별도 최종 보고서에 기록한다.

## 2026-09-13 운영 dry-run

운영 reviewer 앱 `4RlA9EeKvtKGdR6c6AV4j`는 Dokploy에서 `done`, 소스는 `main`이었다.
키체인에서 인증을 읽어 앱의 DB 주소를 자식 프로세스 환경에만 넘겼다. DB URL·API 키·전체 env는 출력하거나 파일에 쓰지 않았다.
계획은 PostgreSQL `REPEATABLE READ READ ONLY` 트랜잭션으로 생성했다.

| 스타 구간 | 대상 | 개인 계정 |
|---|---:|---:|
| 2,000–4,999 | 97 | 35 |
| 5,000–9,999 | 84 | 27 |
| 10,000–29,999 | 71 | 11 |
| 30,000–99,999 | 66 | 20 |
| 합계 | 318 | 93 |

저장 원본에 확장된 규칙을 적용한 미리보기: `approved/passed` 292건,
`needs_review/ambiguous` 16건, `rejected/not_a_product` 10건.
이는 AI 심사·2차 심사·최신 제작 근거·URL 중복/차단 확인을 포함한 최종 결과가 아니다.
실제 적용은 대상 후보를 `new`로만 돌리고 나머지는 기존 파이프라인이 수행한다.
새로운 “5천 이상 추가 AI 근거” 정책은 도입하지 않았다. 사용자가 승인한 기존 심사 정책을 유지한다.

로컬 검토 파일(비밀 없음, gitignored):

- `.crawl-samples/stars-prod-plan-20260913.json`: 318건 전체 계획과 후보/원본/설정 지문.
- `.crawl-samples/stars-prod-review-20260913.md`: 구간별 사람이 읽는 전체 대상 표.

이 파일들은 저장소 복제본에는 포함되지 않는다. 다른 환경에서는 dry-run을 다시 생성하고 검토해야 한다.

## 경계값과 보호 조건

인계 문서의 `maxStars=100000`은 코드의 포함 상한(`stars > maxStars`이면 거부) 때문에 정확히 10만을 허용한다.
사용자가 정한 “10만 이상 제외”를 지키는 값은 **99999**다. 규칙 코드의 기존 의미는 바꾸지 않았다.

대상은 `rejected/large_oss/auto`, `decided_at IS NULL`, 미발행, 저장 원본의 URL 존재·HTTP 200–399,
JSON 숫자형 정수 스타 2000–99999다. 사람이 거부한 것, 문서가 없는 것, 잘못된 스타 값은 제외한다.

- 적용 전에 운영 설정에서 상한만 99999로 변경해야 한다. 나머지 유효 설정이 계획과 다르면 전체 적용을 거부한다.
- 후보 및 원본 전체의 DB 지문이 계획과 같을 때만 후보를 잠그고 `state`, `updated_at`을 변경한다.
  검토 뒤 수동 수정·수집 갱신된 행은 건너뛴다. 모든 변경과 영수증 생성은 한 트랜잭션에 묶인다.
- 적용 영수증은 새 파일로 독점 생성하고 파일 및 디렉터리를 fsync한 뒤 DB를 커밋한다.
  파일 저장 실패 시 DB 변경이 모두 롤백된다. 기존 파일을 덮지 않는다.
- 영수증 저장 후 커밋 응답이 끊긴 경우에는 파일 존재만으로 커밋 성공이라고 단정하지 않는다.
  후보 상태를 읽어 확인한다. `--revert`는 실제 적용 직후 지문과 같은 행만 복원하므로 미커밋 영수증으로 다른 행을 덮지 않는다.
- 되돌리기는 아직 손대지 않은 `new`만 원래 거부 상태·DB 시각(마이크로초 포함)으로 복구한다.
  이미 심사·수동 수정·발행된 결과나 원본 갱신은 보존한다. 전체 운영 이력 복원 도구가 아니다.
- 되돌리기는 설정 상한을 복구하지 않는다. 새 상한으로 그 사이 들어온 다른 후보도 되돌리지 않는다.
- DB 식별 지문은 서버 주소/포트와 DB명에 묶인다. DB 이동·복제 후에는 새 계획을 검토한다.

## 실행 순서

`DATABASE_URL`을 비밀 저장소에서 실행 환경으로만 주입한다. 운영 PgBouncer에는 `DB_POOLER_MODE=pgbouncer`를 설정한다.
다음 명령은 이 저장소 루트 기준이다. 아래 적용·되돌림 명령은 승인을 받은 뒤만 실행한다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe
mkdir -p .crawl-samples
# 읽기 전용. 기존 파일은 덮지 않으므로 새 파일명을 쓴다.
DB_POOLER_MODE=pgbouncer npx tsx scripts/rejudge-stars.ts --out=.crawl-samples/stars-plan-next.json
```

승인 범위는 “상한 2000 → 99999, 추가 AI 근거 정책 없이 기존 심사 유지, 검토된 318건 재판정 접수”다.
승인 후 `/admin` 판정 기준에서 상한만 99999로 바꾸고 다음을 실행한다.
설정과 후보 변경 사이의 신규 수집에는 이미 새 상한이 적용된다.

```sh
DB_POOLER_MODE=pgbouncer npx tsx scripts/rejudge-stars.ts \
  --apply=.crawl-samples/stars-prod-plan-20260913.json \
  --receipt=.crawl-samples/stars-prod-receipt-20260913.json
```

스크립트는 기본값·모드·발행 설정을 바꾸거나 잡을 직접 실행하지 않는다. 설정 변경에는 워커 재배포가 필요 없다.
기존 scheduler의 `crawl-judge`가 처리한다. 적용 영수증의 ID를 기준으로 5분·30분 뒤 상태·AI 심사 결과·2차 심사 진행을 조회한다.
규칙 통과와 AI 승인, 발행을 각각 구분하며 heartbeat만으로 성공을 판단하지 않는다.

문제가 생겼을 때 아직 처리되지 않은 적용분을 복원하는 명령:

```sh
DB_POOLER_MODE=pgbouncer npx tsx scripts/rejudge-stars.ts \
  --revert=.crawl-samples/stars-prod-receipt-20260913.json
```

## 검증 기록

- 구현 전 빈 동작으로 실행한 새 통합 시험: 6개 중 5개가 의도한 기능 부재로 실패했다.
- 구현 후 새 통합 시험: 6/6 통과.
- 전체 단위 시험: 115파일 / 894개 통과.
- `npx tsc --noEmit -p .`, 변경 TS 3파일 ESLint, `git diff --check`: 통과.
- CLI `--help`: 종료 코드 0. 상충하는 `--apply` + `--revert`: DB 작업 없이 종료 코드 1.
- 전체 통합 시험: 63파일 / 580개 통과(178.76초). `/tmp/nomorevibe-stars-integration.log`.
- 전체 단위 시험 로그: `/tmp/nomorevibe-stars-unit.log`.

C-2/C-3 구현 및 운영 DB 마이그레이션 완료. 화면 배포·최종 실측은 `2026-09-13-popular-projects.md` 참조.

## 승인 후 실제 적용

- 2026-09-12T16:10:44.910Z: 운영 maxStars 2000→99999 저장. 다른 심사·발행 기준 유지.
- 검토된 계획 적용: 318건, 변경되어 건너뛴 건 0. 영수증 `.crawl-samples/stars-prod-receipt-20260913.json`.
- 16:17:41Z(약6분): published123 / approved112 / needs_review15 / new19 / rejected49.
  거부는 already_listed32, not_a_product17. 최신 AI review 기록은 reject1건으로 관측됐다.
- 운영 reviewMode는 observe다. 따라서 published와 AI 승인 건수를 동일하게 해석하지 않는다.
- 16:42:00Z(30.39분): published249 / needs_review12 / rejected57. 거부 사유는 already_listed34, not_a_product22, unreachable1. new/approved 대기0. 최신 AI review 기록은 reject1건이며 observe 정책 특성상 발행 수와 다르다.

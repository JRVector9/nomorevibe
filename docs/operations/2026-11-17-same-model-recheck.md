# 같은 모델 재검토 — PR #989

#988 위에 쌓음, #988 병합 뒤 base를 main으로 바꿈.
기준 `bd02f98b83835823c5dcb2021b9e7eb41f97bb44`, 작업 브랜치 `feat/same-model-recheck-20261117`.

## 규칙과 선택

- 기본 꺼짐 `qwenAuto.sameModelRecheck = { enabled: false, perTick: 1 }`. 상한은 기존 자동 단계와 같은 20건/틱이다.
- `enabled`와 `auditSecondOpinion.enabled`도 켜져 있어야 한다. 공개분 변경 재판정(rolling)의 최신 열린 거절만 대상이다.
- 이 작업의 검증된 다른 모델 순위가 하나라도 있으면 같은 모델 재검토는 하지 않는다. 다른 모델의 용량 부족은 재검토로 넘어갈 이유가 아니다.
- 같은 모델도 작업 ↔ 모델의 켜진 API/OpenCode 순위·검증된 계약이 있어야 한다. 기존 단계·secondary slot·backoff·`withLocalModelCapacity(local-second-opinion, allowLegacy:false)`를 사용한다.
- 시스템 공통 앞부분과 Qwen-v2 덧붙임은 유지하고, 뒤에 반대 입장 검토를 더한다. 처음 거절 사유는 이스케이프된 비신뢰 근거 봉투에 넣는다.
- 실제 만든 소프트웨어, 기존 사람 프로젝트라도 AI로 계속 만드는 경우, 근거가 오래됐다는 이유만으로 거절하지 않는 기준을 명시했다. 호출의 24시간 입력 유효성은 바꾸지 않았다.
- 출처/actor `same-model-recheck`, 전용 표 `product_audit_same_model_rechecks`, 별도 관측 키다. 독립 의견 표·집계·보류 관문·자동 닫기에 쓰지 않는다.
- 유지 권고면 **사람 확인 — 재검토가 유지 권함**을 보인다. 추천안을 선택한 이유는 자동 유지보다 상태 변경이 작고 사람이 실제 근거를 확인할 수 있기 때문이다.
- 재거절·판단 보류는 기록만 남긴다. 이 표로 내리기·숨기기·자동 유지·보류 풀기를 확정하는 경로는 없다. 기존 사람 결정과 제품 상태는 그대로다.
- 같은 거절/프롬프트의 재검토는 한 번이다. 응답 도중 끄거나 처음 거절 사유가 바뀌면 쓰지 않는다. 항목 오류 2회 이후 제외, 지난 입력은 5분 뒤 다시 확인한다.

## 운영 31건에 켰을 때 예상

사람이 지정한 캠페인 7·`qwen3.8-flash-next` 재판정 거절 31건 기준이다. 운영 DB나 현재 모델 응답을 이 작업에서 새로 측정하지 않았다.
같은 모델 하나뿐인 순위와 공개/미결/최신 항목 조건을 유지한다면 유효한 원본부터 틱당 최대 1건을 기존 장부로 묻는다.
승인 답은 사람 확인 권고만 추가한다. 자동으로 해소·유지·내리기·숨기기 하는 수는 0건이다. 실제 유지 권고 수는 모델을 부르지 않아 알 수 없다.
지난 입력은 호출하지 않는다. #987의 재수집 등으로 원본이 유효해져야 하며, 이 PR은 재수집이나 기한 우회를 하지 않는다.

## 켜기와 되돌리기 — 이 작업에서는 실행하지 않음

배포·별도 운영 승인 뒤, 기존 운영자 CLI의 CAS·사유·감사 로그 경로를 쓴다.
`QWEN_AUTO_DATABASE_URL`은 기존 승인된 방식으로만 제공하고 파일/인자로 쓰지 않는다.

```sh
# 먼저 읽기 전용 예행. 다른 모델 순위가 있다면 재검토는 동작하지 않는다.
node --import tsx scripts/ops/set-qwen-auto.ts --step=sameModelRecheck --enable --per-tick=1 --reason="거절 사유를 반대 입장에서 다시 확인" --dry-run
# 실제 켜기는 별도 승인 뒤 위 명령에서 --dry-run을 제거한다.
# 되돌리기: 스위치를 끈다. 받는 중인 답도 저장하지 않는다.
node --import tsx scripts/ops/set-qwen-auto.ts --step=sameModelRecheck --disable
```

기록과 이미 표시된 권고는 감사 이력으로 남는다. 스위치를 끄면 새 호출/반영이 멈춘다.

## 마이그레이션·배포 범위·충돌

`0189_same_model_recheck.sql`은 새 표와 자체 CHECK/외래 키만 추가한다. 기존 용량 장부 CHECK 재구성은 없으며 이 마이그레이션 자체는 DRAIN을 요구하지 않는다.
일반 앱 교체는 저장소의 승인된 배포 절차를 따른다. 운영 적용은 하지 않았다.
#987의 `0188`을 피했다. 두 PR 통합 시 `_journal.json`의 순서/시각을 함께 확인하고, **0189를 적용하기 전에 0188을 포함**해야 한다.
Drizzle은 마지막 적용 시각보다 앞선 마이그레이션을 나중에 자동 적용하지 않으므로 0189만 먼저 운영 적용해서는 안 된다.

실행: `npm run deploy -- scope --base bd02f98b83835823c5dcb2021b9e7eb41f97bb44 --sha 5436b6a5a348b1481942574c3e4afc81c4bf5c3f`
결과: `trusted:true`, `full`, 18앱. 로컬 범위 확인뿐이며 plan/run/이미지 발행은 하지 않았다.

#987과 겹친 파일: `lib/crawl/audit-second-opinion-auto.ts`, `lib/crawl/settings-schema.ts`, `lib/crawl/settings.ts`,
`scripts/ops/set-qwen-auto.ts`, `drizzle/meta/_journal.json`, `tests/qwen-auto-settings.test.ts`.
새 핵심 로직/표 정의/시험은 별도 파일에 두고 #987 브랜치는 수정하거나 push하지 않았다.

## 실제 검증과 남은 일

- [x] 격리 브랜치·빈 시작 커밋·Draft PR #989 확인
- [x] 별도 기록·기본 꺼짐·틱당 상한·기존 순위/용량 경로 구현
- [x] 반대 입장 프롬프트·사람 확인 유지 권고·거절 미반영 구현
- [x] 전용 단위 `tests/same-model-recheck.test.ts` 14건 포함 관련 단위 183건 통과(13파일)
- [x] 작업 전용 PostgreSQL(55509) 통합 58건 통과(5파일, 새 통합 8건)
- [x] `npx next typegen`, `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit`, 변경 영역 ESLint 통과
- [x] 실제 앱 `/admin/audit?tab=recheck`에서 1440/1024px 표시·사유 펼침/접기·권고 1개/재거절 표시 없음 검수
- [x] 실제 스크린샷 확인: 권고 영역 가로 넘침 0px(566/566), 접은 사유 36px(행높이 18.15px), 브라우저 오류 0건
- [ ] task 브랜치 push 및 최신 머리 CI `check` 확인 후 PR 본문/개발 보고에 영수증 기록

초기 실패도 보존한다: 처음 tsc는 새 설정 fixture 누락 1건(추가 후 통과), 새 통합 재실행은 이전 입력기한 관측과 RESTART IDENTITY가 충돌해 4/7 실패했다.
시험에서 이 전용 관측을 매번 비우도록 고쳐 8건 모두 통과했다. 무관한 기존 실패는 관측하지 않았다.
첫 scope는 `HEAD` 문자열을 받아 `invalid_commit_identity/trusted:false`였고 실제 40자리 SHA로 다시 실행해 위 결과를 얻었다.
수동 전체 unit/DB/종합 검사는 PR별로 반복하지 않는다. GitHub 필수 CI는 저장소 workflow 그대로 실행한다.

품질 전후 비교 수치: 측정 없음. 이 구역의 전후 품질 점수를 재는 저장소 도구/기준이 없으며 위 실제 시험·화면 계측으로 검증했다.
병합·배포·운영 설정 저장·운영 DB 쓰기·main push는 수행하지 않는다.

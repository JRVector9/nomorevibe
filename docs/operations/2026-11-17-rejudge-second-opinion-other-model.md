# 재판정 거절의 다른 모델 두 번째 의견 — PR #988

PR: https://github.com/JRVector9/nomorevibe/pull/988

## 완료·남은 일

- [x] 최신 origin/main 전용 브랜치·착수 Draft PR 생성
- [x] 원인 확인·지정 회귀 시험에서 수정 전 실패 확인(1 실패·2 통과)
- [x] 기존 순위·로컬 계약·용량 장부를 통한 다른 모델 선택 구현
- [x] 운영 읽기 전용 확인: 2026-11-17 11:40:17Z 캠페인 7 미결 거절 32건, 모두 local-direct / qwen3.8-flash-next
- [x] 작업 전용 Postgres 범위 통합 시험
- [x] next typegen·tsc 통과
- [x] 최종 lint·배포 scope 확인
- [x] 전용 브랜치 커밋·push·구현 CI check 확인
- [x] PR 본문 검증 결과 반영·최종 개발 보고 증거 준비

개발 잔여 항목은 없다. 이 완료 기록을 포함한 최종 머리의 CI 결과와 보고함 영수증은 PR 본문·개발 보고를 확정본으로 삼는다.
병합·운영 적용·독립 모델 순위 추가는 이번 작업에서 수행하지 않는다.

## 선택과 이유

`audit-second-opinion` 작업의 저장된 순위만 사용한다. 다른 작업의 순위를 빌리거나 설정을 변경하지 않는 가장 작은 변경이다.
기본 두 번째 의견 모델과 거절 모델이 같은 변경 재판정 항목만 다음 독립 모델을 고른다. 첫 번째 독립 모델의 의견이 이미 있으면
다음 모델로 계속 넘기지 않는다. 이미 그 항목의 감사 답을 낸 모델은 두 번째 의견을 낼 수 없다.

## 운영 예상 효과와 제한

읽기 전용 SELECT 결과 `audit-second-opinion`에는 켜진 Qwen 1순위만 있다. 따라서 대표가 앞서 잰 31건과 현재 32건 모두
현재 설정 그대로는 자동 해소 0건이다. 다른 모델이 이 작업의 순위에 등록되고 그 계약·용량 경로가 열리면 두 번째 의견을 물을 수 있다.
다른 의견을 받는 것과 유지·숨김으로 자동 종결하는 것은 다르며, 기존 확신·엇갈림·본문 부족 관문을 계속 따른다.

`product-audit`의 2순위 OpenCode DeepSeek·3순위 M3 DeepSeek는 별도 작업이므로 이 작업에서 가져다 쓰지 않는다.
운영 설정·DB 쓰기·병합·배포는 수행하지 않는다. input_stale·재수집 구현은 별도 PR의 범위다.

## 이전 검증 기록

- 기존 공용 node_modules 링크는 aws4fetch가 없어 시험 모듈을 읽지 못했다. 작업 트리에 npm ci 후 정상 재현했다.
- `npx vitest run tests/rejudge-second-opinion-other-model.test.ts`: 수정 전 1 실패·2 통과.
- 같은 시험과 `tests/audit-second-opinion-stale-input.test.ts`: 최초 수정 후 9 통과.
- 최초 통합 시험의 실패는 시험 준비의 설정 setter 누락·필수 input_hash 누락·빈 정책 routes였다. 준비를 바로잡은 뒤 6건 통과했고,
  기존 기본 모델 경로·상태 집계·qwen-direct 제공자 회귀를 추가한 최종 범위 시험은 **3파일 46건 통과**했다.
- 최종 범위 단위 시험: **11파일 153건 통과**. 지정 회귀 시험의 처음 세 경우는 **2/3 → 3/3**이다.
  측정 명령: `npx vitest run tests/rejudge-second-opinion-other-model.test.ts -t '재판정 거절의 독립 두 번째 의견'`.
- 첫 tsc는 Next 생성 타입 없음과 시험 outcome 타입 누락으로 실패했다. 시험 데이터를 고친 뒤 CI와 같은 `npx next typegen` →
  `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` 순서로 통과했다.
- 첫 scope는 Git 별칭을 인자로 주어 `invalid_commit_identity`로 보수적 전체 분류됐다. 커밋 후 정확한 SHA로 다시 측정한다.
- 공유 `reviewCandidatePredicate`·replay 권한 프로필은 변경하지 않았다. 선택 SQL은 기존 감사 표만 사용한다.

## 확정 검증·배포 범위

- `npm run lint`: 종료 0, 오류 0·기존 다른 파일 경고 4·변경 파일 경고 0.
- 구현 커밋 `53289cdb5ab2d37cf561f238dd6651a0b3a903cc`의 [전체 CI 44078317366](https://github.com/JRVector9/nomorevibe/actions/runs/44078317366):
  **SUCCESS**. typecheck·lint·build·unit 2묶음·integration 6묶음·integration-ledger·PR 이미지 2개·최종 check가 모두 통과했다.
- 초기 Draft 실행은 저장소 정책상 scope skip·check 실패였다(44075853363, 44078152901). 구현·로컬 검증 후 Ready 전환으로 실제 CI를 실행했다.
  결제 차단이 아니며 저장소는 PUBLIC이었다. 저장소 공개 범위·접근 권한은 변경하지 않았다.
- 배포 범위 명령:
  `npm run deploy -- scope --base a9c534981975da2636c2fece03695b58b1009749 --sha 53289cdb5ab2d37cf561f238dd6651a0b3a903cc`
  → `trusted:true`, `deployment-scope-v2`, `mode:full`, 전체 **18개 앱**. 공통 lib 변경의 기존 분류다.
- 구현 CI 통과 후 `origin/main`을 다시 fetch했고 base는 동일한 `a9c53498`이었다. 이 완료 기록 외에 검증 뒤 구현 변경은 없다.
- 이 문서의 최종 갱신은 기록만 바꾸므로 로컬 검증을 재실행하지 않는다. 최종 머리의 GitHub CI 결과는 PR 본문에 별도로 기록한다.

## 적용·되돌리기

마이그레이션·CHECK 재구성은 없다. 코드 되돌림은 이 PR 구현 커밋의 revert 후 기존 배포 절차를 따른다.
일반 모델 호출 앱 교체의 DRAIN은 기존 배포 정책대로 하며, 이 작업은 배포하지 않는다.

## 이어서(2026-11-17): 2순위 DeepSeek 저장 경로

사람 지시: 「deepseek 2순위로 넣어」. 감사 두 번째 의견의 2순위에 `m3-deepseek · deepseek-v4.1-flash-1017`(M3 :8010, 키 없음)을
넣을 수 있게 한다. 이번 작업은 코드·PR·CI까지다. 병합·배포·운영 설정 저장·운영 DB 쓰기는 하지 않았다.

### 완료·남은 일

- [x] 막힌 점 확인: `saveAiTaskRanks`가 `isAiLiveTask`에 없는 작업을 거절했다. 그래서 화면·CLI로 이 작업의 순위를 저장할 수 없었다.
- [x] 저장 가능하게 함. `isAiLiveTask`는 그대로 두었다.
  - 순위 일부만 실행이 읽는 작업을 새로 둔다: `aiTaskRankScopeNote` / `isAiRankSavableTask`, 감사 두 번째 의견 하나.
  - 공개분 추가 검수 등 다른 작업의 live 여부·저장 거절은 바뀌지 않는다. 시험으로 고정했다.
- [x] 1순위 규칙: 기본 Qwen 직접 설정(`qwenDirectConfig`)과 서버·모델이 같아야 한다. 다르면 **거절**한다.
  - 이유: 실행은 1순위를 이 순위가 아니라 기본 설정에서 읽는다. 다르게 저장하면 실행이 바뀐다고 오해하게 된다.
  - 기본 설정을 못 읽으면 저장을 거절한다.
- [x] 2·3순위 규칙: 기본 모델과 같은 모델(다른 서버라도)이면 거절한다.
  - 저장할 때 같은 주소·모델의 로컬 계약을 다시 쓰고 `local-second-opinion` 정책 route만 덧붙인다.
  - 계약이 없으면 readback과 1토큰 시험을 거쳐 새로 만든다.
- [x] 저장 결과의 `scope` 문장에 범위를 적는다.
  - 1순위는 실행을 바꾸지 않는다.
  - 2·3순위는 같은 모델이 낸 재판정 거절의 두 번째 의견에만 쓴다.
  - 이 문장은 화면 저장 결과와 CLI(stdout JSON, stderr `범위 …`)에 같이 나온다.
- [x] 관리 화면(/admin/models 작업 배정)
  - 순위 편집기를 열고 설명을 보인다.
  - 순위 줄 표시는 「대체 순서」 대신 「기본 설정」·「재판정 거절만」이다.
  - 쓸 일 없는 「순위대로/동시에」 고르기는 숨긴다.
  - 확인·저장 결과 단계에 설명이 나온다.
  - 작업 표는 실제 적용 설정 뒤에 2·3순위를 보인다. 그 모델의 장부 호출은 「설정에 없는 모델」로 경고하지 않는다.
- [x] 범위 시험·정적 검사·화면 확인(아래)
- [ ] (사람) 병합·배포 뒤 아래 명령으로 순위 저장

### 검증(실제 실행)

- 새 단위 시험 `tests/audit-second-opinion-rank-save.test.ts`
  - 수정 전 6/14, 수정 후 14/14.
- 새 통합 시험 `tests/integration/audit-second-opinion-rank-save.test.ts`(자기 DB)
  - 수정 전 0/3, 수정 후 3/3.
  - 운영 명령 그대로 `set` 하면 2순위 계약·route가 생기고, PR #988의 `rejudgeSecondOpinionModels`가 DeepSeek를 고른다.
  - `verifiedLocalModelContract`·`localModelRouteIdReady` 통과를 실제로 확인했다.
  - `--rank1`만 다시 저장하면 되돌아간다.
- 관련 단위 75파일 1188건 통과.
- 관련 통합 7파일 94건 통과.
  - 전용 Postgres 컨테이너에서 돌렸다. 공유 시험 DB(55435)는 다른 작업과 동시에 돌아 deadlock 40P01이 났다. 환경 문제다.
- `npx next typegen`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .` 통과.
- 변경 파일 eslint 오류 0, `git diff --check` 통과.
- 화면: 로컬 일회용 DB(docker)에 연결 2개·계약·정책을 심고, `ADMIN_LOCAL_LOGIN=1 next dev`에서 Playwright로 열었다.
  - 1440·390 폭에서 설명 칸이 잘리지 않았다(scrollWidth = clientWidth). 가로 넘침 0, 페이지 오류 0.
  - 2순위 고르기 → 확인 → 저장까지 눌러 보았다.

### 배포 범위·적용 명령(실행하지 않음)

`npm run deploy -- scope --base a9c53498 --sha <머리>` → `trusted:true`, `deployment-scope-v2`, `mode:full`, 18개 앱이다.
공통 lib·스타일시트 변경의 기존 분류다.

병합·배포 뒤 웹 또는 reviewer 컨테이너에서 실행한다. 기본 Qwen 직접 설정 env가 실행 쪽과 같은 곳이어야 한다. `--operator`가 없으면 사용법 오류(2)로 끝난다.

```
node --import tsx scripts/ops/ai-task-ranks.ts set --operator=<이름> --task=audit-second-opinion --slot=1 \
  '--rank1=gpu3090-qwen|qwen3.8-flash-next' '--rank2=m3-deepseek|deepseek-v4.1-flash-1017'
```

되돌리기는 1순위만 다시 저장한다. 2순위가 빠지면 실행 쪽은 다른 모델을 고르지 않는다. 덧붙인 정책 route·계약은 남지만 쓰이지 않는다.

```
node --import tsx scripts/ops/ai-task-ranks.ts set --operator=<이름> --task=audit-second-opinion --slot=1 \
  '--rank1=gpu3090-qwen|qwen3.8-flash-next'
```

### 적용 전 확인할 것(운영 읽기, 이번 작업에서 하지 않음)

- 연결 이름이 정확히 `gpu3090-qwen`·`m3-deepseek`인지 확인한다. `status`로 본다.
- 웹 프로세스가 M3 DeepSeek 계약을 읽을 수 있는지 확인한다. 관리 표의 계약 또는 웹 env의 `LOCAL_MODEL_SERVING_CONTRACTS`면 된다.
  - 계약이 워커 env에만 있으면 저장이 「같은 서버인지 모른다」로 거절한다. 같은 주소·모델의 표 행을 새로 만들어 다른 단계의 경로를 닫지 않게 하기 위해서다.
- `m3-deepseek` 연결의 장비 이름과 그 계약의 `physicalGroup`이 같은지 확인한다.

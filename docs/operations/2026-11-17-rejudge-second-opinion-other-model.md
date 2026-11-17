# 재판정 거절의 다른 모델 두 번째 의견 — PR #988

PR: https://github.com/JRVector9/nomorevibe/pull/988

## 완료·남은 일

- [x] 최신 origin/main 전용 브랜치·착수 Draft PR 생성
- [x] 원인 확인·지정 회귀 시험에서 수정 전 실패 확인(1 실패·2 통과)
- [x] 기존 순위·로컬 계약·용량 장부를 통한 다른 모델 선택 구현
- [x] 운영 읽기 전용 확인: 2026-11-17 11:40:17Z 캠페인 7 미결 거절 32건, 모두 local-direct / qwen3.8-flash-next
- [x] 작업 전용 Postgres 범위 통합 시험
- [x] next typegen·tsc 통과
- [ ] 최종 lint·배포 scope 확인
- [ ] 전용 브랜치 커밋·push·최종 CI check 확인
- [ ] PR 본문·개발 보고함 최종 보고

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

## 적용·되돌리기

마이그레이션·CHECK 재구성은 없다. 코드 되돌림은 이 PR 구현 커밋의 revert 후 기존 배포 절차를 따른다.
일반 모델 호출 앱 교체의 DRAIN은 기존 배포 정책대로 하며, 이 작업은 배포하지 않는다.

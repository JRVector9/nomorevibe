# PR-08 구현과 공통 소비자 연결

이 변경은 기존 Sonnet `product-intro-check`의 선택식·성공행·시도수를 바꾸지 않는다. 같은 소개로 성공 처리된 `needs_editor`를 운영자가 현재 사진으로 명시 요청한 경우만 별도 큐에 넣는다. 기본 task 제어는 off다.

## 제공 API

- `planIntroRechecks(productIds, database?)`: 최대 50개 명시 ID의 현재 적격 사진을 읽는다. 제품·check의 `::text` 원시 시각, check 전체 JSON 해시, repoLinkVersion, 작성자 보호를 담는다.
- `requestIntroRecheck(plan, actor, database?)`: DR writer fence와 제품 세대를 잠그고 원시 사진·task 제어를 다시 확인한다. 같은 source/policy/prompt는 한 번만 enqueue하고 별도 요청 감사를 남긴다. off는 disabled다.
- `introRecheckCandidateSchema`, `introRecheckSourceHash`: 공통 source union에 추가할 `kind='intro_recheck'` 계약이다. 원 작업은 `product-intro-check`다.
- `buildIntroAssistInput(candidate, freshSources)`: model task는 `intro`다. 오래된 검색용 발췌는 truncated로 남긴다. 새 complete 페이지/화면은 현재 제품 URL, README는 현재 repo URL의 경로에 속해야 한다. 15분이 지난 complete 자료·다른 제품 화면은 교정 권한에 쓰지 않는다.
- `buildIntroCorrectionMessages`, `introCorrectionRequestHash`, `introCorrectionPromptHash`: Qwen 사실 판정과 분리한 두 번째 계량 호출의 입력이다. `INTRO_CORRECTION_PROMPT_VERSION`을 native binding에 기록한다.
- `validateIntroCorrection`: source/input/factual outcome 지문·strict JSON·complete 원문 인용을 검증하고 기존 `decideIntro`를 재사용한다. 의미 정확성 전체를 코드만으로 보증하지 않는다.
- `saveIntroCorrection(tx, record)`: 별도 교정 후보를 저장한다. 이 저장만으로 제품을 바꾸지 않는다.
- `applyIntroAssistCorrection(tx, claim, candidate, input, factual, correctionId)`: work claim, confirm/dispatch/apply 제어, 원 작업 pause, 현재 raw 제품/check 사진과 maker 보호, 사실 결과 행, 별도 settled native 교정 호출을 검사한 뒤 원자 적용한다.

메이커의 성능 주장에 대한 `wrong` 판정은 새 경로에서도 교체할 수 없다. 새 경로에서 기계적으로 허용하는 maker 예외는 소개가 제품 이름 그대로인 경우뿐이다. 기존 Sonnet의 MAKER_JUNK 범위는 건드리지 않는다. claimed 제품·active maker·editor/ai_fixed 소개는 제외한다.

## 부모 통합 항목

1. 공통 task/source union에 `intro_recheck`와 `introRecheckCandidateSchema`를 추가한다. schema export에 `intro-assist-schema`를 추가하고 0121을 journal에 등록한다. 0121은 0120 뒤에 task CHECK를 가산 확장한다.
2. claim/dispatch에서 `source.snapshot`의 현재 raw 사진을 다시 검증한다. `readIntroRecheckSnapshot`과 snapshot 해시 비교를 재사용한다. 첫 사실 입력과 prompt/policy 지문도 묶는다.
3. 1차 Qwen 사실 결과는 공통 results에 저장한다. retain/human/근거 부족은 원 제품과 Sonnet check를 유지한다. rewrite_candidate에 교정문이 없으면 needs_editor/human으로 남긴다.
4. 별도 교정 호출의 native target은 `{kind:'assist',purpose:'intro_correction',workId,workRevision,claimToken,task:'intro_recheck',subjectId,backendId}`다. binding.inputHash는 `introCorrectionRequestHash`, sourceRevisionHash는 후보 sourceHash, promptVersion은 `INTRO_CORRECTION_PROMPT_VERSION`이다. 같은 업무의 논리 key는 backend/purpose 교체로 우회할 수 없어야 한다.
5. 별도 호출에서 실제 response/contract/model/backend 해시와 strict 교정 후보를 `intro_assist_corrections`에 저장한다. 사실 호출 requestId를 교정 proof로 재사용할 수 없다. apply hook은 `local_model_terminal`과 settled ledger를 실제 DB에서 확인한다.
6. 실제 교정은 같은 TX에서 apply hook을 호출한다. 원 check의 attempts/updatedAt/original*는 유지하며, 별도 operation audit에 이전 소개·출처·설명과 두 결과 ID를 남긴다. 소개와 같던 설명만 함께 바꾸고 검색 프로필을 지운다.

부모가 구현할 공통 handler·native domain 증명·두 번째 계량 호출의 실제 성공 적용 회귀는 아직 이 독립 브랜치의 완료 주장에 포함하지 않는다. 무계량 모델 실행 adapter는 만들지 않았다.

## 명시 요청 도구

```bash
INTRO_ASSIST_DATABASE_URL=... node --import tsx scripts/ops/intro-assist-recheck.ts plan --ids=1,2 --out=/private/path/intro-plan.json
INTRO_ASSIST_DATABASE_URL=... node --import tsx scripts/ops/intro-assist-recheck.ts apply --plan=/private/path/intro-plan.json --actor=operator-name
```

plan은 읽기만 하고 새 파일을 0600으로 만든다. apply는 현재 사진과 제어를 재확인해 queued/duplicate/disabled/stale 수만 출력한다. DB URL과 제품 원문은 stdout에 출력하지 않는다. 이 개발 중 실제 운영 DB에서 실행하지 않았다.

## 검증 기록

2026-10-23 격리 PostgreSQL `127.0.0.1:55573`에서 기준 main migration 뒤 0119와 0121을 직접 적용했다. 0121 최종 prompt_hash 추가는 동등한 ALTER로 확인했다. parent journal 통합은 수행하지 않았다.

- 신규 unit 8건 + 기존 소개 판정 13건 = 21건 통과.
- 신규 DB 5건 + 기존 Sonnet 검수 7건 + 소개 수정 요청 9건 = 21건 통과.
- 교정 JSON·사실 결과를 저장해도 별도 settled native 호출이 없으면 제품과 원 Sonnet 행이 바뀌지 않는 회귀를 포함한다.
- 최초 전체 tsc의 새 테스트 literal 타입 오류와 미사용 type import 경고를 수정한 뒤 최종 전체 tsc 및 변경 파일 ESLint `--max-warnings=0`이 통과했다. Next typegen도 실행했다.
- 명시 plan CLI는 격리 DB에서 현재 후보 1건을 0600 파일로 만들었다. off 상태의 apply는 disabled=1로 끝났고 잘못된 명령은 exit 1로 거절했다.
- 실제 모델 호출·운영 DB 쓰기·배포·기능 활성화는 수행하지 않았다.

# AI 기여 표기 검증 구현 PR

## 범위

공개 흔적을 AI 실행 확정값으로 승격하지 않는다. 설정·모델 선언은 개발 기여 요건에서 제외하고, 원문 커밋과 실제 변경 경로를 연결한 **기여 표기**를 검증한다. 제작자 신고는 기존 값을 유지한다. 공개 AI 흔적 열, PR/Actions 전면 수집, 소유자 연동, 전체 이력 검색, 생산 DB 변경은 포함하지 않는다.

## PR 1 — 판정 기준

[PR #110](https://github.com/JRVector9/nomorevibe/pull/110), branch `feat/agent-evidence-policy`, base main.
모델 설정으로 개발 근거를 충족하던 경로와 committer-only 표기의 승격을 제거한다. REVIEW_RULES_VERSION을 올려 이전 승인 캐시를 재사용하지 않는다. 과거 설정 기반 양성 테스트는 같은 의도의 기여 표기 fixture로 변경했다.

검증: 단위89, 통합11+발행34 통과. Next typegen/TSC/lint/diffcheck 통과, 독립 리뷰 CLEAN. 초기 격리 TSC의 PageProps 없음은 typegen 후 해결. 리뷰어 테스트는 읽기 전용 임시 폴더 권한으로 실행되지 않았으며 테스트 수치는 구현 환경 실행 결과다.

## PR 2 — 커밋 원문 검증

[PR #111](https://github.com/JRVector9/nomorevibe/pull/111), branch `feat/agent-commit-evidence`, base PR 1.

- 기존 검색에서 발견한 최대5개 SHA/회차를 유지한다. API12회/20초/회차와 재개 커서도 유지한다.
- SHA가 일치하는 단일 부모 커밋의 실제 변경 경로(`changes>0`)를 요구한다. 범위를 지정했으면 그 제품 경로 아래 변경만 사용한다. 기본 브랜치의 조상 또는 동일 커밋인지 확인한 뒤에만 저장한다.
- 최대20개 경로, 검사한 head SHA, 표기 종류(coauthor/author/committer)를 JSONB 관측에 추가한다. 이메일·커밋 메시지·diff 본문은 저장하지 않는다.
- Aider 공식 문서의 `(aider)` author/committer 구분을 적용한다. committer-only는 관측으로 보존하되 작성 기여 요건에서 제외한다. [공식 문서](https://aider.chat/docs/git.html#commit-attribution)
- 문서/예제/템플릿/벤더/테스트/생성 폴더 등만 바뀐 경우는 작성 기여 요건에서 제외한다. 명시적인 소스 확장자 목록을 사용하므로 알려지지 않은 언어·설정만 변경한 실제 개발을 놓칠 수 있다. 이는 변경 경로의 유형 분류이며 코드의 의미나 작성 주체 인증이 아니다.
- 파일 목록 누락/오류는 미확인, 다음 파일 페이지가 있으면 partial로 처리한다. 전체 변경을 확인했다고 주장하지 않는다. 이 단계는 큰 커밋의 모든 파일 페이지를 순회하지 않는다.
- 포크(또는 fork 메타데이터 미확인)는 상속 기여와 독자 기여를 구분하기 전까지 커밋 기여 수집에서 보수적으로 제외한다. 포크 자체 개발도 놓치는 한계가 있다.
- detector/prompt `2026-09-14.1`, rules `2026-09-14.2`. 이전 관측은 보존하지만 변경 경로 근거 없는 legacy 표기는 새 요건을 충족하지 않는다. 새 schema migration은 없다.

**배포 시 운영 주의:** 저장된 `agentEvidence.detectorVersion`은 운영자의 호환성 게이트다. 코드 배포와 수집기의 버전을 맞춘 뒤 명시적으로 `2026-09-14.1`로 맞춰야 한다. 다르면 판정은 보수적으로 pending을 유지한다. 이번 PR 생성 과정에서는 운영 설정·데이터를 변경하지 않았다. collection/display/enforce 플래그를 묶어서 켜지 않는다.

검증: collector 변경 전 양성 proof 회귀 실패 확인, 최종 관련 단위75/통합62/TSC/lint/diffcheck 통과. 새 순수 helper 테스트는 collector 통합 전 먼저 통과했고, 그 결과를 RED라고 주장하지 않는다. 독립 리뷰에서 P1(9/10) 포크 전환 후 기존 근거 잔존, P2(8/10) prompt 버전 누락을 발견했다. 두 항목을 수정하고 포크 전환 회귀 RED→GREEN을 확인했다. JSONB coverage에 포크 상태를 보존하며, 같은 head 재검사에서 기존 커밋 근거를 삭제한다. 후속 독립 리뷰 CLEAN.

읽기 전용 실측: 3개 공개 저장소에 새 collector를 실행, 각각 API4회로 complete/error없음. 고정된 현재 head 캐시를 지정해 설정 파일 재탐색은 생략하고 발견 커밋만 검증했다. 전체 수집 워크로드/정확도 검증이 아니다. 한 커밋에는 Claude/Codex/Copilot/Cursor/Aider 5개 이름이 함께 있다. 그래서 표기 수를 실행 횟수나 실제 도구 사용 확정 수로 해석하지 않는다.

원문은 [Aider 포함 표기](https://github.com/ahoshinet/sukikirai-vrc/commit/f13846827e14ad87f03b612f18e57566f1ea32aa), [Claude 표기](https://github.com/layerrail/layerrail/commit/abcc9e92f8e02a9d69fea3403cbb0c7a183650f3), [Codex 표기](https://github.com/keishingu/cairn/commit/c3d07eb1f09b29fec3010080d4b759c8903fddb2). 검증자료 `/tmp/nomorevibe-agent-prs/.crawl-samples/commit-proof-live.json`.

## PR 3 — 읽기 전용 검증 보고서

Branch `feat/agent-attribution-audit`, base PR 2. PR URL은 생성 후 기록한다.

- 발행 상태 seeded/verified 전체를 ID 순서로 페이지 조회한다. 100개는 페이지 크기이며 전체 제한이 아니다.
- DB 트랜잭션은 repeatable read + read only이다. 수집 중 데이터가 바뀌어도 한 보고서의 기준을 유지한다. 제공자 API나 운영 설정 쓰기는 없다.
- 최신 루트 검사, 현재 detector, 24시간 이내 성공, 공개된 제품→저장소 연결 근거와 변경 파일 proof를 모두 확인한 기여 표기만 도구별 프로젝트 수에 넣는다. 같은 도구의 여러 커밋은 한 프로젝트로 센다.
- 구버전/미검사/부분/오래된/실패 검사, 연결 미확인, legacy·committer-only·문서 변경을 별도 사유로 기록한다. 이는 AI 미사용 판정이 아니다.
- 제작자 신고는 기존 공개 신고 조건(source≠crawler 또는 claimed)을 그대로 적용하고, 원래 도구 이름으로 별도 집계한다. 자동 관측과 합산하거나 builder를 덮어쓰지 않는다.
- JSONL에는 header, product별 원문 URL·변경 경로·제외 사유, summary, 마지막 complete 마커를 넣는다. 신규 파일만 생성하며, 마커가 없으면 불완전한 보고서다. 공개 지표나 AI 흔적 열을 추가하지 않는다.

실행 (읽기 권한이 있는 DATABASE_URL 환경에서):

```sh
npx tsx scripts/audit-agent-attribution.ts --output /tmp/agent-attribution-new.jsonl
```

검증: 단위13/통합7/TSC/대상 lint 통과. 통합 테스트는 페이지 경계, 숨김 링크, 저장소 URL 정규화, 미발행 제외, 중복 제거, 제작자 신고 분리, CLI 완료 마커와 덮어쓰기 거부를 전용 DB에서 확인했다. 독립 리뷰 P1(confidence10/10)에서 저장소 주소 정규화 불일치를 발견했다. SQL regex를 서비스의 normalizeTypedLink로 교체하고 http/www/대문자 .GIT/인코딩/중복 슬래시5개 회귀 통과. 후속 리뷰 진행 중.

운영 읽기 전용 실측: 2026-09-14 02:32:10 KST 최종 재검사, 발행6,877개; 구버전 검사5,184개/미검사1,693개, 새 기준 충족 기여 표기0개, 공개 조건을 충족한 제작자 신고0개. 새 코드로 재수집하지 않은 운영 DB이므로 0개는 AI 미사용이나 탐지 정확도를 뜻하지 않는다. `.crawl-samples/attribution-audit-prod-20260914-final.jsonl`에 완료 마커를 확인했다. 운영 DB/설정 쓰기0회.

## 전체 검증 중 발견한 기존 테스트 불일치

PR CI에서 홈/상세 테스트7개가 실패했다. 기준 main 20129d5 별도 worktree에서도 동일7개 실패를 재현해 이번 탐지 변경과 구분했다. 이전 전체 목록 조회 전환 및 설명 문구 제거가 테스트 fixture/기대값에 반영되지 않은 원인이었다. PR1에서 테스트만 현재 동작에 맞췄고, 대상35개 통과했다. 수정 도중 대표 이미지가 있는 테스트에 없음 기대값을 잘못 추가한1개 실패도 바로 고쳐 최종35개 통과했다. 실제 화면 코드는 변경하지 않았다.


전체 회귀: 단위957개 통과. 전체 통합608개 통과 후 주소 정규화 변경에 대한 최종 관련 통합7개도 통과했다. 전체 lint는 임시 실측 스크립트의 any2개를 검사한 첫 시도에서 실패했으며, 해당 비추적 스크립트를 /tmp로 옮긴 뒤 오류0(기존 vendor warning1). 프로덕션 빌드도 통과했다. 전체 통합 첫 실행의 scan-lock fixture1개는 fork/files 응답 보완 후 별도3개 및 전체608개 통과했다. 테스트를 생략하거나 기대 동작을 완화하지 않았다.

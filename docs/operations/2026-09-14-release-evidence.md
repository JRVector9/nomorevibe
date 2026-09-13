# AI 개발 근거 재검증과 릴리스 표시

2026-09-14 KST. 이 문서의 좁힌 기준이 앞선 `2026-09-14-ai-evidence.md`의 확장 제안보다 우선한다.

## 결론: AI 개발을 확정하는 탐지기는 아니다

공개 파일, 공동 작성자 표기, PR·CI 기록은 각기 제한된 사실을 보여준다. 이들을 모아도 프로젝트 전체를 AI가 작성했다는 독립적인 증명이 되지는 않는다. 앞선 제안의 탐지율·정확도는 측정되지 않았다. 관측 기록 수를 AI 개발 프로젝트 수로 환산하지 않는다.

GitHub의 Verified도 서명 검증이지 AI 사용 검증이 아니다. GitHub 웹에서 사람이 만든 커밋에도 서명이 붙는다. [GitHub 서명 검증 문서](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)

| 신호 | 확인 가능한 사실 | 사용 기준 |
|---|---|---|
| AGENTS.md / CLAUDE.md / 전용 설정 / 모델명 | 지침이나 설정이 저장소에 존재 | AI 개발·실제 사용 지표의 근거에서 제외. 원시 관측은 삭제하지 않음 |
| 코드 문체·LLM 추측·AI 관련 토픽·SDK 의존성 | 관련성이 있을 수 있음 | 사용 도구 식별에 채택하지 않음 |
| Co-authored-by, Aider 작성자 메타데이터 | 특정 커밋에 도구 기여 표기가 있음 | 원문 SHA·실제 변경·저장소 귀속 확인 후 **기여 표기 관측**으로만 표현 |
| PR 생성자 / Actions 성공 | 계정 활동 또는 워크플로 실행 | 이것만으로 코드 작성 도구라고 집계하지 않음. 리뷰·테스트·단순 커밋과 혼동 금지 |
| 제작자 직접 신고 | 제작자가 사용을 주장함 | **제작자 신고**로 출처 분리. 자동 관측을 이 필드에 덮어쓰지 않음 |
| 검증 가능한 제공자 실행 기록 + 변경 연결 | 해당 도구의 특정 작업 수행 | 향후 별도 검증 후보. 현재 확보·구현되지 않았으므로 확정 수치를 만들지 않음 |

공동 작성자 표기는 편집할 수 있고, Aider의 표기도 설정으로 끌 수 있다. Aider가 변경을 작성한 것과 기존 변경을 커밋만 한 것의 표기도 다르다. 파일 또는 표기가 없다는 이유로 미사용이라고 판정하지 않는다. [Aider 공식 Git 문서](https://aider.chat/docs/git.html#commit-attribution) Cursor도 AGENTS.md를 지원한다. [Cursor Rules](https://cursor.com/docs/rules)

### 실제 운영 표본의 원문 검증

2026-09-14 01:15 KST, 운영 DB에서 도구별 최근 관측 표본을 선택하고 공개 GitHub REST API로 재조회했다. 전체 정확도를 추정하기 위한 무작위·정답 표본이 아니다. 비밀키나 원문 대화를 수집하지 않았다.

| 표본 | GitHub 원문 | 실제 확인 |
|---|---|---|
| Aider 표기 | [ahoshinet/sukikirai-vrc · f138468](https://github.com/ahoshinet/sukikirai-vrc/commit/f13846827e14ad87f03b612f18e57566f1ea32aa) | SHA·표기 일치, 부모1, 기본 브랜치의 조상, CSS와 README 변경 |
| Claude Code 표기 | [layerrail/layerrail · abcc9e9](https://github.com/layerrail/layerrail/commit/abcc9e92f8e02a9d69fea3403cbb0c7a183650f3) | SHA·표기 일치, 부모1, 기본 브랜치의 조상, Ruby 구현·테스트 변경 |
| Codex 표기 | [keishingu/cairn · c3d07eb](https://github.com/keishingu/cairn/commit/c3d07eb1f09b29fec3010080d4b759c8903fddb2) | SHA·표기 일치, 부모1, 기본 브랜치의 조상, 아이콘 생성 스크립트와 문서 변경 |

3개 모두 HTTP200, `compare` 결과 ahead(기본 브랜치가 해당 커밋 이후로 진행), 서명 검증 false였다. 서명 false가 표기의 허위성을 입증하는 것도 아니다. **표기와 변경이 원문에 존재함을 확인했을 뿐, AI 실행이나 프로젝트 전체의 제작 주체는 입증하지 않았다.**

### 불필요한 확장 제외

- 파일 규칙을 무작정 늘리거나 모델 설정만으로 사용 도구를 채우는 제안은 제외한다.
- PR/Actions 전면 수집, 소유자 연동, 대규모 백필은 당장 구현 범위에서 뺀다. 원문까지 확인되는 기존 커밋 표기를 대상으로 범위·출처가 명확한 작은 검증 집합을 만드는 것이 먼저다.
- 검증 집합에 원본/포크 상속, 도구 튜토리얼, 문서만 변경, 리뷰 전용, 수동 공동 작성자 표기를 함께 넣는다. 실제 도구 실행 정답을 확보하지 못한 항목은 unknown으로 남긴다.
- 소스코드 생성 비율, 전체 AI 개발 프로젝트 수, 미사용률 등 입증하지 못한 지표는 제공하지 않는다. 여러 관측의 가중치 합으로 임의의 ‘확신도’를 만들지 않는다.
- **이번 작업은 탐지 확장 구현이 아니라 원문 검증과 기준 정정이다.** 기존 내부 `summary.ts`의 model_config/commit_attribution 지원 판정은 향후 이 기준으로 별도 재설계해야 한다. 현재 공개표시와 발행 자격 강제는 off이고, 이를 켜거나 설정 근거를 사용 확정값으로 승격하지 않았다. 기존 메이커 신고 지표는 유지한다.

## 최신 release는 어떻게 추출하는가

1. `lib/domain/evidence/providers/github.ts`의 `refreshGitHubEvidence()`가 `/repos/{owner}/{repo}/releases?per_page=10&page=...`를 조회한다. GitHub 저장소 정보가 304여도 릴리스는 별도로 조회한다.
2. draft를 제외하고 유효한 `published_at`이 있는 공개 릴리스를 정규화한다. `created_at`, `pushed_at`, 수집 시각을 릴리스 발행일로 대신 쓰지 않는다.
3. 회차별 최대 10개의 유효 릴리스를 모으고 수집된 항목의 published_at 내림차순 첫 항목을 `latestRelease`에 저장한다. 최대10페이지, 큰 응답은 페이지크기1로 재시도하는 예산 제한이 있다.
4. 이 값은 **수집된 공개 릴리스 중 가장 최근 발행일**이다. GitHub의 `/releases/latest` 또는 작성자가 Latest로 지정한 정식 버전과 동일하다고 보장하지 않는다. 현재는 공개 prerelease도 제외하지 않으며, 수집 범위 밖 모든 과거 릴리스까지 전수 비교하는 방식이 아니다. 이 수집 정책은 이번 화면 변경에서 바꾸지 않았다.
5. GitHub Releases를 만들지 않고 태그·커밋·사이트 배포만 하는 프로젝트는 이 날짜가 없다. GitHub 공식 문서도 Releases API가 릴리스에 연결되지 않은 일반 Git 태그를 반환하지 않는다고 명시한다. [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases)
6. 외부 조회 실패와 릴리스 없음은 다르다. 수집 실패 시 기존 성공 정보는 보존되며 상세의 출처 최신성 정보가 별도로 있다.

### 운영 저장 상태와 원문 대조

2026-09-14 01:14 KST. `seeded/verified` + GitHub URL 프로젝트, 공개 저장소 링크와 연결된 첫 번째 GitHub 근거 기준. 화면의 다운 제외 등 추가 조건과는 분모가 다르다.

- 대상 6,843개, 구조화된 저장소 정보 5,735개, 발행일 있는 릴리스 2,016개(전체의29.5%).
- 나머지4,827개를 전부 ‘GitHub 릴리스가 실제로 없는 프로젝트’라고 단정할 수 없다. 구조화 근거 미확보1,108개와 정보는 있지만 날짜가 없는3,719개가 포함된다. 실패 상태4개도 별도 관측되었다.
- 날짜 있는 표본3개와 없는 표본3개를 GitHub API로 직접 비교한 결과 모두 저장값과 일치했다. 이것은 전수 검증이 아니다.

| 프로젝트 | API 원문 | 확인 결과 |
|---|---|---|
| Yana AI | [studio-v1.5.1](https://github.com/yanacuti1121/Yana-AI/releases/tag/studio-v1.5.1) | 2026-09-10T17:53:34Z, DB와 일치 |
| WorldScript Studio | [v1.28.6](https://github.com/qnbs/WorldScript-Studio/releases/tag/v1.28.6) | 2026-09-09T22:42:26Z, DB와 일치 |
| Traycer | [host-v1.3.1](https://github.com/traycerai/traycer/releases/tag/host-v1.3.1) | 2026-09-09T23:08:24Z, DB와 일치 |
| VotePredict | [releases](https://github.com/killjoy00/votepredict/releases) | 공개 API200 + 빈 배열 |
| TimeMachine | [releases](https://github.com/timemachine-studio/tm-beta-3-ud/releases) | 공개 API200 + 빈 배열 |
| MyLesson | [releases](https://github.com/Nail1903/Lesson/releases) | 공개 API200 + 빈 배열 |

## 화면 변경과 검증

- `RepositoryEvidence.tsx`: 실제 `publishedAt`이 있고 유효한 날짜일 때만 최신 release 행을 표시한다. 날짜는 KST, machine-readable datetime은 원래 시점을 유지한다. 릴리스 원문 URL을 안전한 링크로 연결한다. URL이 없거나 안전하지 않아도 확인된 버전·날짜는 표시한다.
- 날짜 없음, 빈 문자열, 파싱 불가능한 날짜, 릴리스 없음은 행 전체를 숨긴다. 최근 push와 stars 등 다른 저장소 항목은 유지한다.
- 회귀검증 RED: 수정 전 새 테스트6개 중5실패/1통과. GREEN: `npx vitest run tests/repository-release.test.tsx tests/github-evidence.test.ts` 19개 통과. TSC, targeted ESLint, diffcheck 통과.
- 격리 프로덕션 빌드 + 기존 상세 E2E 3개 통과, 독립 Codex 리뷰 CLEAN(지적 없음, confidence 미제공). 리뷰 환경의 Vitest는 read-only 임시 디렉터리 EPERM으로 실행되지 않았고, 위 19개 테스트는 주 작업 환경에서 실제 실행한 결과다. 운영 웹2대 `4137a9ed0e22f4e92be85b3158298ba614cf65dd` 배포 완료, 양쪽 app/DB health 정상.
- 원문 검증 자료: `.crawl-samples/release-evidence-audit-20260914.json`, `.crawl-samples/release-evidence-source-check.json`. 재현 스크립트는 같은 이름의 `.ts`.

- 운영 `node .crawl-samples/release-evidence-live.mjs` 통과: 표본6개 × 1440/390px =12화면, 날짜있는3개 버전·원문href·정확한datetime표시, 없는3개 행없음. 문서가로넘침없음, pageerror0. 전체 정보 섹션의 날짜유/무 스크린샷을 직접 열어 확인했다. 증거 `.crawl-samples/release-evidence-live.json`, `release-evidence-section-{yana-ai-desktop,votepredict}.png`.

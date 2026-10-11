# 상세 페이지 개선과 스타·댓글 재활성화 PR 계획

**Goal:** 상세 정보를 작게 정리하고 이미지 확대와 README 내부 스크롤을 제공하며, 기존 스타·피드백 연동을 실제 운영 설정에 연결한다.

**Architecture:** 기존 상세 컴포넌트를 수정하고 필요한 이미지 대화상자만 클라이언트 경계로 분리한다. README 검색 발췌를 원문 전체로 오인하지 않으며, 원문 표시에는 기존 GitHub 읽기·캐시·안전한 크기 제한을 재사용한다. 스타·피드백은 기존 인증·API·전송 큐를 사용한다.

**Tech Stack:** Next.js 16.3.8, React 19, Tailwind, 기존 GitHub App 및 Dokploy.

사용자는 구현과 병렬 작업을 명시적으로 지시했으며 수동 테스트를 직접 담당한다. 추가 테스트·fixture 작성과 로컬 테스트 실행은 하지 않는다. 보호된 main에 필요한 GitHub CI `check`는 유지한다. 모든 서브에이전트와 CLI 리뷰는 `gpt-6.1-sol`, `xhigh`를 사용한다.

## PR01 — 정보 카드 축소·AI 제작 설명 제거

- 담당: `detail_compact`, worktree `/private/tmp/nomorevibe-detail-compact-20261011`.
- 수정: `components/product-detail/FactsStrip.tsx`; 페이지의 BuildTools import/호출 제거는 오케스트레이터가 통합한다.
- [x] 값·설명 글자 크기와 셀 여백을 줄이고 마지막 줄의 빈 영역을 줄인다.
- [x] 정보·조건·링크는 유지한다. 상세의 ‘무엇으로 만들었나’ 영역을 제거한다.
- [x] 코드 리뷰 후 커밋·push·PR을 생성한다.
- 사용자 확인: 모바일/데스크톱, 3·6·7개 정보, 긴 버전·라이선스.

## PR02 — 사이트 미리보기 이미지 확대

- 담당: `detail_image`, worktree `/private/tmp/nomorevibe-detail-image-20261011`.
- 수정: `components/product-detail/PreviewFigure.tsx`, 필요한 작은 client 이미지 대화상자.
- [x] 현재 이미지 우선순위·캡션·원본 없음 표시를 보존한다.
- [x] 썸네일 클릭/키보드로 이미지 전체를 화면 안에 확대한다.
- [x] 닫기·Escape·배경 클릭 및 원래 버튼으로 초점 복귀를 제공한다.
- [x] 코드 리뷰 후 커밋·push·PR을 생성한다.
- 사용자 확인: 사이트 이미지/README 이미지/이미지 없는 제품, 모바일, 키보드 닫기.

## PR03 — README 원문과 내부 스크롤

- 담당: `detail_readme`, worktree `/private/tmp/nomorevibe-detail-readme-20261011`.
- 수정: `IntroSection.tsx`, `ReadmeSection.tsx`, `lib/domain/products/readme-content.ts`. 페이지 Suspense 통합은 오케스트레이터가 담당한다.
- [x] 현재 검색 저장본의2,000자 한도(수집 캐시3,000자)와 표시600자 한도를 구분한다.
- [x] 검색·전제품 크롤러·DB schema를 바꾸지 않고 필요한 원문 읽기/캐시를 재사용한다.
- [x] 기존 fetch 크기·시간·쿼터 보호는 유지한다. 한도로 전문을 읽지 못하면 정확한 안내와 원문 링크를 표시한다.
- [x] README 영역의 높이를 제한하고 내부 스크롤·줄바꿈·키보드 접근을 제공한다.
- [x] 코드 리뷰 후 커밋·push·PR을 생성한다.
- 사용자 확인: 긴 README의 마지막 부분, 코드/표/링크, 모바일 가로 넘침, README 없는 제품.

## PR04 — 스타·댓글 운영 재활성화

- 담당: `integration_reactivation`, worktree `/private/tmp/nomorevibe-detail-rollout-20261011`.
- 수정: 실제 설정과 누락 사항을 기록하는 운영 문서. 기존 화면/API가 충분하면 추가 기능 코드를 만들지 않는다.
- [x] 웹·publisher·maintenance 주/예비6앱의 최신 플래그·origin·키 존재를 읽기 전용으로 대조한다. 비밀값은 출력/커밋하지 않는다.
- [x] Star App/Feedback App·이메일 발신·인증키의 누락을 구체화하고 새 도메인 callback/webhook을 준비한다.
- [ ] 실제 제공자 설정이 준비된 기능만 단계별로 켠다. 개인 스타는 사용자 GitHub App 승인, GitHub 피드백 전송은 제작자 설치·수신 설정이 필요하다.
- [x] 준비되지 않은 키를 가정하거나 플래그만 켜서 활성화 완료로 기록하지 않는다.
- [x] 외부 스타·이슈·메일을 임의의 사용자/저장소에 보내지 않는다. 사용자가 실사용 테스트를 담당한다.

## 충돌 관리와 완료 기준

각 agent는 별도 branch/worktree를 사용하며 자신의 파일만 변경한다. 공통 페이지 통합·인계 문서·커밋·PR·필수 CI·병합/배포는 오케스트레이터가 관리한다. PR01→02→03 순서로 최신 main을 반영하여 필수 CI가 성공한 head만 병합한다. PR04는 제공자 키 준비 상태에 따라 독립적으로 진행한다. UI 변경 배포는 검증된 최종 web digest로 두 웹을 맞추며 worker/DB를 불필요하게 변경하지 않는다.

최종 보고에는 PR 링크, 실제 반영 상태, 키 때문에 남은 단계, 사용자가 직접 확인할 화면을 구분한다. 실행하지 않은 테스트·OAuth·메일·스타·이슈 성공은 기록하지 않는다.

## 2026-10-11 진행 결과

- PR01 [#363](https://github.com/JRVector9/nomorevibe/pull/363): 최신 main 기준 필수 check 성공 후 병합, main `3607fa2`.
- PR02 [#364](https://github.com/JRVector9/nomorevibe/pull/364): 최신 main을 합친 뒤 필수 check 성공 후 병합, main `cd940e8`.
- PR03 [#365](https://github.com/JRVector9/nomorevibe/pull/365): 독립 CLI 리뷰의 저장소 루트 상대 링크 수정을 반영하고 최신 main을 합쳤다. 최신 main 기준 필수 check 성공 후 병합, main `a91eecf`.
- PR04: 키가 비어 있어 아직 기능을 켜지 않았다. 두 GitHub App 초안은 새 도메인 URL·최소 권한으로 준비됐으며 등록 확인과 Resend 발신 정보가 필요하다.

PR01 첫 CLI 리뷰는 테스트 실행 금지를 누락해 기존 검사가 실행·실패했다. 리뷰 중단 후 기존 글자13px/radius 계약과 변경된 UI 기대를 고쳤고 로컬 재실행은 하지 않았다. 그 뒤 CLI 리뷰는 실행 금지를 명시했다. CI의 실행 여부와 기능 실사용 검증은 구분한다.

화면 변경은 최종 main `a91eecf2`의 private web image로 mini2개·M3 4개에 배포했고, 실행 컨테이너와 공개 health 양쪽을 확인했다. 기능 실사용은 사용자가 직접 확인한다. 스타·피드백은 키 등록 대기 상태로 아직 ON이 아니다.

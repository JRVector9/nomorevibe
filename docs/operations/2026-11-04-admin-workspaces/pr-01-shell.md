원본 HTML 관리자 시안의 사이드바·상단·탭·간격·디자인 토큰을 실제 앱에 구현합니다. 원본 CSS를 관리자 범위로 옮기고 공개 화면의 동명 스타일과 Tailwind 제목 초기화를 격리합니다. 장식 제목을 제거하면서 검색·자동 갱신·계정·테마·모바일 메뉴와 기존 주소를 유지합니다.

각 탭은 해당 시안 구성의 실제 작업 공간으로 이동합니다. 같은 사람 확인 탭의 직접 판단·합의 완료 범위를 유지하고, 기존 고급 경로도 보존합니다.

검증: 메뉴/갱신 범위 회귀·ESLint·TypeScript, 원본/실제 동일폭 대조와 모바일 탐색. 최종 통합 범위 26파일·326테스트와 28탭 브라우저 검증은 [대조 기록](https://github.com/JRVector9/nomorevibe/blob/codex/admin-workspaces-20261104/docs/operations/2026-11-04-admin-workspaces/prototype-fidelity.md)에 있습니다.

시안 검토용 초안입니다. 저장소의 draft CI 정책과 필수 검사는 변경하지 않았습니다.

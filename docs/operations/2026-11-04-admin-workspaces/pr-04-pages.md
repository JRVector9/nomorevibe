프로젝트·콘텐츠·설정을 원본 HTML 시안의 카드·표·선택 상세·설정 패널로 구현합니다. 프로젝트는 4요약/목록·상세8탭, 품질은 4검사 종류와 근거/판단/추가의견/유지·내림 표, 소개·번역은 3요약/프로젝트별 표/실행 패널입니다. SNS·소식·랭킹과 설정 4탭도 실제 원본과 기존 보호된 처리 폼을 사용합니다.

설정 폼은 변경 비교·CAS·checkbox 단일 값·나머지 원본 값 보존·비밀값 비전달을 검증합니다. 명시적 읽기 전용 미리보기 모드는 앱 쓰기와 모델 능동 확인/관측 쓰기를 차단합니다. 기존 고급 정책·복구·외부 연동은 보존하며, 프로젝트 브라우저 코드의 server-only import와 품질 모드 전환도 실제 브라우저에서 확인했습니다.

검증: 관련 실제 form parser/경계/원본 연결 회귀·ESLint·TypeScript, [원본 시안 대조](https://github.com/JRVector9/nomorevibe/blob/codex/admin-workspaces-20261104/docs/operations/2026-11-04-admin-workspaces/prototype-fidelity.md)에서 28탭·상세8탭·품질4모드·모바일·자동 갱신 통과. 최종 통합 범위 26파일·326테스트 통과. 운영 변경·배포는 실행하지 않았습니다.

시안 검토용 초안이며 기존 draft CI 정책을 유지합니다.

후속 글자 조정: 본문과 기존 요청·검수·랭킹 편집 폼을 현재 크기에서 정확히 2 CSS px 키우는 전용 CSS를 적용합니다. 프로젝트 상세 이름은 실제 기준 22→24px이며, 관측·상태 정보는 원래 크기를 유지합니다. 기능·데이터·레이아웃은 이 후속 변경의 범위에 추가하지 않습니다.

이번 글자 조정의 기준과 실제 검증은 [폰트 검증 기록](https://github.com/JRVector9/nomorevibe/blob/codex/admin-workspaces-20261104/docs/operations/2026-11-04-admin-workspaces/typography-validation.md)에 별도로 기록합니다.

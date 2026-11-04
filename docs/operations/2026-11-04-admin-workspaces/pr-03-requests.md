검수와 요청함을 원본 HTML 시안처럼 목록과 선택 상세가 나란히 보이는 화면으로 구현합니다. 실제 후보·AI 판단·근거·기한·사용자 요청과 기존 승인/반려/반영/조건부 되돌리기를 연결하고, 원본 판·해시·CSRF·읽은 글의 변경 검사를 유지합니다.

검수 화면과 CSV는 하나의 필터를 사용합니다. 사람 확인은 직접 판단과 합의 완료를 포함합니다. 요청함 6탭은 실제 6개 원본과 등록/인증·기록을 읽고, 고급 묶음 처리와 기존 수동 분류/발행 검토 진입을 보존합니다. 원본 시안의 영속 보류 저장·미지원 CSV를 성공으로 모사하지 않습니다.

검증: 관련 큐·레이아웃·필터/CSV·권한·기한·원본 판 회귀, ESLint/TypeScript, 실제 선택 상세·28탭 탐색. [통합 검증](https://github.com/JRVector9/nomorevibe/blob/codex/admin-workspaces-20261104/docs/operations/2026-11-04-admin-workspaces/prototype-fidelity.md) 26파일·326테스트 통과 및 원본 대조 결과를 참조하세요. 운영 변경은 실행하지 않았습니다.

시안 검토용 초안이며 기존 draft CI 정책을 유지합니다.

후속 글자 조정: 요청·검수 화면은 PR01/04의 공통 글자 설정을 적용합니다. 이 조정을 위해 요청 처리·승인·반려 기능이나 원본 상태 계약을 추가 변경하지 않습니다.

이번 글자 조정의 기준과 실제 검증은 [폰트 검증 기록](https://github.com/JRVector9/nomorevibe/blob/codex/admin-workspaces-20261104/docs/operations/2026-11-04-admin-workspaces/typography-validation.md)에 별도로 기록합니다.

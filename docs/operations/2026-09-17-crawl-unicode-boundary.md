# 수집 텍스트 경계의 이모지 저장 오류

2차 심사 배포 확인 중 10:47 KST `Zee7280/ciel_frontend` 수집에서 DB 저장 오류를 발견했다. 실제 로그의 `pageMeta.textSample` 끝이 짝 없는 `\ud83d`였다. 기존 추출기는 제어문자/짝 없는 surrogate를 제거한 **뒤** UTF-16 길이로 잘라서, 경계에 있는 정상 이모지를 다시 반쪽으로 만들었다.

전용 로컬 PostgreSQL에서 해당 형태를 JSONB로 변환하면 `22P02: Unicode low surrogate must follow a high surrogate`가 발생하는 것을 재현했다. 수정한 문자열은 저장 가능했다. 처음 SQL probe는 드라이버가 JSON 문자열을 다시 직렬화해 객체가 아닌 문자열을 검사했으므로, 명시적 `::text::jsonb`로 바로잡아 재현했다.

본문·제목·설명을 길이 제한 후에도 기존 안전 문자 필터에 통과시킨다. 경계에 반쪽만 남은 이모지만 제거하고 완전한 이모지는 보존한다. 기존 길이 제한과 판정 정책은 유지한다.

회귀 테스트는 수정 전 실패, 수정 후 normalize 37개 통과. PR #118 CI 통과 후 #119와 함께 `2839ec5`로 7개 앱에 배포했다. 워커에서 normalize.ts 파일 해시 일치 확인. 11:11 관측 때 143회 시도/fetching/문서 없음이었고, 정상 스케줄의 144번째 시도에서 11:18:47 KST 수집·문서 저장 성공/오류 없음으로 바뀌었다. 횟수 초기화나 강제 재수집 없이 회복했다. [운영 전후 증거](evaluations/2026-09-17-sonnet-fallback/unicode-recovery.json).

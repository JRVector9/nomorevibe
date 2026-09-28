# GitHub 수집 계정 PAT 관리

## 현재 구현

운영 수집은 기존 `GITHUB_TOKEN` 하나가 GitHub `core` 한도에 닿으면서 잠시 멈췄다.
2026-09-28 22:39:57 UTC 한도 소진, 22:53:40 UTC 초기화, 22:54:45 UTC 원본
저장 재개를 읽기 전용으로 확인했다. 22:59:53 UTC의 기존 계정은 `JRVector9`,
core 사용 609/5,000이었다. 계정의 다른 클라이언트 사용도 이 숫자에 포함된다.

관리자 `/admin/github-accounts`에서 공개 저장소 읽기용 fine-grained PAT를 입력한다.
서버는 `/user`와 `/rate_limit`로 계정과 한도를 확인하고 숫자 사용자 ID로
등록 또는 교체한다. 별도 `GITHUB_COLLECTOR_SECRET`으로 암호화된 값만 DB에
저장하며 원문은 화면·감사 로그에 반환하지 않는다. 관리자는 계정을 수집에서
제외하거나 다시 활성화할 수 있다. 기존 환경 토큰은 이행 중 유지한다.

GitHub 요청은 계정을 자원별로 회전한다. 한 계정의 primary quota가 소진되면
다른 계정으로 같은 요청을 한 번씩 시도하고, 모두 대기 중이면 가장 이른 reset을
반환한다. 일반 권한 403, 404, 네트워크 오류는 다른 계정으로 숨기지 않는다.
secondary 제한은 전체 계정에 공유해 추가 요청을 중단한다. 등록 계정의 core
한도 헤더는 최대 30초 간격으로 DB에 관측한다. 화면의 최근 1시간 원본
저장·신규 수집 제품은 전체 결과이며 계정별 요청 효율로 계산하지 않는다.

## 운영 전환

앱 테이블 마이그레이션 0053 → 웹·crawler 주/예비 네 앱의 동일한 전용 암호화 키 →
같은 릴리스 배포 → 관리자에서 두 번째 실제 계정 PAT 등록 → 계정별 quota 관측과
원본 증가 확인 순서다. DB 서버·복제 설정은 변경하지 않는다. 두 번째 토큰이
등록되기 전에는 2계정 운영 효과를 검증했다고 주장하지 않는다.

GitHub는 primary REST quota를 인증 사용자별로 계산한다. 같은 사용자 PAT를
여러 개 발급해도 총량은 늘지 않는다. 공개 저장소 읽기용 fine-grained PAT는
GitHub의 Public repositories 선택과 최소 권한으로 만든다. 서로 다른 실제
관리 계정의 PAT라도 GitHub의 [API 약관](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)을
준수해 사용한다.

- [GitHub REST API 한도](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Fine-grained PAT 생성·관리](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [REST API 권장 사항](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

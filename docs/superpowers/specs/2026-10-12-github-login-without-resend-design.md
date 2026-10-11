# Resend 없는 GitHub 로그인 설계

사용자가 GitHub 로그인 화면·인증 구현을 승인했다. 이전에 안내한 GitHub 로그인 중심 구성, 메일 설정이 없을 때 이메일 폼 숨김, 배포 검사의 메일 필수 조건 수정 범위로 진행한다. 기존 OAuth→GitHub numeric identity→공개 계정·세션 생성 경로는 이미 구현되어 있으므로 재작성하지 않는다.

## 동작

- /login에서 GitHub 로그인을 우선 표시한다. 익명 사용자 버튼은 ‘GitHub로 로그인’, 로그인한 사용자는 기존 연결·재연결·해제 동작을 유지한다. 본인 계정의 스타 권한에 대한 명시적 동의는 유지한다.
- 이메일 키와 발신 주소가 모두 있을 때만 이메일 폼을 표시한다. 둘 다 없으면 GitHub 계정으로 가입/로그인할 수 있다. 일반 인증과 GitHub 스타 플래그가 켜져 있어야 한다. 플래그가 꺼진 현재 운영 상태를 구현 완료로 바꾸지 않는다.
- nonce GET은 기존 /api/auth/user/email/start를 재사용한다. 이름과 달리 GET은 이메일을 보내지 않는 인증 bootstrap이다. POST만 메일 설정을 요구한다. 추가 API·DB schema·인증 라이브러리·환경 플래그를 만들지 않는다.
- OAuth state/PKCE/브라우저 nonce/Origin/CSRF와 callback의 서버 토큰 교환·암호화·세션 쿠키를 유지한다. 인증 성공 후 검증된 returnTo로 복귀하고 기존 로그인 사용자는 불필요하게 다시 로그인하지 않는다. 관리자 OAuth는 변경하지 않는다.
- 배포 검사에서는 일반 세션 키를 항상 검사한다. 메일 두 값이 모두 없고 GitHub 로그인이 켜진 경우만 허용하며, 이메일 일부 입력/웹 간 불일치 또는 로그인 수단 없음은 거절한다. GitHub App 키·역할 쌍·origin·별도 암호화 키 검사는 유지한다.

## 검증·운영

사용자 지시에 따라 새 테스트와 로컬 test/typecheck/lint/build/E2E/앱 실행을 하지 않는다. 영향받은 기존 fixture/기대값만 최소 수정하고 diff 검사·부모 소스 대조·gpt-6.1-sol/xhigh 읽기 전용 독립 리뷰·최신 base 필수 원격 CI를 수행한다. 실제 GitHub 승인은 사용자가 확인한다. Resend 키·원본 .env.local·PEM·제공자 secret을 수정/출력하지 않는다. 런타임 배포·플래그 ON과 제작자 Feedback App 설치·수신 설정은 코드 결과와 구별한다.

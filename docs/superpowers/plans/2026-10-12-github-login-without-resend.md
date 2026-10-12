# GitHub Login Without Resend Implementation Plan

> **For agentic workers:** 기존 세션에서 순서대로 구현하고 소스 리뷰한다. 사용자 지정으로 새 테스트·로컬 실행을 생략하고 기능 테스트는 사용자에게 맡긴다.

**Goal:** Resend 없이 GitHub로 계정을 만들고 로그인하는 화면을 제공한다.

**Architecture:** 기존 GitHub App OAuth·PKCE·공개 identity/session 경로와 nonce GET을 재사용한다. 이메일 설정의 완전성만 서버에서 판정해 UI와 배포 검사에 반영한다.

**Tech Stack:** Next.js App Router, React, 기존 PostgreSQL/Drizzle session, Python 운영 배포 검사.

---

### Task 1: 로그인 화면과 설정 판정

Files: app/login/page.tsx, components/auth/GithubConnection.tsx, lib/domain/accounts/email-delivery.ts, lib/domain/accounts/email-login.ts.

- [x] 이메일 설정 판정 하나를 추가하고 발송 전 guard·페이지에 재사용한다.
```ts
export function emailLoginConfigured(): boolean {
  return Boolean(process.env.LOGIN_EMAIL_API_KEY?.trim() && process.env.LOGIN_EMAIL_FROM?.trim());
}
```
- [x] /login은 GitHub 섹션을 먼저 렌더하고 `signedIn={!!session}`을 넘긴다. 익명 이메일 폼은 `emailLoginConfigured()`일 때만 렌더한다. 두 수단 모두 없으면 ‘로그인을 준비하고 있습니다.’를 표시한다.
- [x] GithubConnection은 signedIn boolean으로 로그인/연결 문구와 primary CTA를 구분한다. consent·nonce GET·POST·callback·에러 처리와 연결 해제는 유지한다.

### Task 2: 메일 없이 동작하는 배포 검사

Files: scripts/ops/deploy_shared_images.py, tests/public-login-page.test.tsx, tests/e2e/github-user-connection.spec.ts. 기존 tests/test_deploy_shared_images.py는 소스 대조만 한다.

- [x] PUBLIC_USER_AUTH_ENABLED의 세션 키 검사를 유지하고 다음 메일 분기로 기존 필수 조건을 바꾼다.
```python
mail_keys = ('LOGIN_EMAIL_API_KEY', 'LOGIN_EMAIL_FROM')
if any(envs[short].get(key, '').strip() for short in web for key in mail_keys):
    for key in mail_keys:
        matched(key, web, True)
elif not flags['GITHUB_STAR_ENABLED']:
    raise ValueError('public_auth_login_method_missing')
```
- [x] 기존 로그인 화면 fixture에 GitHub-only·이메일 대체 경로를 반영하고 익명 OAuth의 기존 E2E 버튼명을 ‘GitHub로 로그인’으로 맞춘다. Python의 기존 부분 메일 입력 거절 기대는 유지한다. 새 테스트 케이스는 추가하지 않으며 로그인 수단 없음 분기는 소스로 대조한다.

### Task 3: 소스 검토와 전달

Files: docs/operations/github-stars-feedback-runbook.md, docs/operations/2026-10-11-star-feedback-reactivation.md, docs/CODEX_HANDOFF.md.

- [x] 이메일 필수였던 운영 설명을 GitHub-only 가능으로 바로잡고 기존 시간별 과거 상태 기록과 실제 배포 상태를 구별한다.
- [x] `git diff --check` exit0와 읽기 전용 독립 Codex 리뷰의 실제 결과를 기록한다. 리뷰 명령은 `codex exec -m gpt-6.1-sol -c model_reasoning_effort=xhigh -s read-only --ephemeral`이며 원본 env/PEM·테스트·앱·네트워크 실행은 금지한다.
- [ ] 변경 파일만 커밋·push/PR한 뒤 최신 base의 `gh pr checks` 필수 check 성공을 확인하고 matching head 정상 병합한다. 로컬 기능 테스트 성공을 주장하지 않는다.
- [ ] handoff와 로컬 프로젝트 일지에 코드 완료·운영 반영·사용자 OAuth 확인을 구별해 기록한다.

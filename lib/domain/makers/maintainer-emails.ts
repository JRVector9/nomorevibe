import { commitAiClaims, type CommitFacts } from '@/lib/domain/evidence/ai-level';

/**
 * 저장소 커밋 작성자 이메일 — 관리자 전용(2026-11-15 운영자 결정).
 *
 * 목적: 나중에 프로젝트 관리자에게 그 프로젝트의 지금 상황(등록·심사·노출)을 알려 주기 위해, 탐색 때 이미 받는 커밋 작성자 주소를 비공개로 남긴다.
 * 공개 화면·공개 API·탐색 캐시·RSC 에는 싣지 않는다. 읽는 곳은 관리자 화면(maintainer-emails-admin.ts)뿐이다.
 * 메일 발송 기능은 없다 — 보내기 전에 GitHub 이용 정책(요청받지 않은 메일 금지)과 정보통신망법 제50조·제50조의2 검토가 따로 필요하다
 * (docs/operations/2026-11-15-github-author-email-feasibility.md).
 *
 * 남기는 것: 실제 사람 주소로 보이는 것만. GitHub 비공개 주소(noreply), 봇, AI 도구 작성자, 예시·로컬 주소는 버린다(연락이 안 되거나 사람 주소가 아니다).
 */

export type MaintainerEmail = { email: string; name: string | null; login: string | null; commits: number };

/** 저장소 하나에 남길 주소 수 — 커밋이 많은 사람부터 */
export const MAINTAINER_EMAILS_PER_REPOSITORY = 10;
const EMAIL_MAX = 254;

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/;
/** 예약·로컬 주소(RFC 2606·6761 등) — 연락이 안 된다 */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|localhost|localdomain|local|internal|invalid|test|example|lan|home|none)$/;
/** GitHub 이 만든 비공개·시스템 주소 */
const GITHUB_SYSTEM = /(?:^|\.)users\.noreply\.github\.com$|^(?:noreply\.)?github\.com$/;
/** 사람에게 닿지 않는 받는 칸 — noreply, 봇 */
const NOT_A_PERSON = /no-?reply|\[bot\]|(?:^|[._+-])bots?$|^(?:root|admin|git|ubuntu|user|dependabot|renovate|github-actions)$/;

/** 저장해도 되는 사람 주소면 소문자로 다듬어 돌려준다. 아니면 null */
export function maintainerEmailOf(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX) return null;
  const match = email.match(EMAIL);
  if (!match) return null;
  const [local] = email.split('@');
  const domain = match[1];
  if (!/\.[a-z]{2,}$/.test(domain) || RESERVED_DOMAIN.test(domain) || GITHUB_SYSTEM.test(domain)) return null;
  if (NOT_A_PERSON.test(local)) return null;
  return email;
}

const clip = (value: string | null | undefined, max: number) => {
  const text = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max).trim();
  return text || null;
};

/**
 * 커밋 묶음에서 사람 작성자 주소를 모은다. AI 도구가 작성자인 커밋(commitAiClaims 의 author 표기)은 뺀다.
 * Co-authored-by 꼬리 줄의 주소는 보지 않는다 — 대개 도구·봇이고, 저장소를 관리하는 사람이라는 근거가 약하다.
 */
export function maintainerEmails(commits: readonly CommitFacts[]): MaintainerEmail[] {
  const found = new Map<string, MaintainerEmail & { order: number }>();
  commits.forEach((commit, order) => {
    if (commitAiClaims(commit).some((claim) => claim.basis === 'author')) return;
    const email = maintainerEmailOf(commit.authorEmail);
    if (!email) return;
    const before = found.get(email);
    if (before) {
      before.commits += 1;
      before.name ??= clip(commit.authorName, 200);
      before.login ??= clip(commit.authorLogin, 100);
      return;
    }
    found.set(email, { email, name: clip(commit.authorName, 200), login: clip(commit.authorLogin, 100), commits: 1, order });
  });
  return [...found.values()].sort((a, b) => b.commits - a.commits || a.order - b.order)
    .slice(0, MAINTAINER_EMAILS_PER_REPOSITORY).map((item) => ({ email: item.email, name: item.name, login: item.login, commits: item.commits }));
}

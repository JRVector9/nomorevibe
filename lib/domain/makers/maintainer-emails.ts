import { createHash } from 'node:crypto';
import { commitAiClaims, type CommitFacts } from '@/lib/domain/evidence/ai-level';

/**
 * 저장소 제작자 커밋 이메일 — 관리자 전용(2026-11-15 요청, 2026-11-21 소유자 결정 「프로젝트 제작자만 모아」).
 *
 * 목적: 나중에 프로젝트 제작자에게 그 프로젝트의 지금 상황(등록·심사·노출)을 알려 주기 위해, 탐색 때 이미 받는 커밋 작성자 주소를 비공개로 남긴다.
 * 공개 화면·공개 API·탐색 캐시·RSC 에는 싣지 않는다. 주소를 읽는 곳은 관리자 화면(maintainer-emails-admin.ts)뿐이다.
 * 메일 발송 기능은 없다 — 보내기 전에 GitHub 이용 정책(요청받지 않은 메일 금지)과 정보통신망법 제50조·제50조의2 검토가 따로 필요하다
 * (docs/operations/2026-11-15-maintainer-email-admin.md).
 *
 * 누구의 주소인가: 저장소의 **지금** 주인이 개인 계정일 때, 그 계정이 쓴 커밋의 주소만. 지금 주인은 같은 GraphQL 응답의 owner { __typename login }
 * 이다 — 저장된 키(owner/name)는 옮겨 가거나 이름이 바뀐 저장소에서 낡는다(GitHub 은 옛 이름으로 물어도 옮겨 간 저장소를 돌려준다).
 * 판단은 커밋 작성자의 GitHub 사용자 로그인(history.author.user.login — GitHub 이 작성자 주소를 계정에 이어 준 것)이 지금 주인 로그인과 같은지로 한다.
 * 이름 글자는 보지 않는다. 지금 주인이 조직이거나 응답에 주인이 없으면 아무것도 모으지 않는다.
 * 그 사람의 주소라도 연락이 안 되거나 사람 주소가 아닌 것(GitHub 비공개 주소·noreply·봇·AI 도구·예약 도메인)은 버린다.
 */

export type MaintainerEmail = { email: string; name: string | null; login: string | null; commits: number };
/** GraphQL 응답의 지금 주인(ai-level-query.ts RepositoryOwnerNow 와 같은 꼴) — 없으면 null */
export type MaintainerRepositoryOwner = { login: string; type: string } | null;
/**
 * 모으지 않은 까닭(주소 없이 수만 센다) — organization 지금 주인이 조직 · owner_unknown 응답에 주인이 없거나 알 수 없는 종류·로그인 꼴
 * · no_owner_commit 최근 커밋에 주인 계정이 쓴 커밋이 없음 · no_usable_address 주인 커밋은 있지만 남길 주소가 없음(비공개 주소 등)
 */
export type MaintainerEmailSkip = 'organization' | 'owner_unknown' | 'no_owner_commit' | 'no_usable_address';

/** 저장소 하나에 남길 주소 수 — 제작자 한 사람이 쓰는 주소(개인·회사) 몇 개면 충분하다. 커밋이 많은 주소부터 */
export const MAINTAINER_EMAILS_PER_REPOSITORY = 3;
const EMAIL_MAX = 254;

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/;
/** 예약·로컬 주소(RFC 2606·6761 등) — 연락이 안 된다 */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|localhost|localdomain|local|internal|invalid|test|example|lan|home|none)$/;
/** GitHub 이 만든 비공개·시스템 주소 */
const GITHUB_SYSTEM = /(?:^|\.)users\.noreply\.github\.com$|^(?:noreply\.)?github\.com$/;
/** 사람에게 닿지 않는 받는 칸 — noreply, 봇 */
const NOT_A_PERSON = /no-?reply|\[bot\]|(?:^|[._+-])bots?$|^(?:root|admin|git|ubuntu|user|dependabot|renovate|github-actions)$/;
/** GitHub 로그인 꼴(영숫자·하이픈, 39자까지) */
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

/** 주소 비교·거부 목록에 쓰는 꼴 — 앞뒤 공백을 떼고 소문자 */
export const normalizeMaintainerEmail = (raw: string) => raw.trim().toLowerCase();

/** 저장해도 되는 사람 주소면 소문자로 다듬어 돌려준다. 아니면 null */
export function maintainerEmailOf(raw: string): string | null {
  const email = normalizeMaintainerEmail(raw);
  if (!email || email.length > EMAIL_MAX) return null;
  const match = email.match(EMAIL);
  if (!match) return null;
  const [local] = email.split('@');
  const domain = match[1];
  if (!/\.[a-z]{2,}$/.test(domain) || RESERVED_DOMAIN.test(domain) || GITHUB_SYSTEM.test(domain)) return null;
  if (NOT_A_PERSON.test(local)) return null;
  return email;
}

/**
 * 거부 목록(maintainer_email_denials)의 열쇠 — 정규화한 주소의 sha256(hex). 주소 자체는 어디에도 남기지 않는다.
 * 영역 구분 접두어를 붙인다: 맨 sha256(주소)는 Gravatar 같은 공개 해시와 같아져 다른 자료와 이어질 수 있다. 비밀값은 아니다(주소를 아는 사람은 같은 값을 만든다).
 */
export const MAINTAINER_EMAIL_DENY_HASH_PREFIX = 'nomorevibe:maintainer-email-deny:v1\n';
export function maintainerEmailDenyHash(raw: string): string {
  return createHash('sha256').update(MAINTAINER_EMAIL_DENY_HASH_PREFIX + normalizeMaintainerEmail(raw), 'utf8').digest('hex');
}
export const MAINTAINER_EMAIL_DENY_HASH = /^[a-f0-9]{64}$/;
/**
 * 수집 쓰기(공유)와 관리자 거부(배타)가 나눠 잡는 advisory 잠금의 이름 — pg_advisory_xact_lock[_shared](hashtext(이 값)).
 * 거부가 commit 되기 전에 목록을 읽은 수집 쓰기가 거부 뒤에 주소를 되살리지 못하게 한다
 */
export const MAINTAINER_EMAIL_LOCK = 'maintainer_email_denials';

/** 관리자 확인 창에 보이는 가린 꼴 — 앞 한 글자와 도메인만(k***@fixture.nomorevibe.com) */
export function maskMaintainerEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * 주소 행은 jsonb(set_config → jsonb_to_recordset)로 넘어간다 — slice 가 서로게이트 쌍 가운데를 자르면 짝 없는 서로게이트가 남아
 * jsonb 가 22P02 로 묶음 전체를 거절한다. 자른 뒤 toWellFormed 로 다듬고, 다듬어 생긴 대체 문자는 끝에서 뗀다.
 */
const clip = (value: string | null | undefined, max: number) => {
  const text = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max).toWellFormed().replace(/�+$/u, '').trim();
  return text || null;
};

/**
 * 지금 주인이 개인 계정이면 그 로그인(소문자). 조직이면 'organization', 응답에 없거나 종류·로그인 꼴을 모르면 'owner_unknown'
 */
export function currentOwnerLogin(owner: MaintainerRepositoryOwner): string | 'organization' | 'owner_unknown' {
  if (!owner) return 'owner_unknown';
  if (owner.type === 'Organization') return 'organization';
  const login = owner.login.toLowerCase();
  return owner.type === 'User' && LOGIN.test(login) ? login : 'owner_unknown';
}

/**
 * 커밋 묶음에서 저장소 제작자(지금 주인 계정)의 주소만 모은다. 까닭(skip)은 주소가 하나도 남지 않을 때만 준다.
 * ownerLogin: 지금 주인이 개인 계정이면 그 로그인 — 이 저장소 키에 남은 다른 로그인의 행(옮겨 가기 전 주인)을 지우는 기준이다. 아니면 null.
 * - 지금 주인이 조직이거나 응답에 주인이 없으면 커밋을 보지 않는다.
 * - 커밋 작성자의 GitHub 로그인(authorLogin)이 지금 주인 로그인과 같은 커밋만 — 대소문자는 가리지 않는다. 로그인이 없는(계정에 안 이어진) 커밋은 뺀다.
 * - AI 도구가 작성자인 커밋(commitAiClaims 의 author 표기)은 뺀다. Co-authored-by 꼬리 줄의 주소는 보지 않는다.
 */
export function ownerMaintainerEmails(commits: readonly CommitFacts[], owner: MaintainerRepositoryOwner):
  { emails: MaintainerEmail[]; skip: MaintainerEmailSkip | null; ownerLogin: string | null } {
  const ownerLogin = currentOwnerLogin(owner);
  if (ownerLogin === 'organization' || ownerLogin === 'owner_unknown') return { emails: [], skip: ownerLogin, ownerLogin: null };
  const found = new Map<string, MaintainerEmail & { order: number }>();
  let ownerCommits = 0;
  commits.forEach((commit, order) => {
    if ((commit.authorLogin ?? '').toLowerCase() !== ownerLogin) return;
    if (commitAiClaims(commit).some((claim) => claim.basis === 'author')) return;
    ownerCommits += 1;
    const email = maintainerEmailOf(commit.authorEmail);
    if (!email) return;
    const before = found.get(email);
    if (before) {
      before.commits += 1;
      before.name ??= clip(commit.authorName, 200);
      return;
    }
    found.set(email, { email, name: clip(commit.authorName, 200), login: clip(commit.authorLogin, 100), commits: 1, order });
  });
  const emails = [...found.values()].sort((a, b) => b.commits - a.commits || a.order - b.order)
    .slice(0, MAINTAINER_EMAILS_PER_REPOSITORY).map((item) => ({ email: item.email, name: item.name, login: item.login, commits: item.commits }));
  return { emails, skip: emails.length ? null : ownerCommits ? 'no_usable_address' : 'no_owner_commit', ownerLogin };
}

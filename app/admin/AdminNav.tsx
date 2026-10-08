import Link from "next/link";
import { AdminIcon, type AdminIconName } from "./components/AdminIcon";

type NavPage = { href: string; label: string; hint: string; icon: AdminIconName };

/**
 * 메뉴 두 묶음(2026-10-08 UX 감사 ADM-22) — 날마다 손대는 "일하기"와 가끔 여는 "설정·기록".
 * 이름은 각 페이지의 h1 과 같게 둔다(ADM-28). 메뉴를 하나 더하려면 해당 묶음에 한 줄을 넣는다 —
 * 예: { href: "/admin/inbox", label: "오늘 할 일", hint: "지금 처리할 것", icon: "inbox" }.
 */
export const NAV_GROUPS: readonly { title: string; pages: readonly NavPage[] }[] = [
  {
    title: "일하기",
    pages: [
      { href: "/admin/status", label: "운영센터", hint: "서비스·작업 현황", icon: "pulse" },
      { href: "/admin/review", label: "심사 큐", hint: "후보 검토·승인", icon: "check" },
      // /admin/products 아래에 두지 않는다 — 아래에 두면 제품과 함께 선택된 것으로 보인다
      { href: "/admin/audit", label: "내릴 후보", hint: "요청·AI가 걸러낸 발행분", icon: "down" },
      { href: "/admin/products", label: "제품", hint: "목록·제품 근거", icon: "box" },
    ],
  },
  {
    title: "설정·기록",
    pages: [
      { href: "/admin", label: "크롤 설정", hint: "수집 규칙·검색 신호", icon: "sliders" },
      { href: "/admin/categories", label: "카테고리 기준", hint: "분류 정의·예시", icon: "tag" },
      { href: "/admin/evidence", label: "근거 수집 설정", hint: "출처·갱신 정책", icon: "file" },
      { href: "/admin/ranking", label: "랭킹 설정", hint: "집계·시즌 정책", icon: "bars" },
      { href: "/admin/news", label: "AI 소식", hint: "공식 피드·게시 승인", icon: "news" },
      { href: "/admin/github-accounts", label: "GitHub 수집 계정", hint: "토큰·한도 관리", icon: "key" },
      { href: "/admin/activity", label: "작업 로그", hint: "누가 무엇을 바꿨는지", icon: "clock" },
    ],
  },
];

/** critical(빨강): 지금 막혔거나 약속을 넘김 · warn(주황): 사람이 처리할 것 · neutral(회색): 참고 수 */
export type NavBadgeTone = "critical" | "warn" | "neutral";
/**
 * 메뉴 옆 배지. label 은 보이는 짧은 글자("12", "요청 14"), title 은 마우스·화면 낭독기에 주는 설명("직접 판단 12건").
 * badges 의 열쇠는 메뉴 href 다 — 운영센터는 "/admin/status", 심사 큐는 "/admin/review".
 */
export type NavBadge = { label: string; tone: NavBadgeTone; title?: string };
export type NavBadges = Partial<Record<string, NavBadge>>;

/** 수가 0 이거나 모르면 배지를 달지 않는다 — layout.tsx 가 배지를 만들 때 쓴다 */
export function countBadge(count: number | null | undefined, tone: NavBadgeTone, title?: (count: string) => string): NavBadge | undefined {
  if (!count || count <= 0) return undefined;
  const label = count.toLocaleString("ko-KR");
  return { label, tone, title: title?.(label) };
}

const isActive = (current: string, href: string) => current === href || (href !== "/admin" && current.startsWith(`${href}/`));

export function AdminNav({ current, badges = {} }: { current: string; badges?: NavBadges }) {
  return (
    <nav className="admin-navigation" aria-label="관리자 메뉴">
      {NAV_GROUPS.map((group, index) => (
        <div key={group.title} className="admin-nav-group">
          <p className="admin-nav-group-title" id={`admin-nav-group-${index}`}>{group.title}</p>
          <ul aria-labelledby={`admin-nav-group-${index}`}>
            {group.pages.map((page) => {
              const badge = badges[page.href];
              return <li key={page.href}>
                <Link href={page.href} aria-current={isActive(current, page.href) ? "page" : undefined} prefetch={false} title={page.label}>
                  <AdminIcon name={page.icon} />
                  <span className="admin-nav-text"><span>{page.label}</span><small>{page.hint}</small></span>
                  {badge && <b className="admin-nav-badge" data-tone={badge.tone} title={badge.title}>
                    {badge.title ? <><span aria-hidden="true">{badge.label}</span><span className="admin-vh">{badge.title}</span></> : badge.label}
                  </b>}
                </Link>
              </li>;
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

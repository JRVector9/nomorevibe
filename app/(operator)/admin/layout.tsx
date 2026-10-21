import { AdminShell } from "./AdminShell";
import { navBadges } from "./badges";
import { currentAdmin } from "@/lib/auth/admin";
import "./admin.css";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Each page and mutation retains its server-side authorization check.
  // 메뉴 배지·계정 — 로그인 전이거나 조회가 실패하면 배지 없이 그린다
  const admin = await currentAdmin().catch(() => null);
  const badges = admin ? await navBadges() : undefined;
  // 이 시각은 레이아웃을 그릴 때마다(처음·자동 갱신·새로고침) 바뀐다 — 화면 머리의 "마지막 갱신"이 된다.
  // 화면을 옮길 때는 레이아웃을 다시 그리지 않으므로 AdminShell 이 배지를 다시 받으며 그 시각을 쓴다
  const renderedAt = new Date().toISOString();
  return <AdminShell badges={badges?.badges} unknownBadges={badges?.unknown} account={admin?.login} renderedAt={renderedAt}>{children}</AdminShell>;
}

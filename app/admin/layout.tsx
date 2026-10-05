import { AdminShell } from "./AdminShell";
import { currentAdmin } from "@/lib/auth/admin";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { takedownSignal } from "@/lib/domain/products/takedown-view";
import "./admin.css";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Each page and mutation retains its server-side authorization check.
  // 메뉴 배지 — 내려달라는 요청이 기다리면 "내릴 후보" 옆에. 로그인 전이거나 조회가 실패하면 배지 없이 그린다
  const admin = await currentAdmin().catch(() => null);
  const takedown = admin ? await takedownSummary().then(takedownSignal).catch(() => null) : null;
  return <AdminShell badges={takedown ? { "/admin/audit": takedown } : undefined}>{children}</AdminShell>;
}

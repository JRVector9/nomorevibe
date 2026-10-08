import { AdminShell } from "./AdminShell";
import { countBadge, type NavBadges } from "./AdminNav";
import { currentAdmin } from "@/lib/auth/admin";
import { createMemo } from "@/lib/cache/memo";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { getSettings } from "@/lib/crawl/settings";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { takedownSignal } from "@/lib/domain/products/takedown-view";
import { criticalActionCount } from "./status/attention";
import "./admin.css";

/**
 * 심사 큐 배지의 "직접 판단" 수 — humanQueueOverview 는 싸지 않고 레이아웃은 페이지를 옮기거나 새로 고칠 때마다(운영센터는 10초마다)
 * 다시 그려지므로 60초 들고 있는다. 심사 큐 머리와 같은 수(overview.stages.human)라 최대 60초 늦을 수 있다.
 */
const humanCount = createMemo<number>({ ttlMs: 60_000, max: 1 });

async function navBadges(): Promise<NavBadges> {
  // 하나가 실패해도 나머지 배지와 페이지는 그린다
  const [takedown, human, critical] = await Promise.all([
    takedownSummary().then(takedownSignal).catch(() => null),
    humanCount.get("human", async () => (await humanQueueOverview(await getSettings())).stages.human).catch(() => null),
    criticalActionCount(),
  ]);
  return {
    // 내려달라는 요청 — 24시간 넘은 것이 있으면 빨강
    "/admin/audit": takedown ? { label: takedown.label, tone: takedown.tone === "bad" ? "critical" : "warn" } : undefined,
    "/admin/review": countBadge(human, "warn", (count) => `직접 판단 ${count}건`),
    // 운영센터 — 조치할 일의 critical 수(운영센터와 같은 buildActions, 30초 담아 둠·실패하면 배지 없음)
    "/admin/status": countBadge(critical, "critical", (count) => `긴급 ${count}건`),
  };
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Each page and mutation retains its server-side authorization check.
  // 메뉴 배지·계정 — 로그인 전이거나 조회가 실패하면 배지 없이 그린다
  const admin = await currentAdmin().catch(() => null);
  const badges = admin ? await navBadges() : undefined;
  return <AdminShell badges={badges} account={admin?.login}>{children}</AdminShell>;
}

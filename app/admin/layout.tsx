import { AdminShell } from "./AdminShell";
import { countBadge, type NavBadges } from "./AdminNav";
import { currentAdmin } from "@/lib/auth/admin";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { getSettings } from "@/lib/crawl/settings";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { takedownSignal } from "@/lib/domain/products/takedown-view";
import { criticalActionCount } from "./status/attention";
import "./admin.css";

/**
 * 심사 큐 배지의 "직접 판단" 수 — 심사 큐 머리와 같은 수(overview.stages.human)다. humanQueueOverview 는 싸지 않고 레이아웃은
 * 모든 관리자 화면 앞에 서므로 화면을 기다리게 하지 않는다: 담아 둔 값을 주고 60초가 지나면 뒤에서 다시 센다.
 * 처음(프로세스가 막 떴을 때)에는 배지 없이 그린다. 10분 넘게 다시 세지 못했으면 그 값은 버린다.
 */
const HUMAN_REFRESH_MS = 60_000;
const HUMAN_STALE_MS = 10 * 60_000;
let human: { count: number; at: number } | null = null;
let humanCounting: Promise<void> | null = null;

function humanBadgeCount(): number | null {
  const age = human ? Date.now() - human.at : Infinity;
  if (age >= HUMAN_REFRESH_MS) {
    humanCounting ??= getSettings().then((settings) => humanQueueOverview(settings))
      .then((overview) => { human = { count: overview.stages.human, at: Date.now() }; })
      .catch(() => undefined)
      .finally(() => { humanCounting = null; });
  }
  return human && age < HUMAN_STALE_MS ? human.count : null;
}

async function navBadges(): Promise<NavBadges> {
  // 하나가 실패해도 나머지 배지와 페이지는 그린다
  const [takedown, critical] = await Promise.all([
    takedownSummary().then(takedownSignal).catch(() => null),
    criticalActionCount(),
  ]);
  return {
    // 내려달라는 요청 — 24시간 넘은 것이 있으면 빨강
    "/admin/audit": takedown ? { label: takedown.label, tone: takedown.tone === "bad" ? "critical" : "warn" } : undefined,
    "/admin/review": countBadge(humanBadgeCount(), "warn", (count) => `직접 판단 ${count}건`),
    // 운영센터 — 조치할 일의 critical 수(운영센터와 같은 buildActions, 30초 담아 둠·기다리지 않음·실패하면 배지 없음)
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

import "server-only";
import { countBadge, type NavBadges } from "./AdminNav";
import { sharedStore } from "@/lib/cache/shared";
import { sharedStale } from "@/lib/operations/shared-cache";
import { sharedHumanQueueOverview } from "@/lib/operations/shared-reads";
import { getSettings } from "@/lib/crawl/settings";
import { pendingIntroRequestCount } from "@/lib/domain/products/intro-requests";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { takedownSignal } from "@/lib/domain/products/takedown-view";
import { criticalActionCount } from "./status/attention";

/**
 * 메뉴 배지 — 레이아웃(처음 그리기·router.refresh)과 GET /admin/nav-badges(화면을 옮긴 뒤, AdminShell)가 같은 값을 쓴다.
 *
 * 수는 모든 관리자 화면 앞에 서므로 화면을 기다리게 하지 않는다: 웹 여러 대가 나눠 쓰는 값(sharedStale)을 곧바로 주고,
 * 묵었으면 뒤에서 한 대만 다시 센다 — 관리자 화면을 몇 개 열어 두든 주 DB 에 더하는 일은 그 간격(60초·30초)에 한 번이다.
 * 심사 큐 배지의 "직접 판단" 수는 심사 큐 머리와 같은 수(overview.stages.human)다. 10분 넘게 다시 세지 못했으면 그 값은 버린다.
 * unknown — 이번에 셀 수 없었던 칸(처음·실패). 화면은 그 칸에 전에 보이던 값을 둔다(깜빡이며 사라지지 않게).
 */
const humanCount = sharedStale<number>({ namespace: "admin:human-badge", ttlMs: 60_000, staleMs: 10 * 60_000, store: sharedStore });

export type NavBadgeSet = { badges: NavBadges; unknown: string[] };

export async function navBadges(): Promise<NavBadgeSet> {
  // 하나가 실패해도 나머지 배지와 페이지는 그린다
  const [takedown, introRequests, critical, human] = await Promise.all([
    takedownSummary().then(takedownSignal).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: null })),
    pendingIntroRequestCount().then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: 0 })),
    criticalActionCount(),
    humanCount.get("human", async () => (await sharedHumanQueueOverview(await getSettings())).stages.human).catch(() => null),
  ]);
  const unknown = [
    ...(!takedown.ok || !introRequests.ok ? ["/admin/audit"] : []),
    ...(human === null ? ["/admin/review"] : []),
    ...(critical === null ? ["/admin/status"] : []),
  ];
  const signal = takedown.value, requests = introRequests.value;
  return { unknown, badges: {
    // 내려달라는 요청 — 24시간 넘은 것이 있으면 빨강. 소개 수정 요청(UX-18)은 주황으로만 덧붙인다(약속 시간이 없다)
    "/admin/audit": signal
      ? { label: requests > 0 ? `${signal.label} · 소개 ${requests}` : signal.label, tone: signal.tone === "bad" ? "critical" : "warn" }
      : requests > 0 ? { label: `소개 ${requests.toLocaleString("ko-KR")}`, tone: "warn", title: "소개 수정 요청" } : undefined,
    "/admin/review": countBadge(human, "warn", (count) => `직접 판단 ${count}건`),
    // 운영센터 — 조치할 일의 critical 수(운영센터와 같은 buildActions, 30초 담아 둠·기다리지 않음·실패하면 지난 값)
    "/admin/status": countBadge(critical, "critical", (count) => `긴급 ${count}건`),
  } };
}

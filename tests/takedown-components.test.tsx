import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TakedownStrip } from "@/app/admin/TakedownStrip";
import { AdminNav } from "@/app/admin/AdminNav";
import type { TakedownSummary } from "@/lib/domain/products/takedown-view";

/** 내려달라는 요청 알림 — 심사 큐 한 줄과 메뉴 배지 */
const summary = (over: Partial<TakedownSummary> = {}): TakedownSummary => ({
  pending: 3, overdue: 0, oldestHours: 5, handled24h: { removed: 0, dismissed: 0 }, last30d: { removed: 0, dismissed: 0 },
  lastHour: { requests: 1, owners: 1, senders: 1, noReason: 0, topReason: null }, ...over,
});

describe("심사 큐 한 줄", () => {
  it("대기가 없으면 그리지 않는다", () => {
    expect(renderToStaticMarkup(<TakedownStrip summary={summary({ pending: 0 })} />)).toBe("");
    expect(renderToStaticMarkup(<TakedownStrip summary={null} />)).toBe("");
  });
  it("24시간 안이면 주황 상태 줄, 처리 화면으로 보낸다", () => {
    const html = renderToStaticMarkup(<TakedownStrip summary={summary()} />);
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain('role="status"');
    expect(html).toContain("가장 오래된 것 5시간");
    expect(html).toContain('href="/admin/audit?tab=requests"');
  });
  it("넘긴 것이 있으면 빨강 경보, 몰리면 그 수도 적는다", () => {
    const html = renderToStaticMarkup(<TakedownStrip summary={summary({ pending: 14, overdue: 3, oldestHours: 52.4,
      lastHour: { requests: 12, owners: 9, senders: 2, noReason: 10, topReason: null } })} />);
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/내려달라는 요청 (<!-- -->)?14(<!-- -->)?건/);
    expect(html).toContain("최장 2일 4시간");
    expect(html).toContain("지난 1시간에 12건이 몰려 들어왔습니다");
  });
});

describe("메뉴 배지", () => {
  it("내릴 후보 옆에만 붙고 색을 단다", () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/review" badges={{ "/admin/audit": { label: "요청 14", tone: "critical" } }} />);
    expect(html).toContain('class="admin-nav-badge" data-tone="critical">요청 14</b>');
    expect(html.match(/admin-nav-badge/g)).toHaveLength(1);
    expect(html).toContain("요청·AI가 걸러낸 발행분");
  });
});

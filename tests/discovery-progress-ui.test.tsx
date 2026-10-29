import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiscoveryProgress } from "@/app/(operator)/admin/status/DiscoveryProgress";
import { buildDiscoveryProgress } from "@/lib/operations/discovery-progress";

describe("discovery progress operator panel", () => {
  it("shows an unavailable read as unconfirmed without inventing throughput", () => {
    const html = renderToStaticMarkup(createElement(DiscoveryProgress, { read: { ok: false, reason: "no_replica" } }));
    expect(html).toContain("탐색 계측 미확인");
    expect(html).toContain("복제본 설정이 없습니다");
    expect(html).not.toContain("신규 0");
  });
  it("separates a new rollout with no observations from recorded zeros", () => {
    const html = renderToStaticMarkup(createElement(DiscoveryProgress, { read: { ok: true, value: { at: "2026-10-28T03:30:00Z", rows: [], truncated: false } } }));
    expect(html).toContain("아직 새 탐색 계측이 없습니다");
  });
  it("exposes actual server/query counts, pending range and Korean unknown retries", () => {
    const at = "2026-10-28T03:30:00Z";
    const report = buildDiscoveryProgress(at, [{ key: "discovery-progress:korean:test", value: {
      v: 1, worker: "oracle-ko", lane: "korean", signal: "한국어 README", at,
      counts: { "2026-10-28T03:30|searchRequests": 2, "2026-10-28T03:30|koreanUnknown": 3 },
      window: { from: "2026-10-25T00:00:00Z", to: "2026-10-26T00:00:00Z" }, page: 2, blockedBy: "rate_cap",
    } }]);
    const html = renderToStaticMarkup(createElement(DiscoveryProgress, { read: { ok: true, value: report } }));
    expect(html).toContain("oracle-ko");
    expect(html).toContain("한국어 README");
    expect(html).toContain("확인 실패·재시도 3");
    expect(html).toContain("신규 적재 한도");
    expect(html).toContain("완료 범위 미확인");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/status/actions", () => ({ requestOperation: vi.fn(), setCollectionEnabled: vi.fn(), codexOperation: vi.fn() }));

import { OperationsCenter } from "@/app/(operator)/admin/status/OperationsCenter";

const data = { fetchedAt: "2026-10-18T00:00:00.000Z", observations: [], serviceInstances: [], dbLatencyMs: 3, audit: [], held: 0, heldNextRetryAt: null, jobControlVersions: {} };
const render = () => renderToStaticMarkup(<OperationsCenter jobs={[]} data={data} reviewMode="enforce" enabled
  attention={<p>ATTENTION</p>} dashboard={<p>DASHBOARD</p>} statusChips={null} diagnostics={<p>DIAGNOSTICS</p>} manual={null} crawlers={null}
  controls={<p>NEW-CONTROLS</p>} />);

beforeEach(() => { nav.params = new URLSearchParams(); });

/**
 * 원본 공급 조절·모델 경로 계약(ops-v8 PR8)은 새 요소다 — 지금 블록을 밀지 않게 진단 탭의 맨 끝(서비스 관측·작업·최근 관리자 작업 뒤)에만 둔다.
 */
describe("운영센터 진단 탭의 새 제어 칸", () => {
  it("진단 탭에서 지금 블록 모두의 뒤에 온다", () => {
    nav.params = new URLSearchParams("tab=diagnostics");
    const html = render();
    const order = ["DIAGNOSTICS", "서비스 관측", "최근 관리자 작업", "NEW-CONTROLS"].map(text => html.indexOf(text));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("전체 현황 탭에는 넣지 않는다", () => {
    const html = render();
    expect(html).toContain("DASHBOARD");
    expect(html).not.toContain("NEW-CONTROLS");
  });
});

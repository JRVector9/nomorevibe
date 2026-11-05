import { renderToStaticMarkup } from "react-dom/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConveyor } from "@/lib/operations/conveyor-model";
import { flowOverviewRequests, publicationChange, type ProjectFlowOverview, type SocialFlowOverview } from "@/lib/operations/flow-overview-model";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn(), replica: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction }, onReplica: mocks.replica }));
import { projectFlowOverviewSql, readProjectFlowOverview, socialPublicationCounts } from "@/lib/operations/flow-overview-read";
import { FlowOverviewView, PublicationTrend, SocialFlowView } from "@/app/(operator)/admin/flow/FlowOverview";
import type { TalkGroup } from "@/lib/social/talk";

const at = "2026-11-05T02:23:00.000Z";
const overview: ProjectFlowOverview = { measuredAt: at, registered: 120, listed: 100, unverified: 12, banned: 8,
  published1h: 4, published24h: 40, previous24h: 20,
  hours: Array.from({ length: 24 }, (_, index) => ({ hour: new Date(Date.UTC(2026, 10, 4, index + 3)).toISOString(), count: index === 0 ? 40 : 0 })) };
const data = buildConveyor({ now: at, enabled: true, throughput: null, flow: null, hourly: null, human: null,
  progress: null, search: null, holds: null, rejected: null, classification: null, sources: [] });

beforeEach(() => { vi.clearAllMocks(); mocks.replica.mockImplementation((load: () => unknown) => load()); mocks.transaction.mockImplementation((load: (tx: unknown) => unknown) => load({ execute: mocks.execute })); });

describe("flow overview reads and measurement scope", () => {
  it("uses positive publication transitions and equal 24-hour windows, without product-created-time proxies", () => {
    const query = new PgDialect().sqlToQuery(projectFlowOverviewSql).sql;
    expect(query).toContain('"crawl_publication_changes"."delta" = 1');
    expect(query).toContain("interval '48 hours'");
    expect(query).toContain("interval '24 hours'");
    expect(query).toContain("count(*)::int AS total");
    expect(query).toContain("generate_series(23, 0, -1)");
    expect(query).not.toContain('"products"."created_at"');
  });
  it("reads all stock states and publication windows from a bounded read-only repeatable snapshot", async () => {
    mocks.execute.mockResolvedValue([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{
      measured_at: at, total: 120, listed: 100, unverified: 12, banned: 8, last_hour: 4, current_day: 40, previous_day: 20, hours: overview.hours,
    }]);
    expect(await readProjectFlowOverview()).toEqual(overview);
    expect(mocks.replica).toHaveBeenCalledOnce();
    expect(mocks.transaction.mock.calls[0][1]).toEqual({ accessMode: "read only", isolationLevel: "repeatable read" });
    const setup = mocks.execute.mock.calls.slice(0, 2).map(([q]) => new PgDialect().sqlToQuery(q).sql).join("\n");
    expect(setup).toContain("statement_timeout = '3s'");
  });
  it("never turns missing query data into zero stock", async () => {
    mocks.execute.mockResolvedValue([]);
    await expect(readProjectFlowOverview()).rejects.toThrow("flow_overview_unreadable");
  });
  it("compares volume against an equal prior window and leaves a zero baseline percentage undefined", () => {
    expect(publicationChange(40, 20)).toEqual({ delta: 20, percent: 100 });
    expect(publicationChange(0, 20)).toEqual({ delta: -20, percent: -100 });
    expect(publicationChange(4, 0)).toEqual({ delta: 4, percent: null });
    const html = renderToStaticMarkup(<PublicationTrend overview={overview} />);
    expect(html.match(/<rect /g)).toHaveLength(24);
    expect(html).toContain("직전 24시간 20건");
    expect(html).toContain("+20건 (+100.0%)");
    expect(html).toContain("현재 시간의 부분 집계");
  });
  it("keeps the registered stock and automated publication events separate and unknown reads explicit", () => {
    const html = renderToStaticMarkup(<FlowOverviewView overview={overview} data={data} desk={null} reactionRequests={null} />);
    expect(html).toContain("전체 등록 프로젝트");
    expect(html).toContain("검증 대기 12");
    expect(html).toContain("차단 8");
    expect(html).toContain("수동 등록·현재 공개 프로젝트 총수와 범위가 다릅니다");
    const unread = renderToStaticMarkup(<FlowOverviewView overview={null} data={data} desk={null} reactionRequests={null} />);
    expect(unread).toContain("등록 원본을 읽지 못했습니다");
    expect(unread).toContain("발행 기록을 읽지 못했습니다");
    expect(unread).not.toContain("NaN");
  });
  it("does not silently count an unread user-request source as zero", () => {
    const decisions = { remaining: 0, failed: 0, done: 0, items: [], sections: [], clear: ["takedown", "introRequest", "feedback", "makerReply", "contact"].map(key => ({ key, title: key, href: "/admin/requests" })) };
    expect(flowOverviewRequests({ decisions }, 3)).toBe(3);
    expect(flowOverviewRequests({ decisions }, null)).toBeNull();
    expect(flowOverviewRequests({ decisions: { ...decisions, clear: decisions.clear.slice(1) } }, 3)).toBeNull();
  });
});

describe("SNS publication follows the real site talk selector", () => {
  const groups = Array.from({ length: 55 }, (_, index) => ({ repositoryKey: `owner/p${index}`, product: { id: index + 1 }, posts: [], score: index === 54 ? null : 60 - index })) as unknown as TalkGroup[];
  it("limits talk to 50 and applies the shared top-20 home representative approval branch", () => {
    const counts = socialPublicationCounts(groups, [{ repositoryKey: "owner/p2", homeDecision: "approved" }]);
    expect(counts).toEqual({ qualifiedProjects: 54, talkProjects: 50, homeWaiting: 2, homeProjects: 5 });
    const waiting = socialPublicationCounts(groups, []);
    expect(waiting.homeWaiting).toBe(20);
    expect(waiting.homeProjects).toBe(4);
  });
  it("shows the public switch truthfully and does not invent outbound SNS sending", () => {
    const social: SocialFlowOverview = { measuredAt: at, stored: 200, new24h: 7, linked: 80, qualifiedProjects: 12, talkProjects: 12,
      homeWaiting: 4, homeProjects: 4, publicEnabled: false, collectors: [] };
    const html = renderToStaticMarkup(<SocialFlowView data={social} />);
    expect(html.match(/class="flow-social-stage"/g)).toHaveLength(5);
    expect(html).toContain("일반 사용자 공개 꺼짐");
    expect(html).toContain("화제 노출 가능 12개");
    expect(html).toContain("외부 SNS에 게시물을 자동 송출하는 기능은 현재 없습니다");
    expect(html).toContain("홈 대표 승인은 별도 분기");
  });
});

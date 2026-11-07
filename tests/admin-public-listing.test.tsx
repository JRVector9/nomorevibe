import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn(), cancelAdminModelOperation: vi.fn() }));
vi.mock("@/app/(operator)/admin/categories/actions", () => ({ saveCategoryDefinitions: vi.fn() }));
import { FlowBoard } from "@/app/(operator)/admin/flow/FlowBoard";
import { PrototypeFlow } from "@/app/(operator)/admin/flow/PrototypeFlow";
import { CategoryDefinitionsForm } from "@/app/(operator)/admin/categories/CategoryDefinitionsForm";
import { buildConveyor, type ConveyorInputs } from "@/lib/operations/conveyor-model";
import { listingExclusionText, type PublicListingCounts } from "@/lib/operations/public-listing-model";
import { DEFAULT_CATEGORY_DEFINITIONS } from "@/lib/crawl/settings-schema";

/** 2026-11-07 운영 실측 — 공개 상태 71,733 · 목록 노출 62,890(사유는 앞 사유 하나로 센 예) */
const LISTING: PublicListingCounts = { publicStatus: 71_733, listed: 62_890,
  excluded: { profileUnclaimed: 8_108, down: 701, auditHeld: 33, repoGone: 1 },
  byCategory: { Dev: { publicStatus: 30_000, listed: 29_500 }, Profile: { publicStatus: 8_160, listed: 52 } } };

const base: ConveyorInputs = { now: "2026-11-07T00:00:00.000Z", enabled: true, throughput: null,
  flow: { stages: [], bottleneck: null, published: 71_700 }, hourly: null, human: null,
  progress: null, search: null, holds: null, rejected: null, classification: null, sources: [] };
const controls = { jobs: {}, csrf: null };
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

describe("공개 상태와 목록 노출", () => {
  it("빠진 사유는 0 이 아닌 것만, 정해진 차례로 적는다", () => {
    expect(listingExclusionText(LISTING)).toBe("주인 없는 개인 프로필 8,108 · 응답 없음 701 · 감사 보류 33 · 저장소 사라짐 1");
    expect(listingExclusionText({ excluded: { profileUnclaimed: 0, down: 3, auditHeld: 0, repoGone: 0 } })).toBe("응답 없음 3");
    expect(listingExclusionText({ excluded: { profileUnclaimed: 0, down: 0, auditHeld: 0, repoGone: 0 } })).toBeNull();
    expect(listingExclusionText(null)).toBeNull();
  });

  it("흐름 모델은 분야별 수를 싣지 않고 전체·사유만 넘긴다", () => {
    const conveyor = buildConveyor({ ...base, listing: LISTING });
    expect(conveyor.listing).toEqual({ publicStatus: 71_733, listed: 62_890, excluded: LISTING.excluded });
    expect(buildConveyor(base).listing).toBeNull();
  });

  it("고급 흐름 끝 칸: 공개 상태 · 목록 노출 · 빠진 사유와 개인 프로필 안내", () => {
    const html = renderToStaticMarkup(<FlowBoard data={buildConveyor({ ...base, listing: LISTING })} />);
    const sink = text(html.match(/class="cv-card cv-sink"[^]*?공개 프로젝트 →/)?.[0] ?? "");
    expect(sink).toContain("71,733공개 상태");
    expect(sink).toContain("목록 노출 62,890");
    expect(sink).toContain("목록에서 빠짐: 주인 없는 개인 프로필 8,108 · 응답 없음 701 · 감사 보류 33 · 저장소 사라짐 1");
    expect(sink).toContain("개인 프로필은 상세 주소만 열리고 목록·검색·sitemap 에는 없다(2026-10-09 결정)");
    expect(html).toContain("앞의 사유(개인 프로필 → 응답 없음 → 감사 보류 → 저장소 사라짐) 하나로 센다");
  });

  it("목록 노출을 못 읽으면 공개 상태만 두고 목록 노출은 — (0 이라 하지 않는다)", () => {
    const html = renderToStaticMarkup(<FlowBoard data={buildConveyor(base)} />);
    const sink = text(html.match(/class="cv-card cv-sink"[^]*?공개 프로젝트 →/)?.[0] ?? "");
    expect(sink).toContain("71,700공개 상태");
    expect(sink).toContain("목록 노출 —");
    expect(sink).not.toContain("목록에서 빠짐");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("빠진 사유에 개인 프로필이 없으면 그 안내를 붙이지 않는다", () => {
    const html = renderToStaticMarkup(<FlowBoard data={buildConveyor({ ...base,
      listing: { ...LISTING, excluded: { profileUnclaimed: 0, down: 2, auditHeld: 0, repoGone: 0 } } })} />);
    const sink = text(html.match(/class="cv-card cv-sink"[^]*?공개 프로젝트 →/)?.[0] ?? "");
    expect(sink).toContain("목록에서 빠짐: 응답 없음 2");
    expect(sink).not.toContain("상세 주소만");
  });

  it("홈 흐름의 단계별 표: 공개 완료 줄에 공개 상태 · 목록 노출과 빠진 사유", () => {
    const html = renderToStaticMarkup(<PrototypeFlow data={buildConveyor({ ...base, listing: LISTING })} desk={null} controls={controls} editor={null} />);
    const table = text(html.match(/id="prototype-stage-observations"[^]*?<\/tbody>/)?.[0] ?? "");
    expect(table).toContain("공개 상태 71,733 · 목록 노출 62,890");
    expect(table).toContain("목록에서 빠짐: 주인 없는 개인 프로필 8,108 · 응답 없음 701 · 감사 보류 33 · 저장소 사라짐 1");
    expect(table).not.toContain("현재 공개");
    const missing = text(renderToStaticMarkup(<PrototypeFlow data={buildConveyor(base)} desk={null} controls={controls} editor={null} />));
    expect(missing).toContain("공개 상태 71,700 · 목록 노출 —");
  });

  it("카테고리 기준: 분야마다 공개 · 목록, 다를 때만 목록을 함께 적는다", () => {
    const counts = { Dev: 30_000, Profile: 8_160, Games: 10 };
    const listed = { Dev: 30_000, Profile: 52, Games: 10 };
    const html = text(renderToStaticMarkup(<CategoryDefinitionsForm definitions={DEFAULT_CATEGORY_DEFINITIONS} counts={counts} listed={listed} />));
    expect(html).toContain("Profile기준 추가됨8160 · 목록 52");
    expect(html).toContain("Games10");
    expect(html).toContain("Dev · 공개 30000 · 목록 30000");
    const old = text(renderToStaticMarkup(<CategoryDefinitionsForm definitions={DEFAULT_CATEGORY_DEFINITIONS} counts={counts} />));
    expect(old).toContain("Dev · 공개 제품 30000개");
    expect(old).not.toContain("목록");
  });
});

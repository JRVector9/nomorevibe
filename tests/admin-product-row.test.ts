import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/admin/actions", () => ({
  setProductBan: vi.fn(),
  markClaimInvite: vi.fn(),
  decideRepoReviewAction: vi.fn(),
}));
vi.mock("@/app/admin/products/actions", () => ({ keepIntroAction: vi.fn() }));
import { ProductRow, type AdminProduct } from "@/app/admin/products/ProductRow";
import { repoReviewView } from "@/app/admin/products/repo-review-view";
import { PRODUCT_FILTERS } from "@/app/admin/products/filters";
import { ACTION_LINKS } from "@/app/admin/status/action-links";
import type { ProductRepoReview } from "@/lib/db/schema";

const base: AdminProduct = {
  slug: "found-app",
  name: "FoundApp",
  url: "https://found.test",
  status: "seeded",
  source: "crawler",
  unclaimed: true,
  listedAt: "2026. 8. 18.",
  inviteUrl: "https://github.com/someone/found-app/issues/new?title=x",
  publicOriginMissing: false,
  invitedAt: null,
};

const render = (over: Partial<AdminProduct>) =>
  renderToStaticMarkup(createElement(ProductRow, { product: { ...base, ...over } }));

describe("admin product row — 클레임 초대", () => {
  it("주인이 없고 GitHub 레포가 있으면 초대 링크와 보냈음 버튼을 보여준다", () => {
    const html = render({});
    expect(html).toContain("초대 이슈 열기");
    expect(html).toContain('href="https://github.com/someone/found-app/issues/new?title=x"');
    expect(html).toContain("보냈음으로 표시");
  });

  it("이미 보냈으면 시각만 보여주고 버튼은 감춘다", () => {
    const html = render({ invitedAt: "2026. 8. 29." });
    expect(html).toContain("클레임 초대 보냄 · 2026. 8. 29.");
    expect(html).not.toContain("보냈음으로 표시");
    // 제출 전에 표시를 눌렀을 수 있으니 링크는 남는다
    expect(html).toContain("이슈 다시 열기");
  });

  it("GitHub 레포가 없으면 초대할 곳이 없다고 말한다", () => {
    const html = render({ inviteUrl: null });
    expect(html).toContain("초대할 곳이 없습니다");
    expect(html).not.toContain("초대 이슈 열기");
  });

  it("공개 주소가 없어 초대를 못 만들면 레포 탓으로 돌리지 않는다", () => {
    const html = render({ inviteUrl: null, publicOriginMissing: true });

    expect(html).toContain("NEXT_PUBLIC_SITE_URL");
    expect(html).not.toContain("GitHub 레포가 없어");
  });

  it("주인이 있는 제품에는 초대 UI가 없다", () => {
    const html = render({ status: "verified", source: "skill", unclaimed: false });
    expect(html).not.toContain("초대");
  });
});

describe("admin product row — 저장소 사라짐", () => {
  it("거르기에서 넘겨준 이용 방식·시작 줄을 이름 아래에 보여준다", () => {
    const html = render({ repoGone: "설치형 · 목록에서 가려짐 · 2026. 10. 5.부터 404" });
    expect(html).toContain("설치형 · 목록에서 가려짐 · 2026. 10. 5.부터 404");
    expect(render({})).not.toContain("목록에서 가려짐");
  });
});

describe("admin product row — 저장소 사라진 웹사이트의 AI 판정", () => {
  const row: ProductRepoReview = {
    productId: 1, decision: "delist_candidate", reason: "model", answers: { same_product: false, parked: true, shutdown: false, no_content: false },
    model: "m", pageHttpStatus: 200, finalUrl: "https://found.test/", pageTitle: "found.test is for sale", pageExcerpt: null,
    reviewedAt: new Date("2026-10-08T03:00:00Z"), nextReviewAt: null, operatorDecision: null, operatorBy: null, operatorAt: null,
  };

  it("판정·이유·걸린 질문·페이지를 보여 주고 운영자 버튼 둘을 단다 — 내리기는 확인 창부터 연다", () => {
    const html = render({ repoReview: repoReviewView(row, new Date("2026-10-08T05:00:00Z")) });
    expect(html).toContain("AI: 내릴 후보");
    expect(html).toContain("AI 판단 · 다른 제품 · 주차·오류 페이지");
    expect(html).toContain("200 · https://found.test/ · “found.test is for sale”");
    // 목록 시각(lib/format/time) — 오늘이면 "12:00 (2시간 전)"
    expect(html).toContain("12:00 (2시간 전)");
    expect(html).toMatch(/<button type="button"[^>]*>유지<\/button>/);
    expect(html).toMatch(/<button type="button" aria-haspopup="dialog"[^>]*>내리기<\/button>/);
    expect(html).not.toContain('type="submit" name="decision"');
    expect(html).toContain("text-warn");
  });

  it("아직 안 본 것·차단된 것·운영자가 정한 것", () => {
    expect(render({ repoReview: null })).toContain("AI 사이트 확인 대기");
    expect(render({ repoReview: repoReviewView(row), status: "banned" })).not.toContain(">내리기<");
    const kept = repoReviewView({ ...row, operatorDecision: "keep", operatorBy: "jr", operatorAt: new Date("2026-10-08T04:00:00Z") });
    expect(kept.open).toBe(false);
    expect(render({ repoReview: kept })).toContain("운영자 유지 · jr");
    // 운영자 결정 뒤에 AI 가 다시 봤으면 다시 기다린다
    expect(repoReviewView({ ...row, operatorDecision: "keep", operatorAt: new Date("2026-10-01T00:00:00Z") }).open).toBe(true);
    expect(repoReviewView({ ...row, decision: "keep", answers: { same_product: true, parked: false, shutdown: false, no_content: false } }))
      .toMatchObject({ open: false, decision: "AI: 유지", reason: "AI 판단 · 네 질문 모두 정상" });
    expect(repoReviewView({ ...row, reason: "site_down", answers: null, pageHttpStatus: 0, finalUrl: null, pageTitle: null }))
      .toMatchObject({ reason: "사흘 넘게 응답 없음", page: "연결 안 됨" });
  });

  it("보관·이름 바뀜 거르기의 기록을 보여 준다", () => {
    expect(render({ repoNote: "이름 바뀜 → neworg/app (repo_url 은 옛 이름 그대로)" })).toContain("이름 바뀜 → neworg/app");
  });
});

describe("운영센터 → 제품 거르기 링크", () => {
  it("운영센터가 여는 거르기는 모두 제품 화면에 있는 이름이다", () => {
    // 조치할 일의 주소는 ACTION_LINKS 한 곳에 있다 — 전체 검사는 admin-status-action-links.test.ts
    const linked = Object.values(ACTION_LINKS).filter((href) => href.startsWith("/admin/products?"))
      .map((href) => new URL(href, "http://localhost").searchParams.get("filter"));
    expect(linked.length).toBeGreaterThanOrEqual(3);
    // ?filter=intro 처럼 없는 이름이면 제품 화면이 조용히 '전체'로 떨어진다
    for (const name of linked) expect(Object.keys(PRODUCT_FILTERS)).toContain(name);
  });
});

describe("admin product row — 차단 (2026-10-08 UX 감사 ADM-06)", () => {
  it("⋯ 메뉴의 차단은 submit 이 아니라 사유를 묻는 확인 창을 연다", () => {
    const html = render({});
    expect(html).toMatch(/<button type="button" aria-haspopup="dialog"[^>]*>차단<\/button>/);
    expect(html).toContain('<dialog class="admin-confirm" data-tone="danger"');
    expect(html).not.toContain('value="ban"');
  });

  it("차단된 제품은 해제 버튼만 — 확인 창 없이 바로 푼다", () => {
    const html = render({ status: "banned" });
    expect(html).toMatch(/<button type="button"[^>]*>차단 해제<\/button>/);
    expect(html).not.toContain("admin-confirm");
  });
});

describe("admin product row — 소개 확인 필요 (ADM-23)", () => {
  it("지금 소개와 검수 사유를 한 줄로 보이고 그대로 두기·차단을 단다", () => {
    const html = render({ intro: { tagline: "Loading…", problem: "근거가 기본 페이지뿐" } });
    expect(html).toContain("“Loading…”");
    expect(html).toContain("검수: 근거가 기본 페이지뿐");
    expect(html).toMatch(/>그대로 두기<\/button>/);
    // ⋯ 메뉴의 차단과 줄의 차단 — 둘 다 확인 창
    expect(html.match(/aria-haspopup="dialog"[^>]*>차단<\/button>/g)).toHaveLength(2);
    expect(render({})).not.toContain("그대로 두기");
  });
});

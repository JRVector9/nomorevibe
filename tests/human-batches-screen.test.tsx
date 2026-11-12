import type { ReactNode } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { batchGate, humanBatchesFixture, REJECT_SAMPLES, THRESHOLD_PREVIEW } from "./fixtures/human-batches";

/** 사람 확인 · 묶음 화면(조각 3b) — 읽기는 mock(고정 자료), 서버 동작은 부르지 않는다 */
const mocks = vi.hoisted(() => ({ read: vi.fn(), threshold: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/operations/human-batches-read", () => ({ readHumanBatches: mocks.read, readHumanThreshold: mocks.threshold }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { default: HumanBatchesPage } = await import("@/app/(operator)/admin/review/batches/page");

async function prerender(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(node);
  let html = "";
  for await (const chunk of prelude) html += chunk;
  return html.replace(/<!-- -->/g, "");
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const page = async (search: Record<string, string> = {}) => prerender(await HumanBatchesPage({ searchParams: Promise.resolve(search) }));
const button = (html: string, label: string) => (html.match(/<button\b[^>]*>[^<]*(?:<[^/][^>]*>[^<]*<\/[^>]+>[^<]*)*<\/button>/g) ?? [])
  .find(tag => text(tag).trim() === label);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "jr" });
  mocks.read.mockResolvedValue(humanBatchesFixture());
  mocks.threshold.mockResolvedValue({ preview: THRESHOLD_PREVIEW, samples: null });
});

describe("사람 확인 · 묶음", () => {
  it("머리줄 · 보류 묶음 · 사람에게 남은 까닭 · 요청과 감사를 실측 수 그대로 그린다", async () => {
    const html = await page();
    const plain = text(html);
    expect(mocks.read).toHaveBeenCalledWith("jr");
    expect(plain).toContain("직접 판단 4,440 2주 넘음 79 24시간 들어옴 101 사람이 끝냄 0 AI가 대신 끝냄 217");
    expect(plain).toContain("사유별 · 합계 4,792건");
    expect(plain).toMatch(/2차 심사가 갈림 4,283 \+101 AI 재확인이 처리 중 24시간 81건 다시 봄 · 거절 4건 문턱 보기/);
    expect(plain).toMatch(/저장소가 없어짐 30 \+7 한 번에 거절/);
    expect(plain).toMatch(/소개 문구 없음 133 \+2 소개 넣기/);
    expect(plain).toMatch(/승인 근거가 바뀜 8 \+8 하나씩 보기/);
    expect(plain).toMatch(/원본을 다시 못 받음 7 — 하나씩 보기 상세의 추가 수집 요청/);
    expect(html).toContain('href="#batch-repo_deleted"');
    expect(html).toContain('href="/admin/review?tab=all&amp;state=needs_review&amp;reason=no_description#review-list"');
    expect(plain).toContain("AI 확신이 문턱 0.9 아래 2,897 문턱 보기");
    expect(plain).toContain("아직 AI가 안 봄 1,103 AI가 보는 중 · 대기 602건");
    expect(plain).toContain("관리자가 보류해 둠 122 하나씩 보기");
    // 요청이 모두 0건이면 한 줄로 접고 감사 거절은 따로
    expect(plain).toContain("요청 0건 내림·소개 수정·피드백·메이커 답글·문의 감사 거절 563 · 7일 넘음 553");
    expect(html).toContain('href="/admin/audit?tab=audit"');
    // 표는 열 폭 고정, 숫자 칸은 오른쪽 정렬
    expect(html).toContain('class="hb-table"');
    expect(html).toMatch(/<td class="n">4,283<\/td>/);
    // 두 모델이 모두 거절한 묶음은 0건이고 표본도 없어 그리지 않는다
    expect(plain).not.toContain("두 모델이 모두 거절한 것");
  });

  it("표본 관문 — 5건을 다 보기 전에는 일괄 승인이 꺼져 있고 남은 표본이 열려 있다", async () => {
    const html = await page();
    const plain = text(html);
    expect(plain).toContain("두 모델이 모두 승인한 것 27건 · 바로 끝낼 수 있음");
    expect(plain).toContain("표본 5건 중 3건 봄 · 맞음 3 · 아님 0");
    expect(plain).toContain("표본을 모두 보면 켜집니다(2건 남음).");
    expect(button(html, "27건 승인")).toMatch(/disabled=""/);
    // 열린 표본은 판정하지 않은 첫 건(4/5) — 맞음·아님과 기존 상세로 가는 링크
    expect(plain).toContain("4/5");
    expect(html).toContain('href="/admin/review?tab=all&amp;focus=650017"');
    expect(button(html, "맞음 · 승인해도 됨")).toBeDefined();
    expect(button(html, "아님")).toBeDefined();
  });

  it("5건 모두 맞으면 켜지고, 하나라도 아니면 꺼지며 그 건을 따로 보인다", async () => {
    const all = { 631659: "ok", 650003: "ok", 607832: "ok", 650017: "ok", 644577: "ok" } as const;
    const fixture = humanBatchesFixture();
    fixture.panels[0] = { ...fixture.panels[0], gate: batchGate({ verdicts: all }) };
    mocks.read.mockResolvedValue(fixture);
    const open = await page();
    expect(button(open, "27건 승인")).not.toMatch(/disabled=""/);

    fixture.panels[0] = { ...fixture.panels[0], gate: batchGate({ verdicts: { ...all, 650003: "wrong" } }), members: [...fixture.panels[0].members!, 990001] };
    mocks.read.mockResolvedValue(fixture);
    const closed = await page();
    const plain = text(closed);
    expect(button(closed, "26건 승인")).toMatch(/disabled=""/);
    expect(plain).toContain("「아님」이 있어 꺼졌습니다");
    expect(plain).toContain("아님으로 본 1건 — 일괄에서 빠집니다");
    expect(plain).toContain("표본을 뽑은 뒤 들어온 1건은 이번 일괄에 넣지 않습니다.");
  });

  it("표본이 없으면 표본 열어 보기부터, 일괄 결정 기록에서 묶음째 되돌릴 수 있다", async () => {
    const html = await page();
    const plain = text(html);
    expect(plain).toContain("저장소가 없어짐 30건 · 확인 뒤 한 번에 거절");
    expect(button(html, "표본 5건 열어 보기")).toBeDefined();
    expect(html).toContain('id="batch-log"');
    expect(plain).toMatch(/#38 \S+ \S+ 두 모델이 모두 승인한 것 승인 3건 · 실패 1건 jr 묶음째 되돌리기/);
    expect(plain).toMatch(/#35 .*저장소가 없어짐 거절 1건 · 남김 1건 jr 되돌림 · 11-11 18:20/);
  });

  it("문턱 보기 — 문턱별 승인·거절·사람 몫과, 고른 구간의 거절 표본", async () => {
    let plain = text(await page());
    expect(plain).toContain("문턱 보기 · AI에 더 맡길 때");
    expect(plain).toContain("0.90 · 지금 42 46 1,532 —");
    expect(plain).toContain("0.85 120 410 1,090 0.85~0.9 거절 보기");
    expect(plain).toContain("문턱 값은 코드 값(지금 0.9)이라 이 화면에서 바꾸지 않습니다.");
    expect(mocks.threshold).toHaveBeenCalledWith(null);

    mocks.threshold.mockResolvedValue({ preview: THRESHOLD_PREVIEW, samples: REJECT_SAMPLES });
    plain = text(await page({ rejects: "0.85" }));
    expect(mocks.threshold).toHaveBeenLastCalledWith(0.85);
    expect(plain).toContain("확신 0.85~0.9 거절 표본 24시간 364건 중 무작위 2건");
    expect(plain).toContain("someone/portfolio-site 0.88 개인 포트폴리오로 설치하거나 쓸 제품이 없다. 사람 확인");
    // 지금 문턱 이상·후보에 없는 값은 받지 않는다
    await page({ rejects: "0.95" });
    expect(mocks.threshold).toHaveBeenLastCalledWith(null);
  });

  it("칸 하나를 못 읽어도 화면은 나오고 그 칸만 셀 수 없음이다", async () => {
    mocks.read.mockResolvedValue(humanBatchesFixture({ holds: null, delegate: null, assist: null, inbox: null, audit: null }));
    mocks.threshold.mockResolvedValue({ preview: null, samples: null });
    const plain = text(await page());
    expect(plain).toContain("보류 수를 셀 수 없음");
    expect(plain).toContain("AI 위임 결과를 셀 수 없음");
    expect(plain).toContain("AI가 대신 끝냄 셀 수 없음");
    expect(plain).toContain("미리보기를 읽지 못했습니다");
  });
});

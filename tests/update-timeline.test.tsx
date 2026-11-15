import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timelineSummary, type TimelineUpdate } from "@/components/product-detail/client-data";
import {
  TIMELINE_CLOSED, UpdateTimeline, UpdateTimelineView, loadAllUpdates, timelineReducer, type TimelineState,
} from "@/components/product-detail/UpdateTimeline";

/**
 * 상세 업데이트 '전체'·'접기'와 선(2026-11-15 사람 결정).
 *  - 처음에는 최신 세 줄, 세 건보다 많으면 '전체'가 나머지를 같은 출처 API 로 받아 모두 펼치고 '접기'로 돌아간다.
 *  - 선은 줄이 있는 만큼만 — 줄마다 위쪽 선 하나, 마지막 줄 아래·빈 목록에는 선이 없다.
 * 화면을 눌러 볼 DOM 이 없으므로, 부품이 쓰는 상태 전이(timelineReducer)와 받는 함수(loadAllUpdates)를 그대로 돌리고
 * 각 상태를 같은 그림 부품(UpdateTimelineView)으로 그려 본다. 실제 브라우저 확인은 PR 의 화면 사진으로 남긴다.
 */
const now = new Date("2026-11-15T03:00:00.000Z");
const update = (index: number): TimelineUpdate => ({
  id: 100 + index,
  sourceKind: "github_release",
  canonicalUrl: `https://github.com/example/app/releases/tag/v1.${index}.0`,
  title: `v1.${index}.0`,
  publishedAt: new Date(now.getTime() - (index + 1) * 3_600_000),
  observedAt: now,
});
const updates = (count: number) => Array.from({ length: count }, (_, index) => update(index));

const listItems = (html: string) => html.match(/<li [^>]*>/g) ?? [];
const lines = (html: string) => (html.match(/\bborder-[tb]\b/g) ?? []).length;
const button = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/)?.[0] ?? null;

function view(all: TimelineUpdate[], state: TimelineState = TIMELINE_CLOSED) {
  const summary = timelineSummary(all, now);
  return renderToStaticMarkup(<UpdateTimelineView {...summary} now={now} listId="updates-list" state={state} onToggle={() => {}} />);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("업데이트 선 — 줄이 있는 만큼만", () => {
  it.each([0, 1, 3, 10])("%i건: 보이는 줄 수만큼 선, 마지막 줄 아래·목록 테두리 없음", (count) => {
    const html = view(updates(count));
    const shown = Math.min(count, 3);
    expect(listItems(html)).toHaveLength(shown);
    expect(lines(html)).toBe(shown);
    for (const item of listItems(html)) {
      expect(item).toContain("border-t border-line");
      expect(item).not.toMatch(/\bborder-b\b/);
    }
    expect(html.match(/<ol [^>]*>/)?.[0] ?? "").not.toMatch(/\bborder/);
    if (count === 0) {
      expect(html).not.toContain("<ol");
      expect(html).toContain("아직 감지된 업데이트가 없습니다");
    }
  });

  it.each([[0, false], [1, false], [3, false], [4, true], [10, true]] as const)("%i건: '전체' 단추 %s", (count, present) => {
    const html = view(updates(count));
    if (!present) {
      expect(button(html)).toBeNull();
      return;
    }
    // 키보드로 누를 수 있는 진짜 단추, 펼침 상태와 펼칠 목록을 알린다
    expect(button(html)).toMatch(/^<button type="button" aria-expanded="false" aria-controls="updates-list"[^>]*>전체<\/button>$/);
    expect(button(html)).toContain("min-h-11");
    expect(html).toContain('<ol id="updates-list"');
  });
});

describe("업데이트 '전체'·'접기'", () => {
  it("상태 전이 — 누르면 받기, 받는 중 다시 눌러도 그대로, 받으면 펼침, 접었다 다시 펴면 다시 받지 않음", () => {
    const all = updates(10);
    let state = timelineReducer(TIMELINE_CLOSED, { type: "toggle" });
    expect(state).toEqual({ expanded: false, all: null, pending: true, failed: false });
    expect(timelineReducer(state, { type: "toggle" })).toBe(state);
    state = timelineReducer(state, { type: "loaded", rows: all });
    expect(state).toEqual({ expanded: true, all, pending: false, failed: false });
    state = timelineReducer(state, { type: "toggle" });
    expect(state).toEqual({ expanded: false, all, pending: false, failed: false });
    state = timelineReducer(state, { type: "toggle" });
    expect(state).toEqual({ expanded: true, all, pending: false, failed: false });
    // 늦게 온 응답은 받는 중이 아니면 버린다
    expect(timelineReducer(state, { type: "loaded", rows: null })).toBe(state);
  });

  it("못 받으면 접힌 채 알리고, 다시 누르면 다시 받는다", () => {
    let state = timelineReducer(TIMELINE_CLOSED, { type: "toggle" });
    state = timelineReducer(state, { type: "loaded", rows: null });
    expect(state).toEqual({ expanded: false, all: null, pending: false, failed: true });
    const html = view(updates(10), state);
    expect(listItems(html)).toHaveLength(3);
    expect(html).toContain('role="alert"');
    expect(html).toContain("업데이트를 더 불러오지 못했습니다");
    expect(timelineReducer(state, { type: "toggle" })).toEqual({ expanded: false, all: null, pending: true, failed: false });
  });

  it("받는 동안은 세 줄 그대로 목록에 aria-busy — 대기 문구 없이, 줄 아래 자리도 늘지 않는다", () => {
    const html = view(updates(10), { ...TIMELINE_CLOSED, pending: true });
    expect(html).toContain('<ol id="updates-list" aria-busy="true"');
    expect(listItems(html)).toHaveLength(3);
    expect(button(html)).toContain(">전체</button>");
    expect(html).not.toMatch(/불러오는 중|loading/i);
    expect(html).not.toContain('role="alert"');
  });

  it("전체를 눌러 한 번 받아 모두 그리고, 접으면 세 줄, 다시 펴도 다시 받지 않는다", async () => {
    const all = updates(10);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rows: all }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // 부품과 같은 순서: 누름 → 받는 중이면 loadAllUpdates → loaded
    let state = timelineReducer(TIMELINE_CLOSED, { type: "toggle" });
    expect(state.pending).toBe(true);
    // 개발 모드의 두 번 도는 effect 처럼 겹쳐 불러도 요청은 하나
    const [rows] = await Promise.all([loadAllUpdates("many-updates"), loadAllUpdates("many-updates")]);
    state = timelineReducer(state, { type: "loaded", rows });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["/api/products/many-updates/updates", { headers: { accept: "application/json" } }]);
    // 시각은 Date 로 되살린다 — 서버에서 그린 세 줄과 같은 모양
    expect(rows?.[0].publishedAt).toBeInstanceOf(Date);

    let html = view(all, state);
    expect(listItems(html)).toHaveLength(10);
    expect(lines(html)).toBe(10);
    for (const row of all) expect(html).toContain(`>${row.title}</a>`);
    expect(button(html)).toMatch(/aria-expanded="true"[^>]*>접기<\/button>$/);
    // 줄의 모양은 처음 세 줄과 같다
    expect(listItems(html).slice(0, 3)).toEqual(listItems(view(all)));

    state = timelineReducer(state, { type: "toggle" });
    html = view(all, state);
    expect(listItems(html)).toHaveLength(3);
    expect(html).not.toContain("v1.3.0");
    expect(button(html)).toMatch(/aria-expanded="false"[^>]*>전체<\/button>$/);

    state = timelineReducer(state, { type: "toggle" });
    expect(state.pending).toBe(false);
    expect(listItems(view(all, state))).toHaveLength(10);
    await loadAllUpdates("many-updates");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("실패한 받기는 담아 두지 않는다 — 다음에 누르면 다시 요청한다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: updates(4) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadAllUpdates("flaky-updates")).toBeNull();
    expect(await loadAllUpdates("flaky-updates")).toBeNull();
    expect(await loadAllUpdates("flaky-updates")).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("처음 그림(서버 HTML·하이드레이션)은 접힌 세 줄과 같다", () => {
    const summary = timelineSummary(updates(10), now);
    const html = renderToStaticMarkup(<UpdateTimeline slug="many-updates" summary={summary} now={now} />);
    expect(listItems(html)).toHaveLength(3);
    expect(button(html)).toMatch(/aria-expanded="false"[^>]*>전체<\/button>$/);
    const id = html.match(/<ol id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(button(html)).toContain(`aria-controls="${id}"`);
  });
});

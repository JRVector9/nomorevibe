import { prerenderToNodeStream } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn(), log: vi.fn(), watch: vi.fn(), connections: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/db", () => ({ db: { select: () => ({ from: () => mocks.connections() }) }, onReplica: (load: () => unknown) => load(), onPrimary: (load: () => unknown) => load() }));
vi.mock("@/app/(operator)/admin/activity/query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/(operator)/admin/activity/query")>(), activityLog: mocks.log,
}));
vi.mock("@/lib/operations/change-watch", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/change-watch")>(), readChangeWatch: mocks.watch,
}));

import AdminLogPage from "@/app/(operator)/admin/log/page";
import { buildChangeWatch, collectChanges } from "@/lib/operations/change-watch";
import { CONN, WATCH_AUDIT, WATCH_CONTEXT, WATCH_LEDGER, WATCH_NOW } from "./fixtures/change-watch";

/** 다 그린 HTML — 「그 뒤」 칸(Suspense 안의 비동기 구성 요소)까지 기다린다 */
async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const { prelude } = await prerenderToNodeStream(await AdminLogPage({ searchParams: Promise.resolve(searchParams) }));
  let html = "";
  for await (const chunk of prelude) html += chunk;
  return html;
}
const text = (html: string) => html.replace(/<template[\s\S]*?<\/template>/g, "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const rows = WATCH_AUDIT.map(row => ({ id: row.id, createdAt: new Date(row.at), actor: row.actor, actorKind: row.actorKind, action: row.action, target: row.target,
  detail: { ...row.detail }, ok: true, error: null, ip: null, userAgent: null }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: WATCH_NOW });
  mocks.admin.mockResolvedValue({ login: "jr" });
  mocks.log.mockResolvedValue([...rows].reverse());
  mocks.watch.mockResolvedValue(buildChangeWatch(collectChanges(WATCH_AUDIT, WATCH_CONTEXT), WATCH_LEDGER, WATCH_NOW));
  mocks.connections.mockResolvedValue([...WATCH_CONTEXT.connectionLabels].map(([id, label]) => ({ id, label })));
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

/** 기록(조각 4b, 시안 「화면 6 기록」) */
describe("log screen", () => {
  it("draws the design's table — 때 · 한 일 · 누가 · 그 뒤 · 되돌리기 — one line per change", async () => {
    const html = await render();
    expect(html).toMatch(/<table class="lg-table"><colgroup><col style="width:112px"\/><col\/><col style="width:104px"\/><col style="width:30%"\/><col style="width:112px"\/><\/colgroup>/);
    const lines = [...html.matchAll(/<tr><td class="lg-when">([^<]+)<\/td><th scope="row"><span class="lg-title">(.*?)<\/span>.*?<td class="lg-who"[^>]*>([^<]+)<\/td>/g)]
      .map(match => [match[1], text(match[2]).trim(), match[3]]);
    expect(lines).toEqual([
      ["11-12 08:08", "접수 중단 → 다시 열림 (18분)", "JR"],
      ["11-12 07:10", "1차 AI 검수 1순위를 supa로", "jr"],
      // 같은 분이면 나중에 남은 줄이 위 — 시안 차례(LG EXAONE → M1max)와 같다. M1max 의 잇단 저장 셋은 한 줄
      ["11-12 07:06", "모델 LG EXAONE 고침", "jr"],
      ["11-12 07:06", "모델 M1max 추가 · 키 바꿈 · 3번", "jr"],
    ]);
    const plain = text(html);
    // 그 뒤 — 바꾼 것 지켜보기의 판정과 처리량(조각 1c)
    expect(plain).toContain("다시 떨어짐 (실패) 첫 1시간 86건 → 지금 3건");
    expect(plain).toContain("아직 안 씀 (대기) 호출 0건 · 쓰는 단계 없음");
    // 자동 처리자(system:capacity)의 멈춤은 줄로 그리지 않고 센다 — 원시 줄은 모두 보기
    expect(plain).toContain("자동 처리 1줄");
    expect(html).toContain('href="/admin/activity">모두 보기 →</a>');
  });

  it("offers undo only where it already exists — the rank line shows now and after, and goes to the rank editor", async () => {
    const html = await render();
    expect(html.match(/<button type="button" class="button small" popovertarget="undo-[^"]+">되돌리기<\/button>/gi)).toHaveLength(3);
    expect(html).toMatch(/<div id="undo-[^"]+" popover="auto" class="lg-undo-pop" role="dialog"/);
    expect(text(html)).toContain("지금 supa → gpu3090-qwen 되돌린 뒤 OpenCode deepseek → gpu3090-qwen");
    expect(html).toContain('href="/admin/models/tasks">되돌리러 가기 →</a>');
    // 접수 중단 → 다시 열림 줄에는 되돌리기가 없다
    expect(html).toMatch(/접수 중단 → 다시 열림 \(18분\)[\s\S]*?<td class="lg-act"><\/td>/);
    expect(html).toContain(`href="/admin/activity?before=${28864 + 1}">원래 줄</a>`);
    expect(CONN.supa).toBeTruthy();
  });

  it("searches the log by a name and keeps the raw view one click away", async () => {
    const html = await render({ q: "supa" });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ q: "supa" }), 300);
    expect(html).toContain('href="/admin/activity?q=supa">모두 보기 →</a>');
    expect(text(html)).toContain("“supa”이(가) 든 줄");
    expect(html).toMatch(/<form[^>]*action="\/admin\/log"/);
  });

  it("sends a signed-out visitor to login before reading", async () => {
    mocks.admin.mockResolvedValue(null);
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
    await expect(render()).rejects.toThrow("redirect:/admin/login");
    expect(mocks.log).not.toHaveBeenCalled();
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 폼과 서버 액션을 같이 본다 — 빈 행을 그리는 쪽과 버리는 쪽이 어긋나면 신호가 늘지 않는다
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: vi.fn().mockResolvedValue({ login: "jr" }) }));
const saveSettings = vi.fn();
vi.mock("@/lib/crawl/settings", () => ({
  saveSettings: (...args: unknown[]) => saveSettings(...args),
  resetSettings: vi.fn(),
}));

const { SettingsForm } = await import("@/app/admin/SettingsForm");
const { saveCrawlSettings } = await import("@/app/admin/actions");
const { DEFAULT_CRAWL_SETTINGS } = await import("@/lib/crawl/settings-schema");
type CrawlSettings = import("@/lib/crawl/settings-schema").CrawlSettings;

/** 신호 둘만 저장된 배포 환경 — 프로덕션이 실제로 그 상태다 */
const twoSignals: CrawlSettings = {
  ...DEFAULT_CRAWL_SETTINGS,
  discover: {
    ...DEFAULT_CRAWL_SETTINGS.discover,
    queries: DEFAULT_CRAWL_SETTINGS.discover.queries.slice(0, 2),
  },
};

const render = (settings: CrawlSettings) =>
  renderToStaticMarkup(createElement(SettingsForm, { settings }));

/** 폼이 그린 값을 그대로 담은 제출 — 사람이 아무것도 손대지 않은 상태 */
function submitted(over: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("queryCount", "3");
  form.set("enabled", "on");
  twoSignals.discover.queries.forEach((q, i) => {
    form.set(`query.${i}.label`, q.label);
    form.set(`query.${i}.kind`, q.kind);
    form.set(`query.${i}.query`, q.query);
    form.set(`query.${i}.priority`, String(q.priority));
    form.set(`query.${i}.builder`, q.builder ?? "");
    if (q.enabled) form.set(`query.${i}.enabled`, "on");
  });
  // 빈 행
  form.set("query.2.label", "");
  form.set("query.2.kind", "commits");
  form.set("query.2.query", "");
  form.set("query.2.priority", "0");
  form.set("query.2.builder", "");
  for (const [key, value] of Object.entries(over)) form.set(key, value);
  return form;
}

const savedQueries = () => saveSettings.mock.calls[0][0].discover.queries;

beforeEach(() => {
  saveSettings.mockReset();
  saveSettings.mockResolvedValue({ ok: true, settings: DEFAULT_CRAWL_SETTINGS });
});

describe("검색 신호 편집", () => {
  it("저장된 신호 뒤에 빈 행을 하나 더 그린다 — 이것이 신호를 추가하는 유일한 길이다", () => {
    const html = render(twoSignals);

    // 저장된 둘 + 빈 행 하나
    expect(html).toContain('name="query.0.label"');
    expect(html).toContain('name="query.1.label"');
    expect(html).toContain('name="query.2.label"');
    expect(html).not.toContain('name="query.3.label"');
    // 서버 액션이 이 수만큼 행을 다시 만든다 — 빈 행을 세지 않으면 새 신호가 버려진다
    expect(html).toContain('name="queryCount" value="3"');
  });

  it("빈 행은 비어 있고 켜져 있지 않다", () => {
    const html = render(twoSignals);
    const input = (name: string) =>
      html.match(new RegExp(`<input[^>]*name="${name.replace(/\./g, "\\.")}"[^>]*>`))?.[0] ?? "";

    expect(input("query.2.label")).toContain('value=""');
    expect(input("query.2.query")).toContain('value=""');
    expect(input("query.2.builder")).toContain('value=""');
    expect(input("query.2.enabled")).not.toContain("checked");
    // 켜져 있는 신호는 그대로 켜져 있다
    expect(input("query.0.enabled")).toContain("checked");
  });

  it("행마다 종류를 고를 수 있다 — 레포 검색 신호를 추가하려면 필요하다", () => {
    const html = render(twoSignals);

    expect(html).toContain('name="query.2.kind"');
    expect(html).toContain("레포");
  });

  it("빈 행을 그대로 두고 저장하면 신호가 늘지 않는다", async () => {
    await saveCrawlSettings(null, submitted());

    expect(savedQueries().map((q: { label: string }) => q.label)).toEqual([
      "Claude 커밋 트레일러",
      "Codex 커밋 트레일러",
    ]);
  });

  it("빈 행에 적으면 신호가 늘어난다 — README가 말하는 길이다", async () => {
    await saveCrawlSettings(
      null,
      submitted({
        "query.2.label": "vibe-coding 토픽",
        "query.2.kind": "repositories",
        "query.2.query": "topic:vibe-coding",
        "query.2.priority": "80",
        "query.2.enabled": "on",
      }),
    );

    expect(savedQueries()[2]).toEqual({
      label: "vibe-coding 토픽",
      kind: "repositories",
      query: "topic:vibe-coding",
      enabled: true,
      priority: 80,
      builder: null,
    });
  });
});

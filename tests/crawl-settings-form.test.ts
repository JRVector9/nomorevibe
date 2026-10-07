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
  it("관리자가 500스타 이상 자동 승인 기준을 조정하고 기존 상한은 표시하지 않는다", async () => {
    const html = render(twoSignals);
    expect(html).toContain("자동 승인 최소 스타");
    expect(html).toContain('name="autoApproveMinStars"');
    expect(html).not.toContain('name="maxStars"');

    await saveCrawlSettings(null, submitted({ autoApproveMinStars: "750" }));
    expect(saveSettings.mock.calls[0][0].judge.autoApproveMinStars).toBe(750);
    expect(saveSettings.mock.calls[0][0].judge.maxStars).toBeUndefined();
  });
  it.each(["-1", "1.5", "NaN", "Infinity", "1000"])("유효하지 않은 행 수 %s 는 설정을 만들기 전에 거절한다", async (queryCount) => {
    expect(await saveCrawlSettings(null, submitted({ queryCount }))).toMatchObject({ issues: expect.any(Array) });
    expect(saveSettings).not.toHaveBeenCalled();
  });

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
      requireEvidence: false,
    });
  });

  it("행마다 'AI 흔적 필요'를 켤 수 있다 — 검색어가 AI 사용을 말하지 않는 신호를 위해", async () => {
    expect(render(twoSignals)).toContain('name="query.2.requireEvidence"');

    await saveCrawlSettings(
      null,
      submitted({
        "query.2.label": "한국어 README",
        "query.2.kind": "repositories",
        "query.2.query": "있습니다 in:readme",
        "query.2.priority": "10",
        "query.2.enabled": "on",
        "query.2.requireEvidence": "on",
      }),
    );

    expect(savedQueries()[2]).toMatchObject({ label: "한국어 README", requireEvidence: true });
    // 체크하지 않은 행은 false 로 저장된다 — 폼에서 저장한 신호는 값이 늘 있다
    expect(savedQueries()[0].requireEvidence).toBe(false);
  });
});

it('세운 대체 모델만 칸으로 그리고, 없으면 더하기 버튼을 둔다 · 입력 순서대로 저장한다', async () => {
  const withFallback: CrawlSettings = { ...twoSignals, secondReview: { ...twoSignals.secondReview, fallbacks: [{ provider: 'abcllm', model: 'qwen3-coder:30b' }] } };
  expect(render(withFallback)).toContain('name="fallbackModel0"');
  expect(render(withFallback)).not.toContain('name="fallbackModel1"');
  expect(render({ ...twoSignals, secondReview: { ...twoSignals.secondReview, fallbacks: [] } })).toContain('+ 대체 모델 더하기');
  const form = submitted({ fallbackProvider0: 'claude-cli', fallbackModel0: 'opus', fallbackProvider1: 'abcllm', fallbackModel1: 'qwen3-coder:30b' });
  await saveCrawlSettings(null, form);
  expect(saveSettings.mock.calls.at(-1)?.[0].secondReview.fallbacks).toEqual([
    { provider: 'claude-cli', model: 'opus' },{ provider: 'abcllm', model: 'qwen3-coder:30b' },
  ]);
});

/**
 * 1차 심사자·동시 실행 수는 데이터로 뺐는데 한동안 화면에 없어 스크립트로만 바꿀 수 있었다.
 * 배포 없이 조정하려고 뺀 값이라 화면이 그것을 그리고, 저장이 그것을 되돌려 보내야 한다.
 */
describe("1차 심사 설정", () => {
  const withReviewer: CrawlSettings = {
    ...DEFAULT_CRAWL_SETTINGS,
    firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
    reviewConcurrency: 4,
  };

  it("지금 값을 그대로 그린다 — 손대지 않고 저장해도 바뀌면 안 된다", () => {
    const html = render(withReviewer);
    expect(html).toContain('name="firstReviewModel"');
    expect(html).toContain('value="[MLX] gpt-oss-120b"');
    expect(html).toMatch(/name="reviewConcurrency"[^>]*value="4"/);
  });

  it("저장하면 두 값을 보낸다", async () => {
    await saveCrawlSettings(null, submitted({
      firstReviewProvider: "abcllm", firstReviewModel: "[MLX] gpt-oss-120b", reviewConcurrency: "4",
    }));
    const patch = saveSettings.mock.calls[0][0];
    expect(patch.firstReview).toEqual({ provider: "abcllm", model: "[MLX] gpt-oss-120b" });
    expect(patch.reviewConcurrency).toBe(4);
  });

  it("모델 칸을 비우면 설정을 지운다 — 키를 빼면 기존 값에 덮여 되돌릴 길이 없다", async () => {
    await saveCrawlSettings(null, submitted({ firstReviewProvider: "abcllm", firstReviewModel: "  ", reviewConcurrency: "2" }));
    const patch = saveSettings.mock.calls[0][0];
    // 키가 있고 값이 undefined 여야 {...지금, ...바꾼 것} 에서 지금 값을 덮는다
    expect("firstReview" in patch).toBe(true);
    expect(patch.firstReview).toBeUndefined();
  });
});

describe("2026-10-08 리디자인", () => {
  const settingsWithShowHn: CrawlSettings = {
    ...twoSignals,
    discover: { ...twoSignals.discover, showHn: { enabled: true, priority: 120, requireEvidence: true } },
  };

  it("Show HN 행을 그리고, 그 칸을 보낸 폼만 Show HN 설정을 바꾼다", async () => {
    const html = render(settingsWithShowHn);
    expect(html).toContain('name="showHn.priority"');
    expect(html).toMatch(/name="showHn\.enabled"[^>]*checked/);

    await saveCrawlSettings(null, submitted({ "showHn.priority": "130", "showHn.requireEvidence": "on" }));
    expect(saveSettings.mock.calls[0][0].discover.showHn).toEqual({ enabled: false, priority: 130, requireEvidence: true });

    saveSettings.mockClear();
    await saveCrawlSettings(null, submitted());
    // 옛 폼(그 칸이 없다)은 Show HN 을 건드리지 않는다 — 꺼진 것으로 저장되면 수집이 멈춘다
    expect(saveSettings.mock.calls[0][0].discover).not.toHaveProperty("showHn");
  });

  it("거르는 목록 다섯은 보이지 않는 탭까지 늘 함께 보낸다", () => {
    const html = render(twoSignals);
    for (const name of ["blockedHomepageDomains", "thirdPartyHosts", "stubPageTitles", "excludedRepoPatterns", "heldRepoPatterns"]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toMatch(/<textarea[^>]*name="heldRepoPatterns"[^>]*>\*-website\nawesome-\*<\/textarea>/);
  });

  it("신호마다 지난 7일 수집과 발행률을 붙인다", () => {
    const html = renderToStaticMarkup(createElement(SettingsForm, {
      settings: twoSignals,
      yields: { "Claude 커밋 트레일러": { enqueued: 80815, published: 8343, gated: 0 }, "Show HN": { enqueued: 252, published: 48, gated: 34 } },
    }));
    expect(html).toContain("80,815");
    expect(html).toContain("10.3%");
    expect(html).toContain("흔적 없어 보류 34");
  });
});

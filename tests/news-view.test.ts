import { describe, expect, it } from "vitest";
import type { PublicNewsItem } from "@/lib/news/repository";
import { foldReleases, groupByDay, parseNewsFilter } from "@/lib/news/view";

let id = 0;
const item = (over: Partial<PublicNewsItem> & Pick<PublicNewsItem, "publishedAt">): PublicNewsItem => ({
  id: ++id, url: `https://example.com/${id}`, title: `글 ${id}`, summary: null, sourceKey: "openai", source: "OpenAI",
  vendor: "OpenAI", label: "공식 발표", tone: "mint", section: "news", ...over,
});
const release = (version: string, at: string) => item({
  sourceKey: "claude-code", source: "Claude Code", vendor: "Anthropic", label: "CLI 릴리스", tone: "peach", section: "release",
  title: `Claude Code ${version}`, publishedAt: new Date(at),
});

describe("소식 목록 모양", () => {
  /** Claude Code 는 하루에 두세 번 낸다 — 한 줄씩이면 발표가 릴리스 번호 사이에 묻힌다 */
  it("같은 도구가 같은 날 낸 릴리스는 최신 것 한 줄로 접는다", () => {
    const rows = foldReleases([
      release("2.1.268", "2026-09-10T20:00:00Z"),
      item({ title: "GPT-6", publishedAt: new Date("2026-09-10T18:00:00Z") }),
      release("2.1.267", "2026-09-10T16:00:00Z"),
      release("2.1.266", "2026-09-09T10:00:00Z"),
    ]);
    expect(rows.map((row) => [row.item.title, row.more.map((more) => more.title)])).toEqual([
      ["Claude Code 2.1.268", ["Claude Code 2.1.267"]],
      ["GPT-6", []],
      ["Claude Code 2.1.266", []],
    ]);
  });

  it("공식 발표는 같은 날이어도 접지 않는다", () => {
    const rows = foldReleases([
      item({ title: "a", publishedAt: new Date("2026-09-10T10:00:00Z") }),
      item({ title: "b", publishedAt: new Date("2026-09-10T09:00:00Z") }),
    ]);
    expect(rows).toHaveLength(2);
  });

  /** 날짜는 한국 시간으로 나눈다 — UTC 15시가 다음 날이다 */
  it("날짜(KST)별로 묶는다", () => {
    const days = groupByDay(foldReleases([
      item({ publishedAt: new Date("2026-09-10T15:30:00Z") }),
      item({ publishedAt: new Date("2026-09-10T14:30:00Z") }),
    ]));
    expect(days.map((day) => [day.day, day.rows.length])).toEqual([["2026-09-11", 1], ["2026-09-10", 1]]);
    expect(days[0].label).toBe("9월 11일 금요일");
  });

  it("주소의 거르기는 아는 값만 받는다", () => {
    expect(parseNewsFilter({ company: "z-ai", kind: "news" })).toEqual({ vendor: "Z.ai", section: "news" });
    expect(parseNewsFilter({ company: "nope", kind: "all" })).toEqual({});
    expect(parseNewsFilter({ company: null, kind: "release" })).toEqual({ section: "release" });
  });
});

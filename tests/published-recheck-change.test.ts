import { describe, expect, it } from "vitest";
import { compareRecheckContent, contentTokens, normalizedRecheckUrl, packageProofKnownSince, recheckChangeText, recheckContent,
  recheckContentHash, tokenSimilarity, type RecheckContent } from "@/lib/crawl/published-recheck-change";

/** 공개분 변경 재검수의 "뜻있게 바뀌었나" 규칙(2026-11-09 운영자 결정) — 아홉 칸만, 글은 낱말 유사도 */
const rule = { minSimilarity: 0.6 };
const words = (count: number, prefix = "word") => Array.from({ length: count }, (_, index) => `${prefix}${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`).join(" ");
const base: RecheckContent = {
  name: "Acme Notes", description: "Take notes quickly and share them with your team", pageText: words(80), readme: words(60, "readme"),
  topics: ["notes", "productivity"], url: "https://acme.example/app", accessMode: "website", packageProof: [], linksOwnGithub: true,
};

describe("낱말 모음", () => {
  it("숫자가 섞인 낱말·한 글자는 버리고, 한자·가나는 두 글자씩, 한글은 띄어 쓴 낱말 그대로다", () => {
    expect([...contentTokens("Users online: 1,234 · v2.3 released 2026-11-09 a b")]).toEqual(["users", "online", "released"]);
    expect([...contentTokens("메모를 빠르게 적습니다")]).toEqual(["메모를", "빠르게", "적습니다"]);
    expect([...contentTokens("記録する")]).toEqual(["記録", "録す", "する"]);
    expect([...contentTokens("ＡＣＭＥ Notes")]).toEqual(["acme", "notes"]);
  });

  it("자카드 유사도와 대칭차", () => {
    expect(tokenSimilarity(new Set(["a1", "b1"]), new Set(["a1", "c1"]))).toEqual({ similarity: 1 / 3, difference: 2 });
    expect(tokenSimilarity(new Set(), new Set())).toEqual({ similarity: 1, difference: 0 });
  });
});

describe("견주기", () => {
  it("같으면 바뀌지 않았다 — 숫자(방문자 수·날짜)만 바뀐 본문도 같다", () => {
    expect(compareRecheckContent(base, { ...base }, rule)).toEqual({ changed: false, fields: [] });
    const counted = { ...base, pageText: `${base.pageText} 1,234 users 2026-11-09`, description: `${base.description} (v2.4)` };
    const withUsers = { ...base, pageText: `${base.pageText} users` };
    expect(compareRecheckContent(withUsers, counted, rule).changed).toBe(false);
  });

  it("움직이는 페이지의 작은 변화(유사도 문턱 위)는 바뀜이 아니다", () => {
    const drift = { ...base, pageText: `${words(70)} ${words(10, "news")}` };
    expect(compareRecheckContent(base, drift, rule).changed).toBe(false);
  });

  it("본문이 크게 바뀌면(유사도 문턱 아래) 바뀜이다 — 유사도를 남긴다", () => {
    const pivot = { ...base, pageText: words(80, "casino") };
    expect(compareRecheckContent(base, pivot, rule)).toEqual({ changed: true, fields: [{ field: "pageText", kind: "changed", similarity: 0 }] });
  });

  it("본문이 사라지면(빈 페이지) 바뀜, 거의 없던 본문이 생겨도 바뀜 — README 가 나중에 채워진 것은 세지 않는다", () => {
    expect(compareRecheckContent(base, { ...base, pageText: "" }, rule).fields).toEqual([{ field: "pageText", kind: "vanished" }]);
    expect(compareRecheckContent({ ...base, pageText: "" }, base, rule).fields).toEqual([{ field: "pageText", kind: "appeared" }]);
    expect(compareRecheckContent({ ...base, readme: "" }, base, rule).changed).toBe(false);
    expect(compareRecheckContent(base, { ...base, readme: "" }, rule).fields).toEqual([{ field: "readme", kind: "vanished" }]);
  });

  it("짧은 칸 — 이름·토픽·주소·쓰는 방식·패키지 증거·제작자 GitHub 링크", () => {
    const changedFields = (next: Partial<RecheckContent>) => compareRecheckContent(base, { ...base, ...next }, rule).fields.map((change) => change.field);
    expect(changedFields({ name: "Acme Casino" })).toEqual(["name"]);
    expect(changedFields({ name: "ACME notes 2" })).toEqual([]);
    expect(changedFields({ topics: ["Productivity", "notes"] })).toEqual([]);
    expect(changedFields({ topics: ["notes"] })).toEqual(["topics"]);
    expect(changedFields({ url: "https://ACME.example/app/#top" })).toEqual([]);
    expect(changedFields({ url: "https://other.example/" })).toEqual(["url"]);
    expect(changedFields({ accessMode: "installable" })).toEqual(["accessMode"]);
    expect(changedFields({ packageProof: [{ kind: "skill", path: "SKILL.md" }] })).toEqual(["packageProof"]);
    expect(changedFields({ linksOwnGithub: false })).toEqual(["linksOwnGithub"]);
  });

  it("소개는 짧은 글이라 대칭차 3 이상·문턱 아래일 때만 바뀜이다", () => {
    expect(compareRecheckContent(base, { ...base, description: "Take notes quickly and share them with your whole team" }, rule).changed).toBe(false);
    expect(compareRecheckContent(base, { ...base, description: "Online casino with instant payouts and daily bonuses" }, rule).fields[0])
      .toMatchObject({ field: "description", kind: "changed" });
  });

  it("문턱은 실시간 한도에서 온다 — 0 이면 글 칸은 생기고 사라질 때만 바뀐다", () => {
    const pivot = { ...base, pageText: words(80, "casino") };
    expect(compareRecheckContent(base, pivot, { minSimilarity: 0 }).changed).toBe(false);
  });

  it("기준에 없는 칸(그 칸이 생기기 전의 1차 승인)은 견주지 않는다", () => {
    const { readme: _readme, linksOwnGithub: _links, packageProof: _proof, ...old } = base;
    void _readme; void _links; void _proof;
    expect(compareRecheckContent(old, { ...base, readme: words(60, "other"), linksOwnGithub: false, packageProof: [{ kind: "mcp" }] }, rule).changed).toBe(false);
  });
});

describe("내용 고르기·해시", () => {
  it("아홉 칸만 고르고, 스타·푸시·저장소 이름은 해시에 들지 않는다", () => {
    const product = { repo: "acme/notes", name: "Acme", description: "d", pageText: "p", url: "https://acme.example", topics: [], language: "TypeScript",
      accessMode: "website" as const, repositoryUrl: "https://github.com/acme/notes", readme: "", linksOwnGithub: false };
    const content = recheckContent(product, { packageProofKnown: true });
    expect(Object.keys(content).sort()).toEqual(["accessMode", "description", "linksOwnGithub", "name", "packageProof", "pageText", "readme", "topics", "url"]);
    expect(content.packageProof).toEqual([]);
    expect(recheckContent(product, { packageProofKnown: false })).not.toHaveProperty("packageProof");
    expect(recheckContentHash(recheckContent({ ...product, repo: "acme/other", language: "Go" }, { packageProofKnown: true }))).toBe(recheckContentHash(content));
  });

  it("packageProof 를 싣는 판(2026-10-06.1) 뒤의 1차 승인만 '없음'을 안다", () => {
    expect(packageProofKnownSince("2026-10-06.2")).toBe(true);
    expect(packageProofKnownSince("2026-10-06.1")).toBe(true);
    expect(packageProofKnownSince("2026-09-19.2")).toBe(false);
    expect(packageProofKnownSince(null)).toBe(false);
  });

  it("주소 고치기와 화면 한 줄", () => {
    expect(normalizedRecheckUrl(" https://Acme.Example/App/ ")).toBe("https://acme.example/App");
    expect(normalizedRecheckUrl("")).toBeNull();
    expect(recheckChangeText({ version: 1, fields: [{ field: "pageText", kind: "changed", similarity: 0.321 }, { field: "name", kind: "changed", similarity: 0.5 },
      { field: "readme", kind: "vanished" }] })).toBe("페이지 본문(유사도 0.32) · 이름 · README 사라짐");
    expect(recheckChangeText(null)).toBeNull();
  });
});

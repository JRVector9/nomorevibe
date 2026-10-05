import { describe, expect, it } from "vitest";
import { formatWait, groupTakedowns, isBurst, senderLabel, takedownSignal, waitTone, type TakedownEntry } from "@/lib/domain/products/takedown-view";

/** 내려달라는 요청 — 기다림의 색, 표기, 묶기 규칙 */
const entry = (slug: string, over: Partial<TakedownEntry> = {}): TakedownEntry => ({
  slug, reason: null, requestedAt: "2026-10-05T03:10:00.000Z", ageHours: 1, requesterHash: null, requestCount: 1, previousOutcome: null,
  product: { name: slug, url: `https://${slug}.test`, repoUrl: null, category: "Dev", listedAt: "2026-09-18T00:00:00.000Z", status: "seeded", stars: 0 },
  owner: null, ownerPublic: 0, ownerPending: 0, senderPending: 0, visits7d: 0, ...over,
});

describe("기다림", () => {
  it("24시간을 넘기면 빨강, 12시간을 넘기면 주황, 그 전은 무채색", () => {
    expect(waitTone(30)).toBe("bad");
    expect(waitTone(24)).toBe("bad");
    expect(waitTone(19)).toBe("warn");
    expect(waitTone(6)).toBe("soft");
  });
  it("분·시간·일로 적는다", () => {
    expect(formatWait(0.66)).toBe("40분");
    expect(formatWait(0)).toBe("1분");
    expect(formatWait(6.9)).toBe("6시간");
    expect(formatWait(52.5)).toBe("2일 4시간");
    expect(formatWait(48)).toBe("2일");
  });
  it("메뉴 배지는 대기가 있을 때만, 넘긴 것이 있으면 빨강", () => {
    expect(takedownSignal({ pending: 0, overdue: 0 })).toBeNull();
    expect(takedownSignal({ pending: 3, overdue: 0 })).toEqual({ label: "요청 3", tone: "warn" });
    expect(takedownSignal({ pending: 14, overdue: 3 })).toEqual({ label: "요청 14", tone: "bad" });
  });
  it("보낸이는 해시 앞 네 자리, 모르면 미상 · 1시간 10건이면 몰림", () => {
    expect(senderLabel("a3f9c0ffee")).toBe("보낸이 a3f9");
    expect(senderLabel(null)).toBe("보낸이 미상");
    const lastHour = (requests: number) => ({ lastHour: { requests, owners: 0, senders: 0, noReason: 0, topReason: null } });
    expect(isBurst(lastHour(9))).toBe(false);
    expect(isBurst(lastHour(10))).toBe(true);
  });
});

describe("묶기", () => {
  const list = [
    entry("a1", { owner: "veltzer", ownerPublic: 61, requesterHash: "s1" }),
    entry("b1", { owner: "lone", requesterHash: "s1" }),
    entry("a2", { owner: "veltzer", ownerPublic: 61, requesterHash: "s2", requestedAt: "2026-10-05T05:10:00.000Z" }),
    entry("c1", { owner: null, requesterHash: null }),
  ];
  it("묶지 않으면 한 묶음이고 순서를 지킨다", () => {
    const [all] = groupTakedowns(list, "none");
    expect(all.entries.map((e) => e.slug)).toEqual(["a1", "b1", "a2", "c1"]);
    expect(all.title).toBe("");
  });
  it("같은 계정 — 둘 이상만 묶음, 나머지는 한 건씩", () => {
    const groups = groupTakedowns(list, "owner");
    expect(groups.map((g) => [g.title, g.entries.map((e) => e.slug), g.together])).toEqual([
      ["veltzer", ["a1", "a2"], true], ["한 건씩", ["c1", "b1"], false]]);
    expect(groups[0].detail).toBe("요청 2건 · 이 계정의 공개 제품 61개");
  });
  it("같은 보낸이 — 보낸이 표기로 묶고 서로 다른 계정 수를 적는다", () => {
    const groups = groupTakedowns(list, "sender");
    expect(groups[0]).toMatchObject({ title: "보낸이 s1", detail: "요청 2건 · 서로 다른 계정 2곳", together: true });
    expect(groups[1].entries.map((e) => e.slug)).toEqual(["c1", "a2"]);
  });
  it("들어온 시각 — 한국 시각의 시(時)로 묶고 최근 시각대가 먼저", () => {
    const groups = groupTakedowns([...list, entry("d1", { requestedAt: "2026-10-05T05:40:00.000Z" })], "time");
    expect(groups[0]).toMatchObject({ title: "10-05 14시", together: true });
    expect(groups[0].entries.map((e) => e.slug)).toEqual(["a2", "d1"]);
    expect(groups[1]).toMatchObject({ title: "10-05 12시", together: true });
  });
});

import { describe, expect, it } from "vitest";
import { reviewShortcut } from "@/app/admin/review/shortcuts";
import { approvalNote, CAUSE_GUIDE, causeShort, modelsAgree, recommendDecision, type CauseKey } from "@/app/admin/review/causes";
import { HUMAN_ONLY_REASONS } from "@/lib/crawl/admin-review";

/**
 * 심사 큐 키보드 흐름(ADM-10)과 갈래 짧은 이름·권장 결정(ADM-13·07·11). DOM 없이 눌린 자리를 흉내 낸다.
 */
type Fake = { tagName: string; type?: string; inside?: string[] };
const at = ({ tagName, type, inside = [] }: Fake) => ({
  tagName, type,
  // 자기 자신과 조상들 중 하나가 선택자에 맞는지 — 이 테스트에 필요한 만큼만
  closest: (selector: string) => [tagName.toLowerCase(), ...inside]
    .some((name) => selector.split(",").map((part) => part.trim()).includes(name)) ? {} : null,
});
const key = (k: string, target: ReturnType<typeof at> | null = null, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string }> = {}) =>
  reviewShortcut({ key: k, metaKey: false, ctrlKey: false, altKey: false, target, ...mods });

const body = at({ tagName: "BODY" });
const row = at({ tagName: "TR", inside: ["[data-review-row]"] });
const rowCheckbox = at({ tagName: "INPUT", type: "checkbox", inside: ["[data-review-row]"] });
const textarea = at({ tagName: "TEXTAREA" });
const link = at({ tagName: "A" });
const inDialog = at({ tagName: "BUTTON", inside: ["dialog"] });

describe("단축키", () => {
  it("J/K 는 줄을 옮기고, 한글 입력 상태(ㅓ·ㅏ)에서도 키 자리로 읽는다", () => {
    expect(key("j", body)).toEqual({ kind: "move", delta: 1 });
    expect(key("k", row)).toEqual({ kind: "move", delta: -1 });
    expect(key("ㅓ", body, { code: "KeyJ" })).toEqual({ kind: "move", delta: 1 });
    expect(key("J", body)).toEqual({ kind: "move", delta: 1 });
  });

  it("N/P 는 쪽, ? 는 단축키 표, A/R 은 결정 준비, 숫자는 거부 사유", () => {
    expect(key("n", body)).toEqual({ kind: "page", delta: 1 });
    expect(key("p", body)).toEqual({ kind: "page", delta: -1 });
    expect(key("?", body)).toEqual({ kind: "help" });
    expect(key("a", row)).toEqual({ kind: "intent", decision: "approve" });
    expect(key("r", row)).toEqual({ kind: "intent", decision: "reject" });
    expect(key("3", row)).toEqual({ kind: "reason", index: 2 });
    expect(key("0", row)).toBeNull();
  });

  it("⌘/Ctrl+Enter 는 글을 쓰는 중에도 보낸다", () => {
    expect(key("Enter", textarea, { metaKey: true })).toEqual({ kind: "submit" });
    expect(key("Enter", body, { ctrlKey: true })).toEqual({ kind: "submit" });
  });

  it("글을 쓰는 칸·확인 창 안·조합키에서는 단축키가 아니다", () => {
    expect(key("j", textarea)).toBeNull();
    expect(key("a", at({ tagName: "INPUT", type: "search" }))).toBeNull();
    expect(key("j", inDialog)).toBeNull();
    expect(key("Enter", inDialog, { metaKey: true })).toBeNull();
    expect(key("j", body, { metaKey: true })).toBeNull();
  });

  it("Enter 는 줄에서만 상세를 열고, Space 는 단추·링크·체크박스가 제 일을 하게 둔다", () => {
    expect(key("Enter", row)).toEqual({ kind: "open" });
    expect(key("Enter", body)).toBeNull();
    expect(key("Enter", link)).toBeNull();
    expect(key(" ", row)).toEqual({ kind: "toggle" });
    expect(key(" ", body)).toEqual({ kind: "toggle" });
    expect(key(" ", rowCheckbox)).toBeNull();
    expect(key(" ", link)).toBeNull();
    // 체크박스는 글 쓰는 칸이 아니다 — 거기서도 J 는 줄을 옮긴다
    expect(key("j", rowCheckbox)).toEqual({ kind: "move", delta: 1 });
  });
});

describe("갈래 짧은 이름", () => {
  it("모든 갈래에 칩에 쓸 짧은 이름이 있고 잘리지 않을 만큼 짧다", () => {
    const keys = Object.keys(CAUSE_GUIDE) as CauseKey[];
    for (const cause of [...keys, ...HUMAN_ONLY_REASONS]) {
      expect(CAUSE_GUIDE[cause].short, cause).toBeTruthy();
      expect(CAUSE_GUIDE[cause].short.length, cause).toBeLessThanOrEqual(10);
      expect(causeShort(cause)).toBe(CAUSE_GUIDE[cause].short);
    }
    // 짧은 이름끼리 겹치면 칩으로 갈래를 구분할 수 없다
    expect(new Set(keys.map((cause) => CAUSE_GUIDE[cause].short)).size).toBe(keys.length);
    expect(causeShort("installable_product")).toBe("설치형");
    expect(causeShort("host_excluded_subpath")).toBe("호스트·하위경로");
    expect(causeShort("second_review_split")).toBe("2차 갈림");
    expect(causeShort("no_description")).toBe("소개 없음");
  });
});

describe("권장 결정과 자동 사유", () => {
  const agreed = (decision: string) => [{ decision, status: "agreed", echo: false }];

  it("두 모델이 같은 결론이면 그대로 권하고 'AI·2차 일치' 사유를 쓴다", () => {
    expect(modelsAgree("approve", agreed("approve"))).toBe(true);
    // 1차와 같은 모델의 표는 세지 않는다
    expect(modelsAgree("approve", [{ decision: "approve", status: "agreed", echo: true }])).toBe(false);
    expect(recommendDecision({ bucket: "second_review_split", ai: "approve", agree: true }))
      .toEqual({ decision: "approve", note: "AI·2차 일치 승인", basis: "두 모델이 같은 결론" });
    expect(recommendDecision({ bucket: "name_pattern", ai: "reject", agree: true }))
      .toMatchObject({ decision: "reject", reason: "personal_site", note: "AI·2차 일치 거부" });
  });

  it("모델이 갈리면 갈래의 흔한 결론을 권하되, 모델이 반대로 봤으면 권하지 않는다", () => {
    expect(recommendDecision({ bucket: "suspected_spam", ai: null, agree: false }))
      .toMatchObject({ decision: "reject", reason: "not_a_product", basis: "스팸 의심 갈래의 흔한 결론" });
    expect(recommendDecision({ bucket: "installable_product", ai: "reject", agree: false })).toBeNull();
    expect(recommendDecision({ bucket: "second_review_split", ai: "approve", agree: false })).toBeNull();
    expect(recommendDecision({ bucket: null, ai: "approve", agree: false })).toBeNull();
  });

  it("승인 사유는 두 모델 일치 또는 AI 승인을 따를 때만 저절로 채운다", () => {
    expect(approvalNote("approve", true)).toBe("AI·2차 일치 승인");
    expect(approvalNote("approve", false)).toBe("AI 승인을 따름");
    expect(approvalNote("reject", true)).toBeNull();
    expect(approvalNote(null, false)).toBeNull();
  });
});

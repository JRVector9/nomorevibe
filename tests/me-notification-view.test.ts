import { describe, expect, it } from "vitest";
import { translatedCategory } from "@/components/home/i18n";
import { createTranslator } from "@/lib/i18n/messages";
import type { NotificationKind } from "@/lib/me/contract";
import { categoryOfKey, makerKey, makerKeyOf, parseFollowKey } from "@/lib/me/follow-keys";
import { groupByDay, renderNotification, type NotificationSource } from "@/lib/me/notification-view";
import { categoryDigestWeek } from "@/lib/jobs/me/notifications";
import { me as koMe } from "@/messages/ko/me";
import { me as enMe } from "@/messages/en/me";
import { labels as koLabels } from "@/messages/ko/labels";
import { labels as enLabels } from "@/messages/en/labels";

const ko = createTranslator("me", koMe);
const en = createTranslator("me", enMe);
const koCategory = (category: Parameters<typeof translatedCategory>[0]) => translatedCategory(category, createTranslator("labels", koLabels));
const enCategory = (category: Parameters<typeof translatedCategory>[0]) => translatedCategory(category, createTranslator("labels", enLabels));
const product = { slug: "memo-x", name: "메모장X", ogImage: null, category: "Productivity" };

function row(kind: NotificationKind, payload: Record<string, unknown> = {}, change: Partial<NotificationSource> = {}): NotificationSource {
  return { id: 7, kind, payload, createdAt: new Date("2026-10-20T03:00:00Z"), readAt: null, product, ...change };
}
const plain = (parts: Array<{ text: string; strong?: boolean }>) => parts.map((part) => part.text).join("");
const bold = (parts: Array<{ text: string; strong?: boolean }>) => parts.filter((part) => part.strong).map((part) => part.text);

describe("알림 한 줄", () => {
  it("종류마다 그 말로 짓고 이름만 굵게 둔다", () => {
    const release = renderNotification(row("followed_release", { title: "v2.0.0", updateId: 3 }), ko, koCategory, "ko");
    expect(release).toMatchObject({ id: 7, kind: "followed_release", label: "팔로한 프로젝트", href: "/p/memo-x", read: false,
      tile: { name: "메모장X", ogImage: null, category: "Productivity" }, createdAt: "2026-10-20T03:00:00.000Z" });
    expect(plain(release.parts)).toBe("메모장X 새 릴리스 v2.0.0");
    expect(bold(release.parts)).toEqual(["메모장X"]);

    const reply = renderNotification(row("maker_reply", { maker: "@example-dev", excerpt: "다음 버전에 넣을게요.", feedbackId: "6f8b1c3e-2f7a-4b1d-9c8e-0a1b2c3d4e5f" }), ko, koCategory, "ko");
    expect(plain(reply.parts)).toBe("@example-dev 님이 메모장X에 남긴 내 글에 답장했어요.");
    expect(bold(reply.parts)).toEqual(["@example-dev", "메모장X"]);
    expect(reply).toMatchObject({ quote: "다음 버전에 넣을게요.", href: "/feedback/6f8b1c3e-2f7a-4b1d-9c8e-0a1b2c3d4e5f", label: "메이커 답장" });
    expect(plain(renderNotification(row("maker_reply"), ko, koCategory, "ko").parts)).toBe("메이커가 메모장X에 남긴 내 글에 답장했어요.");

    expect(plain(renderNotification(row("followed_delisted", { reason: "down" }), ko, koCategory, "ko").parts)).toBe("메모장X 접속이 안 돼 목록에서 잠시 내려갔어요.");
    expect(plain(renderNotification(row("followed_delisted", { reason: "removed" }), ko, koCategory, "ko").parts)).toBe("메모장X 목록에서 내려갔어요.");
    expect(plain(renderNotification(row("maker_new_project", { maker: "memo-lab" }), ko, koCategory, "ko").parts)).toBe("@memo-lab의 새 프로젝트 «메모장X»");
  });

  it("검토 결과는 공개되면 그 글로, 거절되면 내 의견 탭으로 보낸다", () => {
    const id = "6f8b1c3e-2f7a-4b1d-9c8e-0a1b2c3d4e5f";
    const accepted = renderNotification(row("comment_reviewed", { decision: "accepted", feedbackId: id }), ko, koCategory, "ko");
    expect(plain(accepted.parts)).toBe("메모장X에 남긴 글이 검토를 거쳐 공개됐어요.");
    expect(accepted.href).toBe(`/feedback/${id}`);
    const rejected = renderNotification(row("comment_reviewed", { decision: "rejected", feedbackId: id }), en, enCategory, "en");
    expect(plain(rejected.parts)).toBe("Your post on 메모장X was reviewed and not published.");
    expect(rejected.href).toBe("/en/me/opinions");
  });

  it("분야 주간 묶음은 하나면 그 분야로, 여럿이면 팔로 탭으로", () => {
    const one = renderNotification(row("category_new", { week: "2026-W43", total: 12, categories: [{ category: "design", count: 12 }], others: 0 }, { product: null }), ko, koCategory, "ko");
    expect(plain(one.parts)).toBe("디자인에 이번 주 새 프로젝트 12개");
    expect(one).toMatchObject({ href: "/c/design?sort=recent", tile: { name: "디자인", ogImage: null, category: "Design" }, label: "팔로한 분야" });
    const many = renderNotification(row("category_new", { total: 30, categories: [{ category: "dev", count: 20 }, { category: "design", count: 10 }], others: 1 }, { product: null }), en, enCategory, "en");
    expect(plain(many.parts)).toBe(`30 new projects this week in ${enCategory("Dev")} and 1 more categories`);
    expect(bold(many.parts)).toEqual([enCategory("Dev")]);
    expect(many.href).toBe("/en/me/following");
  });

  it("깨진 payload·지워진 제품도 그린다 — 다른 사람 값이 섞일 틈이 없다", () => {
    const broken = renderNotification(row("followed_release", { title: 42 }, { product: null }), ko, koCategory, "ko");
    expect(plain(broken.parts)).toBe("내려간 프로젝트 새 릴리스 ");
    expect(broken.href).toBe("/me/alerts");
    expect(renderNotification(row("maker_reply", { feedbackId: "../../admin" }), ko, koCategory, "ko").href).toBe("/p/memo-x");
    expect(plain(renderNotification(row("inbox_new", { count: 3 }), ko, koCategory, "ko").parts)).toBe("메모장X에 새 의견 3개가 왔어요.");
    expect(renderNotification(row("new_listing_mine", { repo: "hanul/kbd" }), ko, koCategory, "ko")).toMatchObject({ href: "/me/projects" });
    expect(renderNotification(row("followed_release", {}, { readAt: new Date() }), ko, koCategory, "ko").read).toBe(true);
  });
});

describe("오늘 · 이번 주 · 이전 (한국 날짜)", () => {
  it("UTC 로는 어제여도 한국으로 오늘이면 오늘이다", () => {
    const now = "2026-10-20T01:00:00Z"; // KST 10월 20일 10:00
    const items = [
      { id: 1, createdAt: "2026-10-19T15:30:00Z" }, // KST 20일 00:30 — 오늘
      { id: 2, createdAt: "2026-10-19T14:59:00Z" }, // KST 19일 23:59 — 이번 주
      { id: 3, createdAt: "2026-10-14T00:00:00Z" }, // KST 14일 — 이번 주(지난 6일 안)
      { id: 4, createdAt: "2026-10-13T14:59:00Z" }, // KST 13일 23:59 — 이전
      { id: 5, createdAt: "2026-09-01T00:00:00Z" },
    ];
    expect(groupByDay(items, now).map(({ group, items: rows }) => [group, rows.map((item) => item.id)])).toEqual([
      ["today", [1]], ["week", [2, 3]], ["earlier", [4, 5]],
    ]);
    expect(groupByDay([], now)).toEqual([]);
  });
});

describe("팔로 열쇠", () => {
  it("모양이 맞는 것만 받는다", () => {
    expect(parseFollowKey({ targetType: "product", targetKey: "12" })).toEqual({ targetType: "product", targetKey: "12" });
    expect(parseFollowKey({ targetType: "maker", targetKey: "memo-lab" })).toEqual({ targetType: "maker", targetKey: "memo-lab" });
    expect(parseFollowKey({ targetType: "category", targetKey: "design" })).toEqual({ targetType: "category", targetKey: "design" });
    for (const bad of [{ targetType: "product", targetKey: "012" }, { targetType: "product", targetKey: "9999999999" }, { targetType: "product", targetKey: 12 },
      { targetType: "maker", targetKey: "Memo-Lab" }, { targetType: "maker", targetKey: "-x" }, { targetType: "maker", targetKey: "a".repeat(40) },
      { targetType: "category", targetKey: "Design" }, { targetType: "category", targetKey: "nope" }, { targetType: "user", targetKey: "1" }, null, []]) {
      expect(parseFollowKey(bad)).toBeNull();
    }
    expect(categoryOfKey("dev")).toBe("Dev");
  });

  it("메이커는 목록이 보여 주는 주인의 소문자 login 이다", () => {
    expect(makerKeyOf("https://github.com/Memo-Lab/widget")).toBe("memo-lab");
    expect(makerKeyOf("https://github.com/twitter/bootstrap", "twbs/bootstrap")).toBe("twbs");
    expect(makerKeyOf("https://example.com/app")).toBeNull();
    expect(makerKey("Under_Score")).toBeNull();
  });
});

describe("분야 주간 묶음 시각", () => {
  it("월요일 00:00 KST 이 그 주의 요약 시각이다 — 기본 주간 메일(09:00)보다 먼저", () => {
    expect(categoryDigestWeek(new Date("2026-10-20T05:00:00Z"))).toEqual({ key: "2026-W43", sendAt: new Date("2026-10-18T15:00:00Z") });
    // KST 월요일 00:30 은 이미 새 주이고 요약 시각도 지났다
    expect(categoryDigestWeek(new Date("2026-10-25T15:30:00Z"))).toEqual({ key: "2026-W44", sendAt: new Date("2026-10-25T15:00:00Z") });
    // KST 일요일 23:59 는 아직 지난 주다
    expect(categoryDigestWeek(new Date("2026-10-25T14:59:00Z"))).toEqual({ key: "2026-W43", sendAt: new Date("2026-10-18T15:00:00Z") });
  });
});

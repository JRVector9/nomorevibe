import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_KINDS } from "@/lib/me/contract";
import {
  DEFAULT_NOTIFICATION_SETTINGS, EMAIL_SETTING_FOR_KIND, maskEmail, parseNotificationSettingsInput, weeklyKinds,
} from "@/lib/me/notification-settings";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/me/unsubscribe";
import { emailRetryDelayMs, kstClock, notificationEmailDedupeKey } from "@/lib/me/email-outbox";
import { digestEmail, instantEmail } from "@/lib/me/email-copy";
import { sendEmail } from "@/lib/domain/accounts/email-delivery";
import { LOCALES } from "@/lib/i18n/locales";

const SECRET = "unit-public-auth-secret-longer-than-32-characters";
afterEach(() => { vi.unstubAllEnvs(); });

describe("알림 설정 입력 검사", () => {
  it("칸마다 고를 수 있는 값만, 바꿀 칸만 받는다", () => {
    expect(parseNotificationSettingsInput({ makerReply: "weekly" })).toEqual({ makerReply: "weekly" });
    expect(parseNotificationSettingsInput({ followedCategory: "off", newListingMine: "instant", digestWeekday: 0, digestHour: 23, newsOptIn: true, locale: "zh-Hant" }))
      .toEqual({ followedCategory: "off", newListingMine: "instant", digestWeekday: 0, digestHour: 23, newsOptIn: true, locale: "zh-Hant" });
    for (const bad of [
      {}, { followedCategory: "instant" }, { newListingMine: "weekly" }, { makerReply: "daily" }, { commentReviewed: "off" }, { userId: 2, makerReply: "off" },
      { digestWeekday: 7 }, { digestWeekday: -1 }, { digestWeekday: 1.5 }, { digestWeekday: "1" }, { digestHour: 24 }, { newsOptIn: "true" }, { locale: "fr" },
    ]) expect(parseNotificationSettingsInput(bad as Record<string, unknown>), JSON.stringify(bad)).toBeNull();
  });

  it("알림 종류마다 메일 칸이 하나거나, 사이트 안에만 둔다", () => {
    expect(Object.keys(EMAIL_SETTING_FOR_KIND).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    expect(EMAIL_SETTING_FOR_KIND).toMatchObject({
      maker_reply: "makerReply", followed_release: "followedProject", followed_delisted: "followedProject",
      maker_new_project: "followedMaker", category_new: "followedCategory", new_listing_mine: "newListingMine",
      comment_reviewed: null, inbox_new: null,
    });
    expect(weeklyKinds(DEFAULT_NOTIFICATION_SETTINGS).sort()).toEqual(["category_new", "followed_delisted", "followed_release"]);
    expect(weeklyKinds({ ...DEFAULT_NOTIFICATION_SETTINGS, followedProject: "off", followedCategory: "off" })).toEqual([]);
  });

  it("메일 주소는 앞 두 글자와 도메인만 보인다", () => {
    expect(maskEmail("hanul@example.com")).toBe("ha***@example.com");
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
    expect(maskEmail("broken")).toBe("***");
  });
});

describe("«이 알림 끄기» 열쇠", () => {
  it("서명한 계정·칸만 돌려주고, 고친 열쇠·다른 비밀은 거절한다", () => {
    const token = signUnsubscribeToken(42, "makerReply", SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual({ userId: 42, key: "makerReply" });
    expect(verifyUnsubscribeToken(signUnsubscribeToken(7, "weekly", SECRET), SECRET)).toEqual({ userId: 7, key: "weekly" });
    const [, , sig] = token.split(".");
    expect(verifyUnsubscribeToken(`43.makerReply.${sig}`, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(`42.followedMaker.${sig}`, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(token, `${SECRET}-other`)).toBeNull();
    expect(verifyUnsubscribeToken(signUnsubscribeToken(42, "makerReply", `${SECRET}-other`), SECRET)).toBeNull();
    for (const bad of [null, 42, "", "42.makerReply", `0.makerReply.${sig}`, `42.unknownKey.${sig}`, `${token}.extra`]) expect(verifyUnsubscribeToken(bad, SECRET)).toBeNull();
  });

  it("비밀을 넘기지 않으면 PUBLIC_AUTH_SECRET 을 쓴다", () => {
    vi.stubEnv("PUBLIC_AUTH_SECRET", SECRET);
    expect(verifyUnsubscribeToken(signUnsubscribeToken(5, "news"))).toEqual({ userId: 5, key: "news" });
    vi.stubEnv("PUBLIC_AUTH_SECRET", "short");
    expect(() => signUnsubscribeToken(5, "news")).toThrow();
  });
});

describe("발송함 계산", () => {
  it("KST 요일·시와 ISO 주를 센다", () => {
    expect(kstClock(new Date("2026-10-19T00:00:00Z"))).toEqual({ weekday: 1, hour: 9, week: "2026-W43" });
    expect(kstClock(new Date("2026-10-18T15:00:00Z"))).toEqual({ weekday: 1, hour: 0, week: "2026-W43" });
    expect(kstClock(new Date("2026-10-18T14:59:00Z"))).toEqual({ weekday: 0, hour: 23, week: "2026-W42" });
    expect(kstClock(new Date("2026-12-31T15:30:00Z"))).toMatchObject({ weekday: 5, week: "2026-W53" });
    expect(kstClock(new Date("2027-01-03T03:00:00Z")).week).toBe("2026-W53");
    expect(kstClock(new Date("2027-01-04T03:00:00Z")).week).toBe("2027-W01");
    expect(kstClock(new Date("2025-12-29T03:00:00Z")).week).toBe("2026-W01");
  });

  it("발송함 dedupe 는 계정마다 다르고 120자를 넘지 않는다", () => {
    expect(notificationEmailDedupeKey(3, "followed_release:9")).toBe("email:3:followed_release:9");
    expect(notificationEmailDedupeKey(4, "followed_release:9")).not.toBe(notificationEmailDedupeKey(3, "followed_release:9"));
    const long = notificationEmailDedupeKey(1234567890, "x".repeat(120));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).not.toBe(notificationEmailDedupeKey(1234567890, `${"x".repeat(119)}y`));
  });

  it("다시 보내기 간격은 1·5·15·60분", () => {
    expect([1, 2, 3, 4, 5].map(emailRetryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
  });
});

describe("알림 메일 글", () => {
  const links = { open: "https://nomorevibe.example/p/one", unsubscribe: "https://nomorevibe.example/api/me/notification-settings/unsubscribe?token=1.makerReply.x&lang=ko", settings: "https://nomorevibe.example/me/alerts" };
  it("제품 이름을 HTML 에서 가리고 제목은 한 줄로 둔다", () => {
    const mail = instantEmail("ko", "maker_reply", { slug: "one", name: "<script>\nalert(1)</script>" }, links);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain("메이커가 답장했어요");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("token=1.makerReply.x&amp;lang=ko");
    expect(mail.text).toContain(links.unsubscribe);
    expect(mail.html).not.toMatch(/<img/i);
  });
  it("네 언어 모두 즉시 메일·주간 요약을 만든다", () => {
    for (const locale of LOCALES) {
      const instant = instantEmail(locale, "followed_release", null, links);
      const digest = digestEmail(locale, [{ kind: "category_new", product: { slug: "one", name: "One" }, url: links.open }], 3, links);
      expect(instant.subject.length).toBeGreaterThan(0);
      expect(digest.text).toContain(links.open);
      expect(digest.text).toContain(links.unsubscribe);
    }
  });
});

describe("알림 메일 보내기(Resend)", () => {
  const email = { to: "reader@example.com", subject: "s", text: "t", html: "<p>t</p>", idempotencyKey: "nmv-email-1", headers: { "List-Unsubscribe": "<https://x/u>" } };
  it("같은 키·보내는 주소를 쓰고, 한도·겹친 요청은 다시 보낼 수 있게 unknown", async () => {
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "re_test");
    vi.stubEnv("LOGIN_EMAIL_FROM", "alerts@example.com");
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await sendEmail(email, fetcher as unknown as typeof fetch)).toBe("accepted");
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("nmv-email-1");
    expect(JSON.parse(init.body as string)).toMatchObject({ from: "alerts@example.com", to: ["reader@example.com"], headers: email.headers });
    for (const [status, state] of [[429, "unknown"], [409, "unknown"], [422, "rejected"], [500, "unknown"]] as const) {
      expect(await sendEmail(email, (async () => new Response("{}", { status })) as unknown as typeof fetch)).toBe(state);
    }
    expect(await sendEmail(email, (async () => { throw new Error("network"); }) as unknown as typeof fetch)).toBe("unknown");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_KINDS } from "@/lib/me/contract";
import {
  DEFAULT_NOTIFICATION_SETTINGS, EMAIL_SETTING_FOR_KIND, parseNotificationSettingsInput, weeklyKinds,
} from "@/lib/me/notification-settings";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/me/unsubscribe";
import { emailRetryDelayMs, emailSenderConfigured, kstClock, notificationEmailDedupeKey } from "@/lib/me/email-outbox";
import { digestEmail, emailDetail, instantEmail } from "@/lib/me/email-copy";
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

  it("보내는 쪽은 발신 키·보내는 주소와 끄기 링크 서명 비밀(32자 이상)이 모두 있어야 보낼 수 있다", () => {
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "re_test");
    vi.stubEnv("LOGIN_EMAIL_FROM", "alerts@example.com");
    vi.stubEnv("PUBLIC_AUTH_SECRET", SECRET);
    expect(emailSenderConfigured()).toBe(true);
    vi.stubEnv("PUBLIC_AUTH_SECRET", "short");
    expect(emailSenderConfigured()).toBe(false);
    vi.stubEnv("PUBLIC_AUTH_SECRET", SECRET);
    vi.stubEnv("LOGIN_EMAIL_FROM", " ");
    expect(emailSenderConfigured()).toBe(false);
  });
});

describe("알림 메일 글", () => {
  const links = { open: "https://nomorevibe.example/p/one", unsubscribe: "https://nomorevibe.example/api/me/notification-settings/unsubscribe?token=1.makerReply.x&lang=ko", settings: "https://nomorevibe.example/me/alerts" };
  it("제품 이름을 HTML 에서 가리고 제목은 한 줄로 둔다", async () => {
    const mail = await instantEmail("ko", "maker_reply", { slug: "one", name: "<script>\nalert(1)</script>" }, links);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain("메이커가 답장했어요");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("token=1.makerReply.x&amp;lang=ko");
    expect(mail.text).toContain(links.unsubscribe);
    expect(mail.html).not.toMatch(/<img/i);
  });
  it("내려간 까닭과 팔로한 분야 묶음을 알림함처럼 쓴다", async () => {
    const down = await instantEmail("ko", "followed_delisted", { slug: "one", name: "메모장X" }, links, emailDetail("followed_delisted", { reason: "down" }));
    expect(down.subject).toContain("잠시 내려감");
    const removed = await instantEmail("ko", "followed_delisted", { slug: "one", name: "메모장X" }, links, emailDetail("followed_delisted", { reason: "removed" }));
    expect(removed.subject).toBe("목록에서 내려감: 메모장X");
    expect(removed.text).not.toContain("접속이 안 돼");
    expect((await instantEmail("en", "followed_delisted", null, links, emailDetail("followed_delisted", {}))).text).toContain("was removed from the list");
    // 메이커 답장 메일은 알림함처럼 의견 탭(댓글)·써봤어요 탭(한 줄)으로 — 알림 payload(feedbackId)와 발송함 payload(target) 둘 다 읽는다
    expect(emailDetail("maker_reply", { feedbackId: "7b1c2e3f-0000-4000-8000-000000000001" })).toEqual({ target: "feedback" });
    expect(emailDetail("maker_reply", { target: "feedback" })).toEqual({ target: "feedback" });
    expect(emailDetail("maker_reply", { excerpt: "고마워요" })).toEqual({ target: "reaction" });
    const one = emailDetail("category_new", { total: 12, categories: [{ category: "dev", count: 12 }], others: 0 });
    const many = emailDetail("category_new", { total: 15, categories: [{ category: "dev", count: 12 }, { category: "design", count: 3 }, { category: "nope", count: 9 }], others: 1 });
    expect(one).toEqual({ categories: [{ category: "dev", count: 12 }], total: 12, others: 0 });
    expect(many.categories).toEqual([{ category: "dev", count: 12 }, { category: "design", count: 3 }]);
    const ko = await digestEmail("ko", [{ kind: "category_new", product: null, url: links.open, detail: one }, { kind: "category_new", product: null, url: links.open, detail: many }], 2, links);
    expect(ko.text).toContain("팔로한 분야 개발 도구에 새 프로젝트 12개가 올라왔어요.");
    expect(ko.text).toContain("팔로한 분야 개발 도구 외 1개 분야에 새 프로젝트 15개가 올라왔어요.");
    expect(ko.text).not.toContain("새 프로젝트가 올라왔어요: 새 프로젝트");
    expect((await digestEmail("en", [{ kind: "category_new", product: null, url: links.open, detail: one }], 1, links)).text).toContain("12 new projects arrived in Developer");
    expect(emailDetail("followed_release", { reason: "down" })).toEqual({});
    expect(emailDetail("category_new", { categories: "x" })).toEqual({});
  });

  it("네 언어 모두 즉시 메일·주간 요약을 만든다", async () => {
    for (const locale of LOCALES) {
      const instant = await instantEmail(locale, "followed_release", null, links);
      const digest = await digestEmail(locale, [{ kind: "category_new", product: { slug: "one", name: "One" }, url: links.open }], 3, links);
      expect(instant.subject.length).toBeGreaterThan(0);
      expect(digest.text).toContain(links.open);
      expect(digest.text).toContain(links.unsubscribe);
    }
  });
});

describe("알림 메일 보내기(Resend)", () => {
  const email = { to: "reader@example.com", subject: "s", text: "t", html: "<p>t</p>", idempotencyKey: "nmv-email-1", headers: { "List-Unsubscribe": "<https://x/u>" } };
  it("같은 키·보내는 주소를 쓰고, 겹친 요청·5xx 는 unknown, 키·도메인·한도 문제는 unavailable, 나머지 4xx 만 rejected", async () => {
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "re_test");
    vi.stubEnv("LOGIN_EMAIL_FROM", "alerts@example.com");
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await sendEmail(email, fetcher as unknown as typeof fetch)).toBe("accepted");
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("nmv-email-1");
    expect(JSON.parse(init.body as string)).toMatchObject({ from: "alerts@example.com", to: ["reader@example.com"], headers: email.headers });
    for (const [status, state] of [[401, "unavailable"], [403, "unavailable"], [429, "unavailable"], [409, "unknown"], [422, "rejected"], [400, "rejected"], [500, "unknown"]] as const) {
      expect(await sendEmail(email, (async () => new Response("{}", { status })) as unknown as typeof fetch), String(status)).toBe(state);
    }
    const named = (name: string) => (async () => Response.json({ statusCode: 422, name, message: "x" }, { status: 422 })) as unknown as typeof fetch;
    expect(await sendEmail(email, named("invalid_from_address"))).toBe("unavailable");
    expect(await sendEmail(email, named("validation_error"))).toBe("rejected");
    expect(await sendEmail(email, (async () => new Response("not json", { status: 422 })) as unknown as typeof fetch)).toBe("rejected");
    expect(await sendEmail(email, (async () => { throw new Error("network"); }) as unknown as typeof fetch)).toBe("unknown");
  });
});

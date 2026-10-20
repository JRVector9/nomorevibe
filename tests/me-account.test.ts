import { describe, expect, it } from "vitest";
import { deviceLabel } from "@/lib/domain/accounts/device";
import { safePublicReturnUrl } from "@/lib/i18n/routing";
import { DELETED_DISPLAY_NAME, displayNameChangeAvailableAt, isSessionPublicId, maskEmail, normalizeDisplayName, sessionPublicId } from "@/lib/me/profile";
import { shapeMeSummary } from "@/lib/me/summary";

/** 마이페이지 계정 탭(MY1) 규칙 — 기기 이름, 닉네임, 다음 변경일, 이메일 가리기, 머리 숫자 모양 */

describe("기기 이름(User-Agent → 'Mac · Chrome')", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "Mac · Chrome"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Mac · Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "iPhone · Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1", "iPhone · Chrome"],
    ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "iPad · Safari"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0", "Windows · Edge"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0", "Windows · Firefox"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "Android · Samsung Internet"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36;KAKAOTALK 2410150", "Android · KakaoTalk"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Whale/3.28.266.14 Safari/537.36", "Windows · Whale"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0", "Linux · Opera"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "ChromeOS · Chrome"],
  ])("%s", (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });

  it("모르면 null, 원문을 담지 않고 40자를 넘지 않는다", () => {
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel("")).toBeNull();
    expect(deviceLabel("curl/8.5.0")).toBeNull();
    const odd = deviceLabel(`Mozilla/5.0 (Windows NT 10.0) Firefox/131.0 ${"x".repeat(5_000)}`);
    expect(odd).toBe("Windows · Firefox");
    // 아주 긴 머리는 앞 512자만 본다
    expect(deviceLabel(`Mozilla/5.0 (Windows NT 10.0) ${"x".repeat(5_000)} Firefox/131.0`)).toBe("Windows");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14) secret-token-abc")).toBe("Android");
    for (const label of [odd, deviceLabel("Mozilla/5.0 (Macintosh) Chrome/1")]) expect(label!.length).toBeLessThanOrEqual(40);
  });
});

describe("닉네임", () => {
  it("앞뒤 공백을 떼고 가운데 공백을 하나로, 2~24자", () => {
    expect(normalizeDisplayName("  하늘   코더 ")).toBe("하늘 코더");
    expect(normalizeDisplayName("ab")).toBe("ab");
    expect(normalizeDisplayName("가".repeat(24))).toBe("가".repeat(24));
    // 글자 수는 코드 포인트로 센다 — 이모지 하나는 한 글자
    expect(normalizeDisplayName("🐯🐯")).toBe("🐯🐯");
  });

  it.each(["", " ", "a", " a ", "가".repeat(25), "line\nbreak", "tab\there", "zero​width", "rtl‮override", "nul\u0000", 42, null, undefined, {}, "x".repeat(300)])("거절: %j", (value) => {
    expect(() => normalizeDisplayName(value)).toThrow("invalid_display_name");
  });

  it("운영자·서비스·탈퇴 이름은 쓸 수 없다", () => {
    for (const name of [DELETED_DISPLAY_NAME, "nomorevibe", "NoMoreVibe 팀", "관리자", "운영 자", "Admin", "사이트admin"]) {
      expect(() => normalizeDisplayName(name)).toThrow("reserved_display_name");
    }
  });

  it("30일에 한 번 — 바꾼 적 없거나 지났으면 null, 아니면 다음 날짜", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    expect(displayNameChangeAvailableAt(null, now)).toBeNull();
    expect(displayNameChangeAvailableAt(new Date("2026-09-19T00:00:00Z"), now)).toBeNull();
    expect(displayNameChangeAvailableAt(new Date("2026-10-18T00:00:00Z"), now)?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });
});

describe("이메일 가리기·기기 줄 id", () => {
  it("앞 두 글자와 도메인만", () => {
    expect(maskEmail("hanul@example.com")).toBe("ha•••@example.com");
    expect(maskEmail("ab@example.com")).toBe("a•••@example.com");
    expect(maskEmail("a@example.com")).toBe("a•••@example.com");
    expect(maskEmail("broken")).toBe("•••");
  });

  it("세션 id 는 해시 앞 16자, 모양이 다르면 받지 않는다", () => {
    const hash = "a".repeat(16) + "b".repeat(48);
    expect(sessionPublicId(hash)).toBe("a".repeat(16));
    expect(isSessionPublicId("0123456789abcdef")).toBe(true);
    for (const value of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../../etc/passwd", hash, 1, null]) {
      expect(isSessionPublicId(value)).toBe(false);
    }
  });
});

describe("머리 숫자 모양(GET /api/me/summary)", () => {
  const user = { id: 7, displayName: "하늘코더", createdAt: new Date("2026-10-03T00:00:00Z") };
  it("개수는 0 이상 정수, 메이커는 참일 때만, GitHub 이 먼저", () => {
    const summary = shapeMeSummary(user, { saved: "23", tried: BigInt(8), opinions: 5, following: null, unread_alerts: "-1", is_maker: true }, [
      { provider: "email", providerLogin: null, githubLogin: "hanulcoder" },
      { provider: "github", providerLogin: null, githubLogin: "hanulcoder" },
      { provider: "google", providerLogin: "x", githubLogin: null },
    ]);
    expect(summary).toEqual({
      user: { id: 7, displayName: "하늘코더", createdAt: "2026-10-03T00:00:00.000Z" },
      counts: { saved: 23, tried: 8, opinions: 5, following: 0, unreadAlerts: 0 },
      isMaker: true,
      providers: [{ provider: "github", login: "hanulcoder" }, { provider: "email", login: null }],
    });
  });

  it("표시용 login 이 먼저이고, 모양이 이상한 login 은 싣지 않는다", () => {
    const summary = shapeMeSummary(user, { saved: 0, tried: 0, opinions: 0, following: 0, unread_alerts: 0, is_maker: "t" }, [
      { provider: "github", providerLogin: "renamed", githubLogin: "old-name" },
      { provider: "github", providerLogin: "<script>", githubLogin: null },
    ]);
    expect(summary.isMaker).toBe(false);
    expect(summary.providers).toEqual([{ provider: "github", login: "renamed" }, { provider: "github", login: null }]);
  });
});

describe("로그인 뒤 돌아올 곳", () => {
  it("마이페이지 탭 주소는 받고, 모르는 하위 주소는 받지 않는다", () => {
    expect(safePublicReturnUrl("/me")).toBe("/me");
    expect(safePublicReturnUrl("/me/account")).toBe("/me/account");
    expect(safePublicReturnUrl("/en/me/opinions")).toBe("/en/me/opinions");
    expect(safePublicReturnUrl("/me/tried?x=1#a")).toBe("/me/tried?x=1#a");
    expect(safePublicReturnUrl("/me/../admin")).toBe("/");
    expect(safePublicReturnUrl("/me/unknown")).toBe("/");
    expect(safePublicReturnUrl("/meow")).toBe("/");
  });
});

describe("/account → /me/account (Q1)", () => {
  it("네 언어 모두 같은 언어의 계정 탭으로 영구 이동한다", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.redirects!();
    const target = (source: string) => rules.find((rule) => rule.source === source);
    expect(target("/account")).toMatchObject({ destination: "/me/account", permanent: true });
    expect(target("/ko/account")).toMatchObject({ destination: "/me/account", permanent: true });
    expect(target("/en/account")).toMatchObject({ destination: "/en/me/account", permanent: true });
    expect(target("/zh-Hans/account")).toMatchObject({ destination: "/zh-Hans/me/account", permanent: true });
    expect(target("/zh-Hant/account")).toMatchObject({ destination: "/zh-Hant/me/account", permanent: true });
  });
});

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { nextMenuIndex } from "@/components/auth/AccountMenu";
import { OPINION_DETAIL_PREFIXES, opinionDetailMessages } from "@/components/me/opinion-messages";
import { products } from "@/lib/db/schema";
import { deviceLabel } from "@/lib/domain/accounts/device";
import { getDictionary } from "@/lib/i18n/dictionary";
import { LOCALES } from "@/lib/i18n/locales";
import { safePublicReturnUrl } from "@/lib/i18n/routing";
import { showsProjectsTab } from "@/lib/me/contract";
import {
  DELETED_DISPLAY_NAME, DISPLAY_NAME_INPUT_MAX, DISPLAY_NAME_MAX, displayNameChangeAvailableAt, displayNameDraft, exportFileName, isSessionPublicId, maskEmail,
  normalizeDisplayName, sessionPublicId,
} from "@/lib/me/profile";
import { shapeMeSummary } from "@/lib/me/summary";

const root = path.join(__dirname, "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

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

  it("비어 보이는 글자(한글 채움 문자·점자 빈칸·결합 부호만)는 받지 않는다 — 그 글자로 예약어를 비켜 가지도 못한다", () => {
    for (const name of ["\u3164\u3164", "\u3164하늘", "하늘\uFFA0", "\u115F\u1160", "\u2800\u2800", "\u0301\u0301", "\u0301ab", "하\u034F늘",
      "탈퇴한\u3164사용자", "관\u3164리자", "운\u3164영자", "ad\u3164min"]) {
      expect(() => normalizeDisplayName(name), JSON.stringify(name)).toThrow("invalid_display_name");
    }
    // 이모지 모양 고르기(U+FE0F)는 보이는 글자에 붙는 것이라 받는다
    expect(normalizeDisplayName("❤️하늘")).toBe("❤️하늘");
  });

  it("예약어는 전각·문장 부호·공백을 접어 보고, admin 은 낱말 앞·끝일 때만 막는다", () => {
    for (const name of ["ＡＤＭＩＮ", "admin", "superadmin", "Administrator", "my admin", "관-리-자", "운영_자", "노모어 바이브", "No.More.Vibe"]) {
      expect(() => normalizeDisplayName(name), name).toThrow("reserved_display_name");
    }
    for (const name of ["badminton", "Badminton lover", "Sadministrator", "하늘 코더"]) expect(normalizeDisplayName(name)).toBe(name);
  });

  it.each(LOCALES)("%s — 탈퇴한 작성자를 적는 이름(띄어쓰기·대소문자 바꾼 것도)은 쓸 수 없다", async (locale) => {
    const [me, detail] = await Promise.all([getDictionary(locale, "me"), getDictionary(locale, "detail")]);
    for (const label of [me["account.deletedName"], detail["feedback.deletedAuthor"]]) {
      for (const name of [label, label.replace(/\s+/g, ""), label.toUpperCase(), ` ${label.replace(/\s+/g, "-")} `]) {
        expect(() => normalizeDisplayName(name), name).toThrow("reserved_display_name");
      }
    }
  });

  it("글자 수 칸은 서버와 같게 센다 — 이모지·두 칸 공백·NFD 한글", () => {
    const tiger = "🐯".repeat(DISPLAY_NAME_MAX);
    const flags = "🇰🇷".repeat(DISPLAY_NAME_MAX / 2);
    const spaced = `${"가".repeat(12)}  ${"나".repeat(11)}`;
    const nfd = "한글닉네임입니당신감".normalize("NFD");
    for (const value of [tiger, flags, spaced, nfd, "  하늘   코더 "]) {
      const draft = displayNameDraft(value);
      expect([...draft].length, value).toBeLessThanOrEqual(DISPLAY_NAME_MAX);
      expect(normalizeDisplayName(value)).toBe(draft);
      // 입력 칸 상한(UTF-16)이 서버가 받는 이름을 자르지 않는다
      expect(value.length).toBeLessThanOrEqual(DISPLAY_NAME_INPUT_MAX);
    }
    expect([...displayNameDraft(nfd)].length).toBe(10);
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

  it("내 데이터 파일 이름의 날짜는 한국 날짜다", () => {
    expect(exportFileName("2026-10-20T15:30:00.000Z")).toBe("nomorevibe-my-data-20261021.json");
    expect(exportFileName("2026-10-21T14:59:59.000Z")).toBe("nomorevibe-my-data-20261021.json");
    expect(exportFileName("2026-10-21T15:00:00.000Z")).toBe("nomorevibe-my-data-20261022.json");
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

describe("로그인 뒤 돌아올 곳 — 공개 화면 목록", () => {
  /** app/(public)/[locale] 아래 page 마다 논리 주소("/p/[slug]" → "/p/sample") */
  function publicPages(directory = path.join(root, "app/(public)/[locale]"), segments: string[] = []): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith("@")) return [];
      if (entry.isDirectory()) return publicPages(path.join(directory, entry.name), /^\(.*\)$/.test(entry.name) ? segments : [...segments, entry.name]);
      return /^page\.tsx?$/.test(entry.name) ? [`/${segments.map((segment) => segment.startsWith("[") ? "sample" : segment).join("/")}`.replace(/\/$/, "") || "/"] : [];
    });
  }

  it("모든 공개 화면에서 로그인하면 그 화면으로 돌아온다(/talk 포함)", () => {
    const pages = publicPages();
    expect(pages).toEqual(expect.arrayContaining(["/", "/talk", "/rising", "/p/sample", "/me/account"]));
    for (const page of pages) {
      expect(safePublicReturnUrl(page), page).toBe(page);
      expect(safePublicReturnUrl(`/en${page === "/" ? "" : page}`), page).toBe(`/en${page === "/" ? "" : page}`);
    }
  });
});

describe("내 프로젝트 탭·메뉴", () => {
  it("확인한 메이커와 GitHub 계정에 보인다 — 이미 등재된 내 저장소를 확인하는 곳이 그 탭뿐이다", () => {
    expect(showsProjectsTab({ isMaker: false, providers: [{ provider: "github" }] })).toBe(true);
    expect(showsProjectsTab({ isMaker: true, providers: [{ provider: "email" }] })).toBe(true);
    expect(showsProjectsTab({ isMaker: false, providers: [{ provider: "email" }] })).toBe(false);
    expect(showsProjectsTab(null)).toBe(false);
    expect(showsProjectsTab(undefined)).toBe(false);
  });
});

describe("아바타 메뉴 화살표", () => {
  it("판 밖(아바타 단추)에서 ↑ 는 마지막(로그아웃), ↓ 는 첫 항목. 안에서는 끝에서 돈다", () => {
    expect(nextMenuIndex(-1, 8, false)).toBe(7);
    expect(nextMenuIndex(-1, 8, true)).toBe(0);
    expect(nextMenuIndex(0, 8, false)).toBe(7);
    expect(nextMenuIndex(7, 8, true)).toBe(0);
    expect(nextMenuIndex(3, 8, true)).toBe(4);
  });
});

describe("의견 탭의 detail 사전 몫", () => {
  /** 탭(OpinionList)·전달 상태(FeedbackDeliveryStatus)에 글자 그대로 적힌 열쇠와 `delivery.${…}` 같은 열쇠 머리 */
  const text = ["components/me/OpinionList.tsx", "components/product-detail/FeedbackDeliveryStatus.tsx"].map(source).join("\n");
  const literal = [...new Set([...text.matchAll(/(?:detail|t)\("((?:feedback|delivery|issue)\.[A-Za-z_.]+)"/g)].map((match) => match[1]))];
  const families = [...new Set([...text.matchAll(/`((?:feedback|delivery|issue)\.[A-Za-z_.]*)\$\{/g)].map((match) => match[1]))];

  it.each(LOCALES)("%s — 탭이 쓰는 열쇠는 모두 남고, 나머지 상세 글은 빠진다", async (locale) => {
    const detail = await getDictionary(locale, "detail");
    const picked = opinionDetailMessages(detail);
    expect(literal.length).toBeGreaterThan(3);
    expect(families).toEqual(expect.arrayContaining(["delivery.", "issue.", "feedback.kind.", "feedback.reason."]));
    for (const key of literal) expect(picked[key as keyof typeof picked], key).toBe(detail[key as keyof typeof detail]);
    for (const family of families) {
      expect(OPINION_DETAIL_PREFIXES.some((prefix) => family.startsWith(prefix)), family).toBe(true);
      for (const [key, value] of Object.entries(detail)) if (key.startsWith(family)) expect(picked[key as keyof typeof picked]).toBe(value);
    }
    expect(Object.keys(picked).length).toBeLessThan(Object.keys(detail).length / 5);
  });
});

describe("저장소 주인 열쇠 색인(products_listed_owner_idx)", () => {
  it("drizzle 선언이 0108 색인·질의와 같은 정규식이다(점은 \\. 로)", () => {
    const index = getTableConfig(products).indexes.find((item) => item.config.name === "products_listed_owner_idx")!;
    const rendered = new PgDialect().sqlToQuery(index.config.columns[0] as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
    const pattern = (value: string) => /from '([^']+)'/.exec(value)?.[1];
    const migrated = /CREATE INDEX "products_listed_owner_idx"[^\n]*/.exec(source("drizzle/0108_mypage.sql"))![0];
    expect(pattern(rendered)).toBe("^https?://(?:www\\.)?github\\.com/([a-z0-9-]+)/[^/]+/?$");
    expect(pattern(rendered)).toBe(pattern(migrated));
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

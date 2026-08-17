import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signSession, verifySession } from "@/lib/auth/session";
import { isAdminLogin, adminLogins, authSecret } from "@/lib/auth/admin";

const SECRET = "테스트용비밀키".repeat(4).slice(0, 40); // 32자 이상
const NOW = 1_800_000_000;

describe("세션 서명", () => {
  it("발급한 쿠키를 검증하고 로그인명을 돌려준다", async () => {
    const cookie = await signSession("JRVector9", SECRET, NOW);
    const session = await verifySession(cookie, SECRET, NOW);
    expect(session?.login).toBe("JRVector9");
  });

  it("다른 비밀키로 서명된 것은 거부한다", async () => {
    const cookie = await signSession("JRVector9", "다른비밀키".repeat(8).slice(0, 40), NOW);
    expect(await verifySession(cookie, SECRET, NOW)).toBeNull();
  });

  it("본문을 고쳐 다른 사람이 되려는 시도를 막는다", async () => {
    const cookie = await signSession("손님", SECRET, NOW);
    const [, signature] = cookie.split(".");

    // 서명은 그대로 두고 본문만 관리자로 바꿔치기
    const forgedBody = Buffer.from(JSON.stringify({ login: "JRVector9", exp: NOW + 3600 })).toString(
      "base64url",
    );
    expect(await verifySession(`${forgedBody}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("만료된 쿠키를 거부한다", async () => {
    const cookie = await signSession("JRVector9", SECRET, NOW);
    // 12시간 뒤
    expect(await verifySession(cookie, SECRET, NOW + 12 * 3600 + 1)).toBeNull();
  });

  it("형태가 깨진 값을 거부한다", async () => {
    for (const value of [undefined, "", "서명없음", ".", "a.b.c", "!!!.???"]) {
      expect(await verifySession(value, SECRET, NOW), String(value)).toBeNull();
    }
  });

  it("만료 시각이 없는 본문을 거부한다", async () => {
    // 서명은 유효하지만 형태가 세션이 아닌 경우
    const body = Buffer.from(JSON.stringify({ login: "JRVector9" })).toString("base64url");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const raw = new Uint8Array(Buffer.from(body, "base64url"));
    const sig = await crypto.subtle.sign("HMAC", key, raw);
    const cookie = `${body}.${Buffer.from(sig).toString("base64url")}`;

    expect(await verifySession(cookie, SECRET, NOW)).toBeNull();
  });
});

describe("어드민 허용목록", () => {
  const saved = process.env.ADMIN_GITHUB_LOGINS;
  beforeEach(() => {
    delete process.env.ADMIN_GITHUB_LOGINS;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ADMIN_GITHUB_LOGINS = saved;
    else delete process.env.ADMIN_GITHUB_LOGINS;
  });

  it("설정이 비어 있으면 아무도 어드민이 아니다 — 실수로 열려 있는 것보다 낫다", () => {
    expect(adminLogins()).toEqual([]);
    expect(isAdminLogin("JRVector9")).toBe(false);
  });

  it("목록에 있으면 통과한다", () => {
    process.env.ADMIN_GITHUB_LOGINS = "JRVector9";
    expect(isAdminLogin("JRVector9")).toBe(true);
    expect(isAdminLogin("someone-else")).toBe(false);
  });

  it("GitHub 로그인명은 대소문자를 구분하지 않는다", () => {
    process.env.ADMIN_GITHUB_LOGINS = "JRVector9";
    expect(isAdminLogin("jrvector9")).toBe(true);
    expect(isAdminLogin("JRVECTOR9")).toBe(true);
  });

  it("쉼표로 여러 명, 공백은 무시한다", () => {
    process.env.ADMIN_GITHUB_LOGINS = " alice , bob ,, ";
    expect(adminLogins()).toEqual(["alice", "bob"]);
    expect(isAdminLogin("bob")).toBe(true);
  });
});

describe("비밀키 요건", () => {
  const saved = process.env.AUTH_SECRET;
  afterEach(() => {
    if (saved !== undefined) process.env.AUTH_SECRET = saved;
    else delete process.env.AUTH_SECRET;
  });

  it("짧은 비밀키는 거부한다 — 서명의 의미가 없어진다", () => {
    process.env.AUTH_SECRET = "짧음";
    expect(authSecret()).toBeNull();
  });

  it("미설정이면 null이다", () => {
    delete process.env.AUTH_SECRET;
    expect(authSecret()).toBeNull();
  });

  it("32자 이상이면 통과한다", () => {
    process.env.AUTH_SECRET = "x".repeat(32);
    expect(authSecret()).toBe("x".repeat(32));
  });
});

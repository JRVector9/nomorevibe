import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CommitFacts } from "@/lib/domain/evidence/ai-level";
import {
  currentOwnerLogin, MAINTAINER_EMAIL_DENY_HASH, MAINTAINER_EMAILS_PER_REPOSITORY, maintainerEmailDenyHash, maintainerEmailOf, maskMaintainerEmail,
  ownerMaintainerEmails,
} from "@/lib/domain/makers/maintainer-emails";

// 남는 주소 시험은 운영자가 가진 도메인의 시험용 하위 도메인(*.fixture.nomorevibe.com, 받는 곳 없음)을 쓴다 — 남의 실제 주소가 아니다.
// 예약 도메인(example.*·.test)은 코드가 버리므로 남는 주소 시험에는 쓸 수 없다(버리는 쪽 시험에만 쓴다)
const SHA = "a".repeat(40);
const commit = (author: Partial<CommitFacts> = {}, message = "fix: x"): CommitFacts =>
  ({ sha: SHA, message, parents: 1, authorName: "Kim", authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim", ...author });
/** GraphQL 응답의 지금 주인 owner { __typename login } */
const user = (login = "kim") => ({ login, type: "User" });

describe("maintainerEmailOf — 사람 주소만 남긴다", () => {
  it("실제 꼴의 주소는 앞뒤 공백을 떼고 소문자로 다듬어 남긴다", () => {
    expect(maintainerEmailOf("  Kim.Park+OSS@Fixture.NoMoreVibe.COM ")).toBe("kim.park+oss@fixture.nomorevibe.com");
    expect(maintainerEmailOf("dev@kr.fixture.nomorevibe.com")).toBe("dev@kr.fixture.nomorevibe.com");
  });

  it("GitHub 비공개 주소·봇·AI 도구·예약 주소는 버린다", () => {
    for (const raw of [
      "12345+kim@users.noreply.github.com", "kim@users.noreply.github.com", "noreply@github.com", "noreply@anthropic.com",
      "no-reply@fixture.nomorevibe.com", "49699333+dependabot[bot]@users.noreply.github.com", "deploy-bot@fixture.nomorevibe.com", "ci.bot@fixture.nomorevibe.com",
      "kim@example.com", "kim@example.test", "kim@localhost", "kim@macbook.local", "root@ubuntu.internal", "kim@host.lan", "(none)", "kim", "kim@", "@fixture.nomorevibe.com",
      "kim@fixture", "kim@fixture.123", `${"a".repeat(250)}@fixture.nomorevibe.com`, "root@fixture.nomorevibe.com", "github-actions@fixture.nomorevibe.com",
    ]) expect(maintainerEmailOf(raw), raw).toBeNull();
  });

  it("bot 이 이름 가운데에 든 사람 주소는 남긴다", () => {
    expect(maintainerEmailOf("abbott@fixture.nomorevibe.com")).toBe("abbott@fixture.nomorevibe.com");
    expect(maintainerEmailOf("botany.kim@fixture.nomorevibe.com")).toBe("botany.kim@fixture.nomorevibe.com");
  });
});

describe("ownerMaintainerEmails — 저장소의 지금 주인(개인 계정)의 주소만", () => {
  it("커밋 작성자의 GitHub 로그인이 지금 주인과 같은 커밋만 — 다른 기여자·계정에 안 이어진 커밋은 이름이 같아도 뺀다", () => {
    const { emails, skip, ownerLogin } = ownerMaintainerEmails([
      commit({ authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "Kim" }),
      commit({ authorEmail: "lee@fixture.nomorevibe.com", authorName: "Lee", authorLogin: "lee" }),
      // 이름 글자는 보지 않는다 — 로그인이 없으면(주소가 계정에 이어지지 않음) 주인이라는 근거가 없다
      commit({ authorEmail: "kim.other@fixture.nomorevibe.com", authorName: "Kim", authorLogin: null }),
      commit({ authorEmail: "kim@fixture.nomorevibe.com", authorLogin: "kim" }),
    ], user("KIM"));
    expect({ skip, ownerLogin }).toEqual({ skip: null, ownerLogin: "kim" });
    expect(emails).toEqual([{ email: "kim@fixture.nomorevibe.com", name: "Kim", login: "Kim", commits: 2 }]);
  });

  it("지금 주인이 조직이거나 응답에 주인이 없으면 커밋을 보지 않는다", () => {
    expect(ownerMaintainerEmails([commit({ authorLogin: "acme" })], { login: "acme", type: "Organization" }))
      .toEqual({ emails: [], skip: "organization", ownerLogin: null });
    for (const owner of [null, { login: "kim", type: "Bot" }, { login: "kim.dev", type: "User" }, { login: "-kim", type: "User" }]) {
      expect(ownerMaintainerEmails([commit()], owner), JSON.stringify(owner)).toEqual({ emails: [], skip: "owner_unknown", ownerLogin: null });
    }
    expect(currentOwnerLogin({ login: "Kim", type: "User" })).toBe("kim");
  });

  it("옮겨 간 저장소: 저장된 키가 아니라 지금 주인으로 맞춘다 — 다른 사람에게 옮겨 가면 그 사람의 커밋만", () => {
    // 키는 kim/tool 이지만 GitHub 은 lee 에게 옮겨 간 저장소를 돌려준다 — 옛 주인 kim 의 커밋은 이제 제작자 커밋이 아니다
    const { emails, ownerLogin } = ownerMaintainerEmails([commit(), commit({ authorEmail: "lee@fixture.nomorevibe.com", authorName: "Lee", authorLogin: "lee" })], user("lee"));
    expect(ownerLogin).toBe("lee");
    expect(emails.map(row => row.email)).toEqual(["lee@fixture.nomorevibe.com"]);
  });

  it("주인 커밋이 있어도 남길 주소가 없으면 까닭을 따로 센다(비공개 주소·AI 도구 작성)", () => {
    expect(ownerMaintainerEmails([commit({ authorEmail: "1+kim@users.noreply.github.com" })], user()))
      .toEqual({ emails: [], skip: "no_usable_address", ownerLogin: "kim" });
    // AI 도구가 작성자인 커밋은 주인 로그인이어도 주인 커밋으로 치지 않는다
    expect(ownerMaintainerEmails([commit({ authorName: "Cursor Agent", authorEmail: "cursoragent@cursor.com", authorLogin: "kim" })], user()).emails).toEqual([]);
    expect(ownerMaintainerEmails([], user())).toEqual({ emails: [], skip: "no_owner_commit", ownerLogin: "kim" });
  });

  it("Co-authored-by 꼬리 줄의 주소는 보지 않는다", () => {
    const { emails } = ownerMaintainerEmails([commit({}, "feat\n\nCo-authored-by: Park <park@fixture.nomorevibe.com>")], user());
    expect(emails.map(row => row.email)).toEqual(["kim@fixture.nomorevibe.com"]);
  });

  it("한 사람이 쓴 주소도 정해진 수까지만, 커밋이 많은 주소부터 — 이름의 제어 문자는 지운다", () => {
    const many = Array.from({ length: MAINTAINER_EMAILS_PER_REPOSITORY + 3 }, (_, i) => commit({ authorEmail: `p${i}@fixture.nomorevibe.com`, authorName: `P\u0000${i}` }));
    const { emails } = ownerMaintainerEmails([...many, commit({ authorEmail: "p2@fixture.nomorevibe.com" })], user());
    expect(emails).toHaveLength(MAINTAINER_EMAILS_PER_REPOSITORY);
    expect(emails[0]).toMatchObject({ email: "p2@fixture.nomorevibe.com", commits: 2 });
    expect(emails[1]).toMatchObject({ email: "p0@fixture.nomorevibe.com", name: "P0" });
  });
});

describe("거부 목록 열쇠·가린 주소", () => {
  it("정규화한 주소의 해시 — 대소문자·공백을 가리지 않고, 맨 sha256(주소)와 다르다", () => {
    const key = maintainerEmailDenyHash("kim@fixture.nomorevibe.com");
    expect(key).toMatch(MAINTAINER_EMAIL_DENY_HASH);
    expect(maintainerEmailDenyHash("  KIM@Fixture.NoMoreVibe.com ")).toBe(key);
    expect(maintainerEmailDenyHash("lee@fixture.nomorevibe.com")).not.toBe(key);
    expect(key).not.toBe(createHash("sha256").update("kim@fixture.nomorevibe.com").digest("hex"));
  });

  it("확인 창에는 앞 한 글자와 도메인만", () => {
    expect(maskMaintainerEmail("kim@fixture.nomorevibe.com")).toBe("k***@fixture.nomorevibe.com");
    expect(maskMaintainerEmail("broken")).toBe("***");
  });
});

import { describe, expect, it } from "vitest";
import type { CommitFacts } from "@/lib/domain/evidence/ai-level";
import { MAINTAINER_EMAILS_PER_REPOSITORY, maintainerEmailOf, maintainerEmails } from "@/lib/domain/makers/maintainer-emails";

const SHA = "a".repeat(40);
const commit = (author: Partial<CommitFacts> = {}, message = "fix: x"): CommitFacts =>
  ({ sha: SHA, message, parents: 1, authorName: "Kim", authorEmail: "kim@acme.dev", authorLogin: "kim", ...author });

describe("maintainerEmailOf — 사람 주소만 남긴다", () => {
  it("실제 주소는 소문자로 다듬어 남긴다", () => {
    expect(maintainerEmailOf("  Kim.Lee+oss@Gmail.COM ")).toBe("kim.lee+oss@gmail.com");
    expect(maintainerEmailOf("dev@studio.co.kr")).toBe("dev@studio.co.kr");
  });

  it("GitHub 비공개 주소·봇·AI 도구·예약 주소는 버린다", () => {
    for (const raw of [
      "12345+kim@users.noreply.github.com", "kim@users.noreply.github.com", "noreply@github.com", "noreply@anthropic.com",
      "no-reply@company.com", "49699333+dependabot[bot]@users.noreply.github.com", "deploy-bot@company.com", "ci.bot@company.com",
      "kim@example.com", "kim@localhost", "kim@macbook.local", "root@ubuntu.internal", "kim@host.lan", "(none)", "kim", "kim@", "@acme.dev",
      "kim@acme", "kim@acme.123", `${"a".repeat(250)}@a.dev`, "root@acme.dev", "github-actions@acme.dev",
    ]) expect(maintainerEmailOf(raw), raw).toBeNull();
  });

  it("bot 이 이름 가운데에 든 사람 주소는 남긴다", () => {
    expect(maintainerEmailOf("abbott@acme.dev")).toBe("abbott@acme.dev");
    expect(maintainerEmailOf("botany.kim@acme.dev")).toBe("botany.kim@acme.dev");
  });
});

describe("maintainerEmails — 커밋 묶음에서 모으기", () => {
  it("같은 주소는 하나로 모아 커밋 수를 세고, 많은 사람부터", () => {
    const rows = maintainerEmails([
      commit({ authorEmail: "lee@acme.dev", authorName: "Lee", authorLogin: null }),
      commit(), commit({ authorEmail: "KIM@acme.dev" }), commit({ authorEmail: "lee@acme.dev", authorLogin: "lee" }), commit(),
    ]);
    expect(rows).toEqual([
      { email: "kim@acme.dev", name: "Kim", login: "kim", commits: 3 },
      { email: "lee@acme.dev", name: "Lee", login: "lee", commits: 2 },
    ]);
  });

  it("AI 도구가 작성자인 커밋은 빼고, Co-authored-by 주소는 보지 않는다", () => {
    const rows = maintainerEmails([
      commit({ authorName: "Cursor Agent", authorEmail: "cursoragent@cursor.com", authorLogin: "cursoragent" }),
      commit({ authorName: "Codex", authorEmail: "codex@openai.com", authorLogin: "codex" }),
      commit({}, "feat\n\nCo-authored-by: Park <park@acme.dev>"),
    ]);
    expect(rows.map(row => row.email)).toEqual(["kim@acme.dev"]);
  });

  it("저장소마다 정해진 수까지만, 이름의 제어 문자는 지운다", () => {
    const many = Array.from({ length: MAINTAINER_EMAILS_PER_REPOSITORY + 5 }, (_, i) => commit({ authorEmail: `p${i}@acme.dev`, authorName: `P\u0000${i}` }));
    const rows = maintainerEmails(many);
    expect(rows).toHaveLength(MAINTAINER_EMAILS_PER_REPOSITORY);
    expect(rows[0]).toMatchObject({ email: "p0@acme.dev", name: "P0" });
  });

  it("사람 주소가 없으면 빈 목록", () => {
    expect(maintainerEmails([commit({ authorEmail: "1+kim@users.noreply.github.com" })])).toEqual([]);
    expect(maintainerEmails([])).toEqual([]);
  });
});

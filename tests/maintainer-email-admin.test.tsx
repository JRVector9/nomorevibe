import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 제작자 이메일 관리자 화면(0194) — 표는 서버 부품이 그리고, 지우기 단추(브라우저 부품)에는 주소를 넘기지 않는다.
 * 지우기 동작은 관리자 확인 뒤에만, 주소 꼴의 값은 받지 않으며, 실패 기록에도 주소·해시를 남기지 않는다. 실제 DB 동작은 tests/integration/ai-level-refresh.test.ts.
 */
const fake = vi.hoisted(() => ({ admin: vi.fn(), product: vi.fn(), deny: vi.fn(), record: vi.fn(), button: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: fake.admin }));
vi.mock("@/lib/domain/products/repository", () => ({ findBySlug: fake.product }));
vi.mock("@/lib/domain/makers/maintainer-emails-admin", () => ({ denyMaintainerEmail: fake.deny, MAINTAINER_EMAIL_DENY_ACTION: "maintainer-email-deny" }));
vi.mock("@/lib/operations/admin-log", () => ({ recordAdminAction: fake.record }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (action: unknown) => action }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/(operator)/admin/products/[slug]/MaintainerEmailDeny", () => ({
  MaintainerEmailDeny: (props: Record<string, unknown>) => { fake.button(props); return createElement("button", { type: "button" }, "지우기"); },
}));
const { denyMaintainerEmailAction } = await import("@/app/(operator)/admin/products/[slug]/actions");
const { MaintainerEmailsPanel } = await import("@/app/(operator)/admin/products/[slug]/MaintainerEmails");
const { maintainerEmailDenyHash, maskMaintainerEmail } = await import("@/lib/domain/makers/maintainer-emails");

const EMAIL = "kim@fixture.nomorevibe.com";
const KEY = maintainerEmailDenyHash(EMAIL);
const form = (values: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };

beforeEach(() => {
  vi.clearAllMocks();
  fake.admin.mockResolvedValue({ login: "operator" });
  fake.product.mockResolvedValue({ slug: "kim-tool", repoUrl: "https://github.com/kim/tool" });
  fake.deny.mockResolvedValue({ deletedRows: 2, alreadyDenied: false, found: true });
});

describe("제작자 이메일 표", () => {
  it("주소는 서버 부품의 표에만 — 지우기 단추에는 거부 열쇠와 가린 주소만 넘긴다", () => {
    const at = new Date("2026-11-21T00:00:00Z");
    const html = renderToStaticMarkup(createElement(MaintainerEmailsPanel, { slug: "kim-tool", view: { repositoryKey: "kim/tool", rows: [
      { email: EMAIL, name: "Kim", login: "kim", commits: 2, firstSeenAt: at, lastSeenAt: at, denyKey: KEY, masked: maskMaintainerEmail(EMAIL) },
    ] } }));
    expect(html).toContain(`<code>${EMAIL}</code>`);
    expect(html).toContain("제작자 이메일 (관리자 전용·비공개)");
    expect(fake.button).toHaveBeenCalledTimes(1);
    const props = fake.button.mock.calls[0][0] as Record<string, unknown>;
    expect(props).toEqual({ slug: "kim-tool", denyKey: KEY, masked: "k***@fixture.nomorevibe.com" });
    expect(JSON.stringify(props)).not.toContain(EMAIL);
  });

  it("못 읽음·저장소 없음·빈 목록을 구분한다", () => {
    const render = (view: Parameters<typeof MaintainerEmailsPanel>[0]["view"]) => renderToStaticMarkup(createElement(MaintainerEmailsPanel, { slug: "kim-tool", view }));
    expect(render(null)).toContain("제작자 이메일을 읽지 못했습니다.");
    expect(render({ repositoryKey: null, rows: [] })).toContain("GitHub 저장소가 없는 프로젝트라 모으지 않습니다.");
    expect(render({ repositoryKey: "kim/tool", rows: [] })).toContain("모은 주소가 없습니다.");
  });
});

describe("지우고 다시 모으지 않기 동작", () => {
  it("관리자가 아니면 아무것도 지우지 않는다", async () => {
    fake.admin.mockResolvedValue(null);
    expect(await denyMaintainerEmailAction(null, form({ slug: "kim-tool", denyKey: KEY }))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(fake.deny).not.toHaveBeenCalled();
  });

  it("주소 꼴의 값·깨진 식별자는 받지 않는다 — 양식은 해시만 보낸다", async () => {
    for (const values of [{ slug: "kim-tool", denyKey: EMAIL }, { slug: "Kim Tool", denyKey: KEY }, { slug: "kim-tool", denyKey: KEY.toUpperCase() }]) {
      expect(await denyMaintainerEmailAction(null, form(values))).toEqual({ issues: ["지울 주소를 확인해주세요."] });
    }
    expect(fake.deny).not.toHaveBeenCalled();
  });

  it("저장소는 양식이 아니라 제품의 repo_url 로 정하고 지운다", async () => {
    expect(await denyMaintainerEmailAction(null, form({ slug: "kim-tool", denyKey: KEY, repoUrl: "https://github.com/other/repo" })))
      .toEqual({ ok: true, deletedRows: 2 });
    expect(fake.deny).toHaveBeenCalledWith({ slug: "kim-tool", repoUrl: "https://github.com/kim/tool", denyKey: KEY, actor: "operator" });
    fake.product.mockResolvedValue(undefined);
    expect(await denyMaintainerEmailAction(null, form({ slug: "gone", denyKey: KEY }))).toEqual({ issues: ["제품을 찾을 수 없습니다."] });
  });

  it("실패하면 실패 기록을 남기되 주소·해시·SQL 은 남기지 않는다(DB 까닭 코드만)", async () => {
    fake.deny.mockRejectedValue(Object.assign(new Error(`Failed query: delete from "repository_maintainer_emails" where "email" = $1 params: ${EMAIL}`),
      { cause: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) }));
    expect(await denyMaintainerEmailAction(null, form({ slug: "kim-tool", denyKey: KEY }))).toEqual({ issues: ["주소를 지우지 못했습니다. 잠시 후 다시 시도해주세요."] });
    expect(fake.record).toHaveBeenCalledWith("operator", { action: "maintainer-email-deny", target: "kim-tool", ok: false, error: "55P03" });
    expect(JSON.stringify(fake.record.mock.calls)).not.toContain(EMAIL);
    expect(JSON.stringify(fake.record.mock.calls)).not.toContain(KEY);
  });
});

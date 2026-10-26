import { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/locales";
import { detail as ko } from "@/messages/ko/detail";
import { detail as en } from "@/messages/en/detail";
import { detail as hans } from "@/messages/zh-Hans/detail";
import { detail as hant } from "@/messages/zh-Hant/detail";

const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], cursor: 0, refCursor: 0, locale: "ko" as Locale }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const slot = hooks.cursor++;
    if (!(slot in hooks.states)) hooks.states[slot] = initial;
    return [hooks.states[slot], (value: unknown) => { hooks.states[slot] = typeof value === "function" ? value(hooks.states[slot]) : value; }];
  },
  useRef(initial: unknown) {
    const slot = hooks.refCursor++;
    return hooks.refs[slot] ??= { current: initial };
  },
}));
vi.mock("@/lib/i18n/context", () => ({ useLocale: () => hooks.locale,
  useTranslations: () => createTranslator("detail", { ko, en, "zh-Hans": hans, "zh-Hant": hant }[hooks.locale]) }));
vi.mock("@/components/me/account-store", () => ({ recheckMeState: vi.fn() }));
const { recheckMeState } = await import("@/components/me/account-store");
const { GithubOwnershipClaim } = await import("@/components/product-detail/GithubOwnershipClaim");
const session = { status: "ok" as const, account: { user: { id: 5, displayName: "Owner" }, csrfToken: "session-csrf", providers: [], isMaker: false, savedVersion: null } };
const navigate = vi.fn();

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0; hooks.locale = "ko";
  vi.mocked(recheckMeState).mockResolvedValue(session);
  navigate.mockReset();
  vi.stubGlobal("window", { location: { href: "https://nomorevibe.example/p/tool?from=detail#evidence", assign: navigate } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function render(options: { authEnabled?: boolean; githubEnabled?: boolean } = {}) {
  hooks.cursor = 0; hooks.refCursor = 0;
  return GithubOwnershipClaim({ productId: 12, slug: "tool", ...options });
}
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...nodes(element.props.children)];
}
function button(tree: ReactNode, name: string) {
  const found = nodes(tree).find((node) => node.type === "button" && node.props.children === name);
  expect(found, `missing button: ${name}`).toBeTruthy();
  return found!;
}
async function click(name: string) {
  (button(render(), name).props.onClick as () => void)();
  await vi.waitFor(() => expect(hooks.states[0]).toBe(false));
}
function result(value: string) {
  return Response.json({ results: [{ productId: 12, slug: "tool", name: "Tool", repo: "acme/tool", result: value }] });
}

describe("public detail ownership action", () => {
  it.each(["ko", "en", "zh-Hans", "zh-Hant"] as const)("returns a signed-out %s owner to the exact product query and ownership anchor", async (locale) => {
    hooks.locale = locale;
    const prefix = locale === "ko" ? "" : `/${locale}`;
    vi.stubGlobal("window", { location: { href: `https://nomorevibe.example${prefix}/p/tool?from=detail#evidence`, assign: navigate } });
    vi.mocked(recheckMeState).mockResolvedValue({ status: "ok", account: null });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const dictionary = { ko, en, "zh-Hans": hans, "zh-Hant": hant }[locale];
    await click(dictionary["owner.claim.button"]);
    const destination = new URL(navigate.mock.calls[0][0], "https://nomorevibe.example");
    expect(destination.pathname).toBe(`${prefix}/login`);
    expect(destination.searchParams.get("connectGithub")).toBe("1");
    expect(destination.searchParams.get("returnTo")).toBe(`${prefix}/p/tool?from=detail#owner-claim`);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("connects an email-only account when the hardened endpoint requires GitHub identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "github_login_required" }, { status: 403 })));
    await click(ko["owner.claim.button"]);
    expect(navigate).toHaveBeenCalledWith("/login?connectGithub=1&returnTo=%2Fp%2Ftool%3Ffrom%3Ddetail%23owner-claim");
    expect(hooks.states[1]).toBe(false);
  });

  it.each(["verified", "already_verified"])("uses exact product ID and session CSRF, then exposes management for %s", async (value) => {
    const fetcher = vi.fn(async () => result(value)); vi.stubGlobal("fetch", fetcher);
    await click(ko["owner.claim.button"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(["/api/maker/claims", expect.objectContaining({ method: "POST", cache: "no-store",
      headers: { "content-type": "application/json", "x-csrf-token": "session-csrf" }, body: JSON.stringify({ productIds: [12] }) })]);
    const html = renderToStaticMarkup(render());
    expect(html).toContain('href="/me/projects"'); expect(html).toContain(ko["owner.claim.verified"]);
    expect(html).not.toContain(ko["owner.claim.button"]); expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["owner_mismatch", "owner.claim.ownerMismatch"], ["org_repo_not_supported_yet", "owner.claim.orgRepository"],
    ["repo_replaced", "owner.claim.repoReplaced"], ["repo_unverified", "owner.claim.repoUnverified"],
  ] as const)("shows %s without claiming success or offering administrative approval", async (value, key) => {
    vi.stubGlobal("fetch", vi.fn(async () => result(value)));
    await click(ko["owner.claim.button"]);
    const html = renderToStaticMarkup(render());
    expect(html).toContain(ko[key]); expect(html).toContain('role="alert"'); expect(html).not.toContain('href="/me/projects"');
  });

  it("does not bypass a failed CSRF check or treat a lost response as success", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: "invalid_csrf" }, { status: 403 })).mockRejectedValueOnce(new Error("network"));
    vi.stubGlobal("fetch", fetcher);
    await click(ko["owner.claim.button"]);
    expect(renderToStaticMarkup(render())).toContain(ko["owner.claim.sessionExpired"]);
    await click(ko["owner.claim.button"]);
    expect(renderToStaticMarkup(render())).toContain(ko["owner.claim.unavailable"]);
    expect(hooks.states[1]).toBe(false); expect(navigate).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("provides organization proof creation, a prefilled GitHub editor, then explicit file verification and management", async () => {
    const challenge = { token: "signed-proof-token", path: ".nomorevibe/claim-12-5.txt", expiresAt: "2026-10-26T01:00:00Z",
      repositoryUrl: "https://github.com/acme/tool", editUrl: "https://github.com/acme/tool/new/main?filename=.nomorevibe%2Fclaim-12-5.txt&value=signed-proof-token" };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(challenge)).mockResolvedValueOnce(Response.json({ result: "verified", slug: "tool" }));
    vi.stubGlobal("fetch", fetcher);
    await click(ko["owner.claim.createFile"]);
    const html = renderToStaticMarkup(render());
    expect(html).toContain(challenge.path); expect(html).toContain(challenge.token); expect(html).toContain('target="_blank"');
    expect(html).toContain("기본 브랜치"); expect(html).toContain("관리자 승인 없이");
    await click(ko["owner.claim.checkFile"]);
    expect(fetcher.mock.calls[1]).toEqual(["/api/maker/claims/repo-file", expect.objectContaining({ method: "POST", body: JSON.stringify({ productId: 12, token: challenge.token }),
      headers: { "content-type": "application/json", "x-csrf-token": "session-csrf" } })]);
    expect(renderToStaticMarkup(render())).toContain('href="/me/projects"');
  });

  it("uses ordinary sign-in for repository file proof without requiring GitHub identity", async () => {
    vi.mocked(recheckMeState).mockResolvedValue({ status: "ok", account: null });
    await click(ko["owner.claim.createFile"]);
    expect(navigate).toHaveBeenCalledWith("/login?returnTo=%2Fp%2Ftool%3Ffrom%3Ddetail%23owner-claim");
  });

  it("shows no enabled controls when public authentication is disabled and retains file proof when GitHub sign-in is off", () => {
    expect(nodes(render({ authEnabled: false })).some((node) => node.type === "button")).toBe(false);
    const html = renderToStaticMarkup(render({ githubEnabled: false }));
    expect(html).not.toContain(ko["owner.claim.button"]); expect(html).toContain(ko["owner.claim.createFile"]);
  });

  it("coalesces rapid clicks before the first session response, with no background mutation", async () => {
    let resolve!: (value: typeof session) => void;
    vi.mocked(recheckMeState).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const fetcher = vi.fn(async () => result("verified")); vi.stubGlobal("fetch", fetcher);
    const click = button(render(), ko["owner.claim.button"]).props.onClick as () => void;
    expect(fetcher).not.toHaveBeenCalled(); click(); click();
    expect(recheckMeState).toHaveBeenCalledTimes(1); resolve(session);
    await vi.waitFor(() => expect(hooks.states[0]).toBe(false)); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

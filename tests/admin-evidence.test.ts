import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  currentEvidenceSettings: vi.fn(),
  getEvidenceAdminProduct: vi.fn(),
  redirect: vi.fn(),
  refreshProductEvidence: vi.fn(),
  revalidatePath: vi.fn(),
  saveEvidenceSettingsValue: vi.fn(),
  setAutomaticUpdateVisibility: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("not-found"); }),
  redirect: mocks.redirect,
}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.currentAdmin }));
vi.mock("@/lib/domain/evidence/refresh", () => ({
  currentEvidenceSettings: mocks.currentEvidenceSettings,
  refreshProductEvidence: mocks.refreshProductEvidence,
}));
vi.mock("@/lib/domain/evidence/admin", () => ({
  getEvidenceAdminProduct: mocks.getEvidenceAdminProduct,
  saveEvidenceSettingsValue: mocks.saveEvidenceSettingsValue,
  setAutomaticUpdateVisibility: mocks.setAutomaticUpdateVisibility,
}));

import AdminEvidencePage from "@/app/admin/evidence/page";
import AdminEvidenceProductPage from "@/app/admin/products/[slug]/page";
import {
  saveEvidenceSettings,
} from "@/app/admin/evidence/actions";
import {
  forceProductRefresh,
  hideAutomaticUpdate,
  restoreAutomaticUpdate,
} from "@/app/admin/products/[slug]/actions";

function evidenceForm(values: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    githubFactsHours: "24",
    releaseFeedHours: "6",
    linkCheckHours: "24",
    staleAfterIntervals: "2",
    maxRetries: "4",
    batchSize: "20",
    starDigestAbsolute: "25",
    starDigestPercent: "10",
    ...values,
  })) form.set(key, value);
  return form;
}

describe("evidence administrator authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
  });

  it("redirects logged-out pages before any evidence read", async () => {
    mocks.currentAdmin.mockResolvedValue(null);

    await expect(AdminEvidencePage()).rejects.toThrow("redirect:/admin/login");
    await expect(AdminEvidenceProductPage({
      params: Promise.resolve({ slug: "alpha" }),
    })).rejects.toThrow("redirect:/admin/login");

    expect(mocks.currentEvidenceSettings).not.toHaveBeenCalled();
    expect(mocks.getEvidenceAdminProduct).not.toHaveBeenCalled();
  });

  it("does not refresh, hide, restore, save, or revalidate when logged out", async () => {
    mocks.currentAdmin.mockResolvedValue(null);
    const updateForm = new FormData();
    updateForm.set("slug", "alpha");
    updateForm.set("updateId", "7");
    updateForm.set("reason", "객관적 근거가 아님");

    await forceProductRefresh(null, updateForm);
    await hideAutomaticUpdate(null, updateForm);
    await restoreAutomaticUpdate(null, updateForm);
    await saveEvidenceSettings(null, evidenceForm());

    expect(mocks.refreshProductEvidence).not.toHaveBeenCalled();
    expect(mocks.setAutomaticUpdateVisibility).not.toHaveBeenCalled();
    expect(mocks.saveEvidenceSettingsValue).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects non-finite settings and an empty hide reason before mutation", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "admin" });
    const invalidSettings = evidenceForm({ batchSize: "NaN" });
    const hide = new FormData();
    hide.set("slug", "alpha");
    hide.set("updateId", "7");
    hide.set("reason", "   ");

    await expect(saveEvidenceSettings(null, invalidSettings)).resolves.toMatchObject({
      issues: expect.arrayContaining([expect.stringContaining("배치")]),
    });
    await expect(hideAutomaticUpdate(null, hide)).resolves.toEqual({
      issues: ["숨김 사유를 입력해주세요."],
    });
    expect(mocks.saveEvidenceSettingsValue).not.toHaveBeenCalled();
    expect(mocks.setAutomaticUpdateVisibility).not.toHaveBeenCalled();
  });

  it("returns only a safe force-refresh count summary and revalidates both views", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "admin" });
    mocks.refreshProductEvidence.mockResolvedValue({
      sourcesAttempted: 4,
      sourcesFailed: 1,
      factsChanged: 2,
      eventsInserted: 3,
      mediaInserted: 1,
      complete: true,
      upstreamBody: "secret",
    });
    const form = new FormData();
    form.set("slug", "alpha");

    const state = await forceProductRefresh(null, form);

    expect(state).toEqual({
      ok: true,
      summary: { attempted: 4, failed: 1, facts: 2, updates: 3, media: 1, complete: true },
    });
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/products/alpha");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/p/alpha");
  });
});

describe("evidence administrator product page", () => {
  it("renders source freshness, conflicts, provenance, media, updates, and audit history", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "admin" });
    mocks.getEvidenceAdminProduct.mockResolvedValue({
      product: { slug: "alpha", name: "Alpha", url: "https://alpha.example", status: "verified" },
      profile: { makerLicense: { value: "MIT", spdxId: "MIT" } },
      conflicts: [{ field: "license", makerValue: "MIT", observedValue: "Apache-2.0" }],
      links: [{ id: 1, kind: "repository", url: "https://github.com/a/b", declarationSource: "maker", verificationState: "ok", relationshipState: "bidirectional" }],
      sources: [{ id: 1, kind: "repository", provider: "github", state: "stale", lastSuccessAt: new Date("2026-08-18T00:00:00Z"), lastFailureAt: null, nextAttemptAt: new Date("2026-08-20T00:00:00Z"), attempts: 2, lastErrorCode: "timeout", facts: { stars: 12, license: "Apache-2.0", relationship: "bidirectional" } }],
      media: [{ id: 1, sourceUrl: "https://cdn.example/a.png", version: 2, current: true, visible: true, missingAt: null }],
      declarations: [{ id: 1, sourceUrl: "https://cdn.example/a.png", revision: 3, position: 0 }],
      updates: [{ id: 7, sourceKind: "github_release", title: "v1.0", visible: true, makerEditedAt: null, makerDeletedAt: null }],
      agents: [{ id: 1, provider: "OpenAI", roles: ["implementation"], evidenceLevel: "maker_reported" }],
      skills: [{ id: 1, namespace: "openai", name: "review", evidenceLevel: "maker_reported" }],
      audits: [{ id: 1, actor: "maker:1", action: "maker.profile.save", reason: null, createdAt: new Date("2026-08-20T00:00:00Z") }],
    });

    const html = renderToStaticMarkup(await AdminEvidenceProductPage({
      params: Promise.resolve({ slug: "alpha" }),
    }));

    for (const text of ["Apache-2.0", "MIT", "bidirectional", "timeout", "v1.0", "OpenAI", "openai/review", "maker.profile.save"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("라이선스 충돌");
  });
});

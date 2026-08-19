import { describe, expect, it } from "vitest";
import {
  makerMediaSchema,
  makerProfileSchema,
  makerProvenanceSchema,
  normalizeTypedLink,
} from "@/lib/domain/evidence/contracts";
import {
  DEFAULT_EVIDENCE_SETTINGS,
  evidenceSettingsSchema,
} from "@/lib/domain/evidence/settings";

const validProfile = {
  pricingModel: "open_source" as const,
  lifecycle: "ga" as const,
  longDescriptionMarkdown: "## 소개\n\n[공식 문서](https://example.com/docs)",
  team: [{ name: "Maker", role: "Developer" }],
};

describe("maker evidence contracts", () => {
  it("bounds profile fields and keeps observed facts outside maker input", () => {
    expect(makerProfileSchema.safeParse(validProfile).success).toBe(true);
    expect(makerProfileSchema.safeParse({ ...validProfile, problem: "a".repeat(2_001) }).success).toBe(false);
    expect(makerProfileSchema.safeParse({
      ...validProfile,
      normalizedFacts: { stars: 10 },
    }).success).toBe(false);
    expect(makerProfileSchema.parse(validProfile)).toMatchObject({
      keyFeatures: [],
      useCases: [],
      platforms: [],
    });
  });

  it.each([
    "<div>raw html</div>",
    "<foo:bar>custom raw tag</foo:bar>",
    "<form action=\"https://evil.test\"><input onfocus=\"steal()\"></form>",
    "[실행](javascript:alert(1))",
    "[실행](<javascript:alert(1)>)",
    String.raw`[실행](javascript\:alert(1))`,
    "[실행](javas&#x63;ript:alert(1))",
    "[실행][unsafe]\n\n[unsafe]: javascript:alert(1)",
    "![추적](data:text/html;base64,AAAA)",
  ])("rejects unsafe Markdown: %s", (longDescriptionMarkdown) => {
    expect(makerProfileSchema.safeParse({ ...validProfile, longDescriptionMarkdown }).success).toBe(false);
  });

  it("normalizes official repository, store, and package links into stable keys", () => {
    expect(normalizeTypedLink("repository", "https://github.com/Owner/Repo.git")).toEqual({
      url: "https://github.com/owner/repo",
      normalizedKey: "owner/repo",
    });
    expect(normalizeTypedLink("app_store", "https://apps.apple.com/kr/app/example/id123456789")).toEqual({
      url: "https://apps.apple.com/app/id123456789",
      normalizedKey: "123456789",
    });
    expect(normalizeTypedLink(
      "play_store",
      "https://play.google.com/store/apps/details?id=com.Example.App&hl=ko",
    )).toEqual({
      url: "https://play.google.com/store/apps/details?id=com.example.app",
      normalizedKey: "com.example.app",
    });
    expect(normalizeTypedLink("npm", "https://www.npmjs.com/package/@Scope/Package")).toEqual({
      url: "https://www.npmjs.com/package/%40scope%2Fpackage",
      normalizedKey: "@scope/package",
    });
    expect(normalizeTypedLink("pypi", "https://pypi.org/project/My_Package/")?.normalizedKey).toBe("my-package");
    expect(normalizeTypedLink("crates", "https://crates.io/crates/Serde")?.normalizedKey).toBe("serde");
  });

  it.each([
    ["repository", "https://gitlab.com/owner/repo"],
    ["npm", "https://packages.example.com/package/demo"],
    ["documentation", "file:///etc/passwd"],
    ["support", "https://user:secret@example.com/help"],
    ["rss", "https://example.com/feed.xml#latest"],
    ["changelog", "http://127.0.0.1/changelog"],
    ["video", "http://localhost/video"],
    ["support", "http://[::ffff:127.0.0.1]/help"],
    ["support", "http://[ff02::1]/help"],
    ["support", "http://192.0.2.1/help"],
    ["support", "http://198.51.100.1/help"],
    ["support", "http://203.0.113.1/help"],
    ["support", "http://[100::1]/help"],
    ["support", "http://[2001:db8::1]/help"],
    ["support", "https://service.internal/help"],
    ["support", "https://127.0.0.1.nip.io/help"],
    ["documentation", `https://example.com/${"a".repeat(600)}`],
  ] as const)("rejects unsafe or unsupported %s links", (kind, url) => {
    expect(normalizeTypedLink(kind, url)).toBeNull();
  });

  it("caps maker media at eight safe external URLs", () => {
    const item = (index: number) => ({ url: `https://cdn.example.com/${index}.png`, altText: `화면 ${index}` });
    expect(makerMediaSchema.safeParse({ items: Array.from({ length: 8 }, (_, i) => item(i)) }).success).toBe(true);
    expect(makerMediaSchema.safeParse({ items: Array.from({ length: 9 }, (_, i) => item(i)) }).success).toBe(false);
    expect(makerMediaSchema.safeParse({ items: [{ url: "javascript:alert(1)", altText: "x" }] }).success).toBe(false);
  });

  it("allows only bounded disclosed provenance, Git object IDs, SHA-256 hashes, and known roles", () => {
    const agent = {
      provider: "OpenAI",
      client: "Codex",
      roles: ["planning", "implementation", "review"],
      evidenceLevel: "maker_reported" as const,
    };
    const skill = (index: number) => ({
      namespace: "openai",
      name: `skill-${index}`,
      hash: "a".repeat(64),
      evidenceLevel: "maker_reported" as const,
    });

    expect(makerProvenanceSchema.safeParse({ agents: [agent], skills: Array.from({ length: 12 }, (_, i) => skill(i)) }).success).toBe(true);
    expect(makerProvenanceSchema.safeParse({ agents: [agent], skills: Array.from({ length: 13 }, (_, i) => skill(i)) }).success).toBe(false);
    expect(makerProvenanceSchema.safeParse({ agents: [{ ...agent, roles: ["prompt_injection"] }], skills: [] }).success).toBe(false);
    expect(makerProvenanceSchema.safeParse({ agents: [], skills: [{ ...skill(1), hash: "not-sha256" }] }).success).toBe(false);
    expect(makerProvenanceSchema.safeParse({ agents: [{ ...agent, commitTo: "b".repeat(40) }], skills: [] }).success).toBe(true);
    expect(makerProvenanceSchema.safeParse({ agents: [{ ...agent, commitTo: "b".repeat(64) }], skills: [] }).success).toBe(true);
    expect(makerProvenanceSchema.safeParse({ agents: [{ ...agent, commitTo: "b".repeat(39) }], skills: [] }).success).toBe(false);
    expect(makerProvenanceSchema.safeParse({ agents: [], skills: [{ ...skill(1), commit: "C".repeat(40) }] }).success).toBe(false);
  });
});

describe("evidence settings", () => {
  it("applies safe defaults and rejects unsafe polling or batch values", () => {
    expect(evidenceSettingsSchema.parse({})).toEqual(DEFAULT_EVIDENCE_SETTINGS);
    expect(evidenceSettingsSchema.safeParse({ githubFactsHours: 5 }).success).toBe(false);
    expect(evidenceSettingsSchema.safeParse({ releaseFeedHours: 0 }).success).toBe(false);
    expect(evidenceSettingsSchema.safeParse({ staleAfterIntervals: 11 }).success).toBe(false);
    expect(evidenceSettingsSchema.safeParse({ maxRetries: 0 }).success).toBe(false);
    expect(evidenceSettingsSchema.safeParse({ batchSize: 101 }).success).toBe(false);
    expect(evidenceSettingsSchema.safeParse({ starDigestAbsolute: 4 }).success).toBe(false);
    expect(evidenceSettingsSchema.safeParse({ starDigestPercent: 101 }).success).toBe(false);
  });
});

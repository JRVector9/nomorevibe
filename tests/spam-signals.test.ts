import { describe, expect, it } from "vitest";
import { spamSignals } from "@/lib/crawl/spam-signals";
import { judgeStoredDocument, SPAM_RULE } from "@/lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

const now = new Date("2026-10-08T04:00:00Z");

/** 프로드 /p/codex-deepseek 원본을 줄인 것 — 캠페인의 전형 */
const campaign = {
  repo: "Promisedlandsubtraction2856/codex-deepseek",
  repoMeta: {
    id: 1380995344, full_name: "Promisedlandsubtraction2856/codex-deepseek", name: "codex-deepseek",
    owner: { login: "Promisedlandsubtraction2856", type: "User" },
    stargazers_count: 1, fork: false, archived: false, private: false, has_issues: false,
    homepage: "https://promisedlandsubtraction2856.github.io", pushed_at: "2026-10-08T01:48:16Z",
    description: "Run the real OpenAI Codex CLI on DeepSeek models without touching your ChatGPT login.",
    license: { key: "mit" },
  },
  productUrl: "https://promisedlandsubtraction2856.github.io",
  pageStatus: 200,
  pageMeta: {
    title: "codex-deepseek - Run Real OpenAI Codex on DeepSeek Models",
    description: "Isolated CODEX_HOME, easy installers for Windows/macOS/Linux.",
    textSample: "codex-deepseek - Run Real OpenAI Codex on DeepSeek ⬇️ Download Codex-DeepSeek Now 📦 What Is This? Visiting this link to download the application - it's that simple.",
    readmeSample: "🤖 codex-deepseek - Run Codex on DeepSeek Models\n\n (https://promisedlandsubtraction2856.github.io/)\n\n"
      + "🚀 Getting Started (Windows)\n\n1. **Download** – Visit this link to download the application: https://promisedlandsubtraction2856.github.io (https://promisedlandsubtraction2856.github.io/)",
  },
  fetchedAt: new Date("2026-10-08T03:00:00Z"),
};

const keys = (verdict: ReturnType<typeof spamSignals>) => verdict.signals.map((signal) => signal.key);

describe("spam signals", () => {
  it("flags the malware-distribution campaign with high confidence", () => {
    const verdict = spamSignals(campaign);
    expect(verdict).toMatchObject({ flagged: true, confidence: "high" });
    expect(keys(verdict)).toEqual(expect.arrayContaining([
      "templated_title", "download_lure", "pages_root_landing", "readme_download_to_landing",
      "low_stars", "issues_disabled", "random_account",
    ]));
  });

  it("flags the transformer-architecture shape from the landing page alone, before the README is fetched", () => {
    const verdict = spamSignals({
      repo: "Shadowy-lionhunter5498/transformer-architecture",
      repoMeta: { name: "transformer-architecture", owner: { login: "Shadowy-lionhunter5498" }, stargazers_count: 0, has_issues: false },
      productUrl: "https://shadowy-lionhunter5498.github.io",
      pageMeta: {
        title: "🚀 transformer-architecture - Your 3D AI Explorer for Windows",
        description: "Dive into the world of Transformers with stunning 3D visuals. Free download for Windows.",
        textSample: "⬇️ DOWNLOAD NOW - FREE Welcome to transformer-architecture",
      },
    });
    expect(verdict).toMatchObject({ flagged: true, confidence: "high" });
  });

  it("flags a templated README that hands out a zip from the repository itself", () => {
    const verdict = spamSignals({
      repo: "walidoot/shippage",
      repoMeta: { name: "shippage", owner: { login: "walidoot" }, stargazers_count: 0, has_issues: false },
      productUrl: "https://walidoot.github.io/shippage",
      pageMeta: { title: "personal portofolio website",
        readmeSample: "🚢 shippage - Ship landing pages fast from terminal\n\n (https://github.com/walidoot/shippage/raw/refs/heads/main/packages/shippage/Software_2.6.zip)" },
    });
    expect(verdict.flagged).toBe(true);
    expect(verdict.signals.find((signal) => signal.key === "download_lure")?.detail).toContain("/raw/");
  });

  it("never flags on weak signals alone — a GitHub-suggested username with a normal README", () => {
    const verdict = spamSignals({
      repo: "brave-otter1234/todo",
      repoMeta: { name: "todo", owner: { login: "brave-otter1234" }, stargazers_count: 0, has_issues: false },
      productUrl: "https://todo.example.app",
      pageMeta: { title: "Todo — a calm task list", readmeSample: "# Todo\n\nA calm task list built with Next.js." },
    });
    expect(keys(verdict)).toEqual(["low_stars", "issues_disabled", "random_account"]);
    expect(verdict.flagged).toBe(false);
  });

  it("does not flag a legit low-star repository whose site is the owner's github.io page", () => {
    const verdict = spamSignals({
      repo: "jane/lagebuch",
      repoMeta: { name: "lagebuch", owner: { login: "jane" }, stargazers_count: 0, has_issues: true },
      productUrl: "https://jane.github.io",
      pageMeta: { title: "Einsatzdokumentation für den ELW",
        readmeSample: "Lagebuch\n\nDownload the latest build at https://jane.github.io and open it in your browser." },
    });
    expect(keys(verdict)).toEqual(["pages_root_landing", "readme_download_to_landing", "low_stars"]);
    expect(verdict.flagged).toBe(false);
  });

  it("does not flag an emoji README heading on a normal deployed app", () => {
    const verdict = spamSignals({
      repo: "maker/dragonfly",
      repoMeta: { name: "dragonfly", owner: { login: "maker" }, stargazers_count: 0, has_issues: false },
      productUrl: "https://dragonfly-livid.vercel.app",
      pageMeta: { title: "Dragonfly – The REST API Client", readmeSample: "🚀 Dragonfly - CI/CD Setup\n\nDownload now for Windows. Click More info → Run anyway." },
    });
    expect(keys(verdict)).toEqual(["templated_title", "low_stars", "issues_disabled"]);
    expect(verdict.flagged).toBe(false);
  });

  it("does not count the owner's own pages repository as a foreign landing", () => {
    const verdict = spamSignals({
      repo: "jane/jane.github.io",
      repoMeta: { name: "jane.github.io", owner: { login: "jane" }, stargazers_count: 0, has_issues: false },
      productUrl: "https://jane.github.io",
      pageMeta: { title: "🌸 jane - my corner of the web" },
    });
    expect(keys(verdict)).not.toContain("pages_root_landing");
    expect(verdict.flagged).toBe(false);
  });

  it("needs two strong signals plus one weak one, or three strong ones", () => {
    const document = (stars: number) => ({
      repo: "acme/app",
      repoMeta: { name: "app", owner: { login: "acme" }, stargazers_count: stars, has_issues: true },
      productUrl: "https://acme.github.io",
      pageMeta: { title: "🚀 app - The fastest app" },
    });
    const twoStrongNoWeak = spamSignals(document(40));
    expect(keys(twoStrongNoWeak)).toEqual(["templated_title", "pages_root_landing"]);
    expect(twoStrongNoWeak).toMatchObject({ flagged: false, score: 6 });
    expect(spamSignals(document(1))).toMatchObject({ flagged: true, confidence: "medium", score: 7 });
  });
});

describe("spam gate in rule judging", () => {
  it("holds a candidate the rules would otherwise pass as human-only suspected_spam with its signals", () => {
    const verdict = judgeStoredDocument(campaign, DEFAULT_CRAWL_SETTINGS, now);
    expect(verdict).toMatchObject({ state: "needs_review", reason: "suspected_spam", cause: "suspected_spam" });
    expect(verdict.trace.at(-1)).toMatchObject({ rule: SPAM_RULE, passed: false });
    expect(verdict.signals.stoppedAt).toMatchObject({ rule: SPAM_RULE });
    expect(verdict.signals.suspectedSpam).toMatchObject({ confidence: "high", score: expect.any(Number) });
  });

  it("leaves rule rejections and ordinary documents as they were", () => {
    const rejected = judgeStoredDocument({ ...campaign, productUrl: null }, DEFAULT_CRAWL_SETTINGS, now);
    expect(rejected).toMatchObject({ state: "rejected", reason: "no_homepage" });
    const ordinary = { ...campaign, repo: "maker/codex-deepseek",
      repoMeta: { ...campaign.repoMeta, owner: { login: "maker", type: "User" }, has_issues: true },
      productUrl: "https://codex-deepseek.example.app",
      pageMeta: { title: "codex-deepseek", textSample: "Run Codex on DeepSeek models.", readmeSample: "# codex-deepseek\n\nRun Codex on DeepSeek models." } };
    expect(spamSignals(ordinary).flagged).toBe(false);
    expect(judgeStoredDocument(ordinary, DEFAULT_CRAWL_SETTINGS, now).reason).not.toBe("suspected_spam");
  });
});

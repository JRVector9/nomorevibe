import { describe, expect, it, vi } from "vitest";
import { judge, judgeStoredDocument, stubTextHit, stubTextHits, STUB_TEXT_MAX_CHARS, type RepoFacts, type PageFacts } from "@/lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { reviewPolicyHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";

// 1차 AI 직전 재확인(prepareAgentReview)은 이미 등록된 URL 만 DB 에서 본다 — 그것만 비워 둔다
vi.mock("@/lib/domain/products/repository", () => ({ findRepositoryProduct: vi.fn(async () => null) }));

/**
 * 빈 화면 본문 규칙(2026-10-29, rules.ts stubTextHit · judge.stubTextRules).
 * 근거: 10/22~10/29 1차 AI 웹 심사 11,486건에서 다섯 규칙에 걸린 것의 84.5%를 AI 도 거부했다.
 */
const NOW = new Date("2026-10-29T00:00:00Z");
const repo = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  repo: "someone/acme-tool", stars: 3, isFork: false, ownerType: "User",
  pushedAt: new Date("2026-10-25T00:00:00Z"), archived: false, description: "배포한 서비스입니다", ...over,
});
const page = (textSample: string | null, over: Partial<PageFacts> = {}): PageFacts =>
  ({ productUrl: "https://acme-tool.vercel.app", status: 200, title: "Acme Planner", textSample, ...over });
const withMode = (stubTextRules: CrawlSettings["judge"]["stubTextRules"]): CrawlSettings =>
  ({ ...DEFAULT_CRAWL_SETTINGS, judge: { ...DEFAULT_CRAWL_SETTINGS.judge, stubTextRules } });
const hitOf = (textSample: string | null, over: Partial<PageFacts> = {}) =>
  stubTextHit({ repo: "someone/acme-tool", ...page(textSample, over) })?.id ?? null;
/** 낱말이 아닌 글자로 길이만 채운다 — 어느 규칙의 문구도, 제목 밖 낱말도 늘지 않는다 */
const padTo = (text: string, length: number) => text + " " + "·".repeat(length - [...text].length - 1);

describe("1. 제목만 있는 페이지", () => {
  it("본문이 제목·호스트·저장소 이름 낱말뿐이면 걸린다 — NFKC·대소문자를 맞춰 본다", () => {
    expect(hitOf("Acme Planner")).toBe("title_only");
    expect(hitOf("ACME — Planner | acme-tool.vercel.app")).toBe("title_only");
    // 전각 글자는 NFKC 로 반각이 된다
    expect(hitOf("ＡＣＭＥ ＰＬＡＮＮＥＲ")).toBe("title_only");
    // 저장소 이름(acme-tool)의 낱말
    expect(hitOf("Acme tool")).toBe("title_only");
  });

  it("제목 밖 낱말이 하나라도 있으면 통과한다", () => {
    expect(hitOf("Acme Planner Plan")).toBeNull();
    expect(hitOf("Acme Planner 2026")).toBeNull();
  });

  it("본문이 없으면(읽었는데 글이 없음) 빈 본문으로 본다", () => {
    expect(hitOf(null)).toBe("title_only");
    expect(hitOf("")).toBe("title_only");
  });

  it("300자까지만 본다 — 301자는 제목 낱말뿐이어도 통과한다", () => {
    expect(STUB_TEXT_MAX_CHARS.title_only).toBe(300);
    expect(hitOf(padTo("Acme Planner", 300))).toBe("title_only");
    expect(hitOf(padTo("Acme Planner", 301))).toBeNull();
  });
});

describe("2. 로딩 화면만", () => {
  it("본문이 Loading… 뿐이면 걸린다", () => {
    for (const text of ["Loading...", "Loading…", "loading", "Acme Planner Loading...", "⏳ Loading ⏳"]) expect(hitOf(text), text).toBe("loading_only");
  });

  it("60자를 넘거나 로딩 말고 다른 말이 있으면 로딩 규칙은 아니다", () => {
    expect(hitOf(padTo("Loading...", 60))).toBe("loading_only");
    expect(hitOf(padTo("Loading...", 61))).not.toBe("loading_only");
    expect(hitOf("Loading your saved boards")).toBeNull();
    // 낱말 안의 loading 은 아니다
    expect(stubTextHits({ repo: "a/b", productUrl: "https://b.app", title: "B", textSample: "Preloading..." }).map((hit) => hit.id))
      .not.toContain("loading_only");
  });
});

describe("3. JavaScript 껍데기", () => {
  it("300자 이하 본문에 JavaScript 를 켜라는 안내가 있으면 걸린다", () => {
    expect(hitOf("Acme Planner You need to enable JavaScript to run this app.")).toBe("javascript_shell");
    expect(hitOf("JavaScript is required")).toBe("javascript_shell");
    expect(hitOf(padTo("Please enable JavaScript.", 300))).toBe("javascript_shell");
  });

  it("300자를 넘으면 통과한다 — noscript 안내가 붙은 진짜 페이지다", () => {
    expect(hitOf(padTo("Please enable JavaScript. Plan your week with boards", 301))).toBeNull();
  });
});

describe("4. 로그인 화면만", () => {
  it("150자 이하 본문에 로그인 문구가 있고 가입 문구가 없으면 걸린다", () => {
    for (const text of ["Sign in Email Password", "Log in to continue", "로그인 이메일 비밀번호", "登录 账号", "ログイン メール"]) {
      expect(hitOf(text), text).toBe("login_only");
    }
  });

  it("가입 문구가 있으면 통과한다", () => {
    for (const text of ["Sign in Email Password Sign up", "Log in or create an account", "로그인 회원가입", "登录 注册", "Login Get started free"]) {
      expect(hitOf(text), text).toBeNull();
    }
  });

  it("150자를 넘으면 통과한다", () => {
    expect(hitOf(padTo("Sign in Email Password", 150))).toBe("login_only");
    expect(hitOf(padTo("Sign in Email Password", 151))).toBeNull();
  });
});

describe("5. 출시 예정·대기 명단", () => {
  it("400자 이하 본문에 출시 예정·대기 명단 문구가 있으면 걸린다", () => {
    for (const text of ["Acme is coming soon. Join the waitlist", "Launching soon — notify me", "Be the first to know",
      "Join our wait list", "곧 출시됩니다", "출시 예정 대기자 등록"]) {
      expect(hitOf(text), text).toBe("coming_soon");
    }
  });

  it("길이 조건이 필수다 — 401자면 통과한다(진짜 제품 랜딩에도 대기 명단 버튼이 흔하다)", () => {
    expect(hitOf(padTo("Plan boards together. Join the waitlist", 400))).toBe("coming_soon");
    expect(hitOf(padTo("Plan boards together. Join the waitlist", 401))).toBeNull();
  });

  it("돌아가는 앱의 빈 목록 안내는 아니다", () => {
    expect(hitOf("Chirper Log in Register No chirps yet. Be the first to chirp!")).toBeNull();
  });
});

describe("모드 — judge.stubTextRules", () => {
  const titleOnly = page("Acme Planner");

  it("shadow 는 상태·사유·발자국을 바꾸지 않고 signals 에 걸렸을 규칙만 남긴다", () => {
    const off = judge(repo(), titleOnly, withMode("off"), NOW);
    const shadow = judge(repo(), titleOnly, withMode("shadow"), NOW);
    expect(off).toMatchObject({ state: "approved", reason: "passed" });
    expect(off.signals).not.toHaveProperty("stubTextShadow");
    expect(shadow.signals.stubTextShadow).toEqual({ id: "title_only", rule: "제목만 있는 페이지 아님",
      detail: "본문 12자 ≤ 300자 — 제목·호스트·저장소 이름에 없는 낱말 0개" });
    const { stubTextShadow: _shadow, ...rest } = shadow.signals;
    void _shadow;
    expect({ ...shadow, signals: rest }).toEqual(off);
  });

  it("shadow 는 보류도 그대로 둔다 — 걸렸을 규칙만 더한다", () => {
    const held = page("Acme Planner", { productUrl: "https://someone.github.io/acme-tool" });
    const off = judge(repo(), held, withMode("off"), NOW);
    const shadow = judge(repo(), held, withMode("shadow"), NOW);
    expect(off).toMatchObject({ state: "needs_review", cause: "host_excluded_subpath" });
    expect(shadow).toMatchObject({ state: "needs_review", cause: "host_excluded_subpath", signals: { stubTextShadow: { id: "title_only" } } });
    expect(shadow.trace).toEqual(off.trace);
  });

  it("enforce 는 not_a_product 로 거부하고 멈춘 규칙을 남긴다", () => {
    const v = judge(repo(), page("Sign in Email Password"), withMode("enforce"), NOW);
    expect(v).toMatchObject({ state: "rejected", reason: "not_a_product",
      signals: { stoppedAt: { rule: "로그인 화면만 아님" } } });
    expect(v.trace.at(-1)).toMatchObject({ rule: "로그인 화면만 아님", passed: false });
    expect(v.signals).not.toHaveProperty("stubTextShadow");
  });

  it("enforce 의 거부는 미뤄 둔 보류(문서 생성기)보다 이긴다", () => {
    const docs = page("Acme Planner", { generator: "docusaurus" });
    expect(judge(repo(), docs, withMode("off"), NOW)).toMatchObject({ state: "needs_review", cause: "docs_generator" });
    expect(judge(repo(), docs, withMode("enforce"), NOW)).toMatchObject({ state: "rejected", reason: "not_a_product" });
  });

  it("off 는 아무것도 남기지 않는다", () => {
    for (const text of ["Acme Planner", "Loading...", "Sign in Password", "Coming soon", "Please enable JavaScript"]) {
      const v = judge(repo(), page(text), withMode("off"), NOW);
      expect(v.state, text).toBe("approved");
      expect(v.signals, text).not.toHaveProperty("stubTextShadow");
    }
  });

  it("응답 코드를 확인하기 전·오류 응답·설치형 경로에는 걸지 않는다", () => {
    expect(judge(repo(), page(null, { status: null }), withMode("enforce"), NOW)).toMatchObject({ state: "needs_review", cause: "page_status_unknown" });
    expect(judge(repo(), page(null, { status: 500 }), withMode("enforce"), NOW)).toMatchObject({ state: "rejected", reason: "unreachable" });
    const installable = judge(repo({ stars: 900 }), page("Acme Planner"), withMode("enforce"), NOW);
    expect(installable.signals.accessMode).toBe("installable");
    expect(installable.signals).not.toHaveProperty("stubTextShadow");
  });

  it("글이 충분한 진짜 제품 페이지는 어느 모드에서도 걸리지 않는다", () => {
    const real = page("Acme Planner Plan your week with shared boards, reminders and a calendar view. Sign in Sign up Pricing");
    for (const mode of ["shadow", "enforce"] as const) {
      const v = judge(repo(), real, withMode(mode), NOW);
      expect(v.state, mode).toBe("approved");
      expect(v.signals, mode).not.toHaveProperty("stubTextShadow");
    }
  });
});

describe("설정 — 새 키의 기본값과 얕은 병합", () => {
  /** 운영 judge 처럼 thirdPartyHosts 21개를 저장해 두었고 새 키는 없는 행 */
  const OLD_HOSTS = DEFAULT_CRAWL_SETTINGS.judge.thirdPartyHosts.slice(0, 21);
  const storedJudge = (() => {
    const judgeValues: Record<string, unknown> = { ...DEFAULT_CRAWL_SETTINGS.judge, thirdPartyHosts: OLD_HOSTS };
    delete judgeValues.stubTextRules;
    return judgeValues;
  })();

  it("코드 기본값은 shadow 다", () => {
    expect(DEFAULT_CRAWL_SETTINGS.judge.stubTextRules).toBe("shadow");
  });

  it("운영 저장 judge 에 칸이 없어도 기본값 shadow 가 적용된다 — 저장된 목록은 그대로 이긴다", () => {
    const settings = mergeWithDefaults({ ...DEFAULT_CRAWL_SETTINGS, judge: storedJudge });
    expect(settings.judge.stubTextRules).toBe("shadow");
    expect(settings.judge.thirdPartyHosts).toEqual(OLD_HOSTS);
    expect(settings.judge.thirdPartyHosts).not.toContain("zenodo.org");
    // 스키마만 거쳐도(예: 저장 검증) 같은 기본값이다
    expect(crawlSettingsSchema.parse({ ...DEFAULT_CRAWL_SETTINGS, judge: storedJudge }).judge.stubTextRules).toBe("shadow");
    // 그 설정으로 판정하면 shadow 로 남는다
    const v = judge(repo(), page("Acme Planner"), settings, NOW);
    expect(v).toMatchObject({ state: "approved", signals: { stubTextShadow: { id: "title_only" } } });
  });

  it("저장된 값이 있으면 그것을 따르고, 모르는 값은 받지 않는다", () => {
    expect(mergeWithDefaults({ judge: { ...storedJudge, stubTextRules: "enforce" } }).judge.stubTextRules).toBe("enforce");
    expect(mergeWithDefaults({ judge: { ...storedJudge, stubTextRules: "off" } }).judge.stubTextRules).toBe("off");
    expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, judge: { ...storedJudge, stubTextRules: "on" } }).success).toBe(false);
  });

  it("shadow·off 는 심사 정책 해시를 바꾸지 않는다 — 배포만으로 진행 중인 심사가 낡지 않는다", () => {
    const legacy = { ...DEFAULT_CRAWL_SETTINGS, judge: storedJudge } as unknown as CrawlSettings;
    const legacyHash = reviewPolicyHash(legacy);
    const at = (mode: CrawlSettings["judge"]["stubTextRules"]) => reviewPolicyHash({ ...legacy, judge: { ...legacy.judge, stubTextRules: mode } });
    expect(at("shadow")).toBe(legacyHash);
    expect(at("off")).toBe(legacyHash);
    expect(at("enforce")).not.toBe(legacyHash);
  });
});

describe("6. 남의 사이트 — 코드 기본값에 더한 8곳", () => {
  const ADDED = ["zenodo.org", "arxiv.org", "pkg.go.dev", "codeberg.org", "stackblitz.com", "codefloe.com", "zenn.dev", "xdaforums.com"];

  it("8곳이 모두 들어 있고 huggingface.co 는 없다", () => {
    expect(DEFAULT_CRAWL_SETTINGS.judge.thirdPartyHosts).toEqual(expect.arrayContaining(ADDED));
    expect(DEFAULT_CRAWL_SETTINGS.judge.thirdPartyHosts).not.toContain("huggingface.co");
    // 앞의 21곳은 그대로다
    expect(DEFAULT_CRAWL_SETTINGS.judge.thirdPartyHosts.slice(0, 21)).toEqual(expect.arrayContaining(["workshops.aws", "substack.com"]));
    expect(DEFAULT_CRAWL_SETTINGS.judge.thirdPartyHosts).toHaveLength(29);
  });

  it("코드 기본값으로 판정하면 8곳은 남의 사이트로 거부되고 huggingface.co 는 그 규칙을 지난다", () => {
    for (const url of ["https://zenodo.org/records/123", "https://arxiv.org/abs/2601.00001", "https://pkg.go.dev/github.com/a/b",
      "https://codeberg.org/a/b", "https://stackblitz.com/edit/x", "https://codefloe.com/a/b", "https://zenn.dev/a/articles/b",
      "https://xdaforums.com/t/x.1/"]) {
      const v = judge(repo(), page("Long enough body text for this project page", { productUrl: url }), DEFAULT_CRAWL_SETTINGS, NOW);
      expect(v, url).toMatchObject({ state: "rejected", reason: "not_a_product", signals: { stoppedAt: { rule: "남의 사이트 아님" } } });
    }
    const hf = judge(repo(), page("Long enough body text for this project page", { productUrl: "https://huggingface.co/spaces/a/b" }),
      DEFAULT_CRAWL_SETTINGS, NOW);
    expect(hf.trace.find((step) => step.rule === "남의 사이트 아님")?.passed).toBe(true);
  });
});

describe("1차 AI 직전 규칙 재확인 — 같은 모드를 쓴다", () => {
  const now = new Date();
  const document = {
    id: 1, repo: "someone/acme-tool", productUrl: "https://acme-tool.vercel.app", pageStatus: 200, fetchedAt: now,
    repoMeta: { stargazers_count: 3, pushed_at: now.toISOString(), owner: { type: "User" }, description: "A planner" },
    pageMeta: { title: "Acme Planner", textSample: "Acme Planner" },
  } as unknown as CrawlDocument;
  const candidate = { id: 1, repo: document.repo, productUrl: document.productUrl, state: "approved", reason: "passed" } as unknown as CrawlCandidate;
  const input = { snapshot: { relationship: "unknown", scanState: "pending", evidence: [], evidenceSummary: { eligible: true } } } as unknown as ReviewInput;
  const reviewer = { provider: "abcllm", model: "test-model" };
  const prepare = async (mode: CrawlSettings["judge"]["stubTextRules"]) => {
    const { prepareAgentReview } = await import("@/lib/crawl/agent-review-preparation");
    return prepareAgentReview({ candidate, document, settings: withMode(mode), input }, reviewer);
  };

  it("enforce 면 모델에 보내지 않고 규칙 거부(not_a_product)로 끝낸다", async () => {
    const prepared = await prepare("enforce");
    expect(prepared).toMatchObject({ provider: "rules", hardReason: "not_a_product", outcome: { decision: "reject" } });
  });

  it("shadow 면 모델에 그대로 보내고 재확인 판정에 걸렸을 규칙이 남는다", async () => {
    const prepared = await prepare("shadow");
    expect(prepared).toMatchObject({ provider: "abcllm", hardReason: null, outcome: undefined });
    expect(prepared.verdict.signals.stubTextShadow).toMatchObject({ id: "title_only" });
  });

  it("off 면 모델에 보내고 아무것도 남기지 않는다", async () => {
    const prepared = await prepare("off");
    expect(prepared).toMatchObject({ provider: "abcllm", hardReason: null });
    expect(prepared.verdict.signals).not.toHaveProperty("stubTextShadow");
  });

  it("저장된 원본 판정(judgeStoredDocument)도 같은 모드를 따른다", () => {
    expect(judgeStoredDocument(document, withMode("enforce"), now)).toMatchObject({ state: "rejected", reason: "not_a_product" });
    expect(judgeStoredDocument(document, withMode("shadow"), now)).toMatchObject({ state: "approved", signals: { stubTextShadow: { id: "title_only" } } });
  });
});

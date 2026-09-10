/**
 * AI 소식 공식 출처.
 *
 * 회사가 직접 내는 것만 담는다 — 남이 긁어 만든 미러(RSSHub 등)는 끊기면 알 길이 없고,
 * 무엇을 싣는지도 우리가 정할 수 없다. 주소는 모두 2026-09-11 실제로 열어 확인했다.
 *
 * 공식 RSS가 없는 곳은 사이트맵에 새로 생긴 주소를 새 글로 본다(Anthropic·DeepSeek).
 * 사이트맵의 lastmod 는 쓰지 않는다 — Anthropic은 옛 글까지 모두 같은 날짜로 찍는다.
 *
 * 닿지 못해 뺀 곳(실측):
 * - xAI 소식(x.ai/news): Cloudflare 봇 차단. 우회하지 않는다. Grok Build CLI 배포(npm)만 받는다.
 * - Kimi 블로그: RSS도 사이트맵 항목도 없다. Kimi CLI·Kimi Code 릴리스만 받는다.
 * - Meta AI 블로그: 서버 요청에 400. Qwen 블로그: 2025-09 이후 갱신이 없다.
 *
 * section 이 news 인 것만 홈 카드에 오른다. 코딩 도구 릴리스는 하루에도 몇 번씩 나와
 * 섞으면 카드가 릴리스 번호로 채워진다 — 모아 두고 관리자와 소식 페이지에서 본다.
 */
export type NewsSourceKind = "feed" | "sitemap" | "npm";
export type NewsSection = "news" | "release";
export type NewsTone = "dark" | "mint" | "peach";

export type NewsSource = {
  key: string;
  /** 화면에 보이는 출처 이름 */
  name: string;
  /** 같은 회사의 출처를 묶는다 — 홈 카드 머리글자와 필터가 이것을 쓴다 */
  vendor: string;
  kind: NewsSourceKind;
  url: string;
  section: NewsSection;
  /** 홈 카드의 종류 표시 */
  label: string;
  tone: NewsTone;
  /** sitemap: 이 경로 아래 주소만 글로 본다 */
  paths?: readonly string[];
  /** npm: 패키지 이름 */
  packageName?: string;
  /**
   * release: 이 도구의 정식 릴리스 태그. 첫 괄호가 버전이다. 없으면 v1.2.3 / 1.2.3 만.
   * 한 저장소가 여러 제품을 낸다 — Codex 는 rust-v(CLI)·python-v(SDK)·voice-cygwin,
   * Qwen Code 는 sdk-typescript-v·desktop-v 를 섞는다. 규칙에 맞지 않는 태그는 받지 않는다.
   */
  tagPattern?: RegExp;
};

export const DEFAULT_RELEASE_TAG = /^v?(\d+\.\d+\.\d+)$/;

const github = (repo: string) => `https://github.com/${repo}/releases.atom`;

export const NEWS_SOURCES: readonly NewsSource[] = [
  { key: "openai", name: "OpenAI", vendor: "OpenAI", kind: "feed", url: "https://openai.com/news/rss.xml", section: "news", label: "공식 발표", tone: "mint" },
  {
    key: "anthropic", name: "Anthropic", vendor: "Anthropic", kind: "sitemap", url: "https://www.anthropic.com/sitemap.xml",
    section: "news", label: "공식 발표", tone: "peach", paths: ["/news/", "/engineering/"],
  },
  { key: "google-deepmind", name: "Google DeepMind", vendor: "Google", kind: "feed", url: "https://deepmind.google/blog/rss.xml", section: "news", label: "연구·모델", tone: "dark" },
  { key: "google-gemini", name: "Gemini", vendor: "Google", kind: "feed", url: "https://blog.google/products-and-platforms/products/gemini/rss/", section: "news", label: "제품 소식", tone: "dark" },
  { key: "google-developers", name: "Google for Developers", vendor: "Google", kind: "feed", url: "https://developers.googleblog.com/rss/", section: "news", label: "개발자 소식", tone: "dark" },
  { key: "mistral", name: "Mistral AI", vendor: "Mistral", kind: "feed", url: "https://mistral.ai/news/rss", section: "news", label: "공식 발표", tone: "peach" },
  { key: "zai", name: "Z.ai (GLM)", vendor: "Z.ai", kind: "feed", url: "https://docs.z.ai/release-notes/new-released/rss.xml", section: "news", label: "모델 출시", tone: "mint" },
  {
    key: "deepseek", name: "DeepSeek", vendor: "DeepSeek", kind: "sitemap", url: "https://api-docs.deepseek.com/sitemap.xml",
    section: "news", label: "모델 출시", tone: "dark", paths: ["/news/"],
  },
  { key: "cursor", name: "Cursor", vendor: "Cursor", kind: "feed", url: "https://cursor.com/changelog/rss.xml", section: "news", label: "도구 업데이트", tone: "dark" },
  { key: "github-copilot", name: "GitHub Copilot", vendor: "GitHub", kind: "feed", url: "https://github.blog/changelog/label/copilot/feed/", section: "news", label: "도구 업데이트", tone: "dark" },

  { key: "claude-code", name: "Claude Code", vendor: "Anthropic", kind: "feed", url: github("anthropics/claude-code"), section: "release", label: "CLI 릴리스", tone: "peach" },
  { key: "codex-cli", name: "Codex CLI", vendor: "OpenAI", kind: "feed", url: github("openai/codex"), section: "release", label: "CLI 릴리스", tone: "mint", tagPattern: /^rust-v(\d+\.\d+\.\d+)$/ },
  { key: "gemini-cli", name: "Gemini CLI", vendor: "Google", kind: "feed", url: github("google-gemini/gemini-cli"), section: "release", label: "CLI 릴리스", tone: "dark" },
  { key: "grok-build", name: "Grok Build", vendor: "xAI", kind: "npm", url: "https://registry.npmjs.org/@xai-official/grok", section: "release", label: "CLI 릴리스", tone: "dark", packageName: "@xai-official/grok" },
  { key: "kimi-cli", name: "Kimi CLI", vendor: "Moonshot", kind: "feed", url: github("MoonshotAI/kimi-cli"), section: "release", label: "CLI 릴리스", tone: "mint" },
  { key: "kimi-code", name: "Kimi Code", vendor: "Moonshot", kind: "feed", url: github("MoonshotAI/kimi-code"), section: "release", label: "CLI 릴리스", tone: "mint", tagPattern: /^@moonshot-ai\/kimi-code@(\d+\.\d+\.\d+)$/ },
  { key: "qwen-code", name: "Qwen Code", vendor: "Qwen", kind: "feed", url: github("QwenLM/qwen-code"), section: "release", label: "CLI 릴리스", tone: "peach" },
  { key: "mistral-vibe", name: "Mistral Vibe", vendor: "Mistral", kind: "feed", url: github("mistralai/mistral-vibe"), section: "release", label: "CLI 릴리스", tone: "peach" },
];

export const NEWS_SOURCE_KEYS = NEWS_SOURCES.map((source) => source.key);
export const HOME_NEWS_SOURCE_KEYS = NEWS_SOURCES.filter((source) => source.section === "news").map((source) => source.key);

export function newsSource(key: string): NewsSource | undefined {
  return NEWS_SOURCES.find((source) => source.key === key);
}

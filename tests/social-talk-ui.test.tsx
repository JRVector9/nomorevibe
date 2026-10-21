import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { createTranslator } from "@/lib/i18n/messages";
import { browse } from "@/messages/ko/browse";
import { common } from "@/messages/ko/common";
import { detail } from "@/messages/ko/detail";
import { labels } from "@/messages/ko/labels";
import type { ProductTalk, TalkPost, TalkStarGrowth } from "@/lib/social/talk";
import type { LocalizedTalkEntry } from "@/components/social/TalkHero";
import { TALK_THRESHOLD } from "@/lib/social/talk-score";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ pathname: "/", admin: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));

const { TalkBand } = await import("@/components/social/TalkBand");
const { TalkHero } = await import("@/components/social/TalkHero");
const { SiteHeader } = await import("@/components/home/SiteHeader");
const { MobileNav } = await import("@/components/home/MobileNav");
const { talkPublicEnabled, talkVisibility } = await import("@/lib/social/flags");

const NOW = new Date("2026-10-18T06:00:00Z");
const post = (id: number, extra: Partial<TalkPost> = {}): TalkPost => ({
  id, source: "hn", externalId: String(5000 + id), kind: "link", title: "Doory – Open-Source Canva", linkTarget: "repo",
  postedAt: new Date("2026-10-12T00:48:00Z"), points: 230, comments: 80, frontPage: true, ...extra,
});
const growth: TalkStarGrowth = {
  delta: 792, basis: "observation", from: 771, fromAt: new Date("2026-10-13T00:00:00Z"), to: 1563, toAt: new Date("2026-10-18T00:00:00Z"),
  points: [{ stars: 771, at: new Date("2026-10-13T00:00:00Z") }, { stars: 1200, at: new Date("2026-10-15T00:00:00Z") }, { stars: 1563, at: new Date("2026-10-18T00:00:00Z") }],
};
const entry = (rank: number, slug: string, extra: Partial<LocalizedTalkEntry> = {}): LocalizedTalkEntry => ({
  rank, repositoryKey: `acme/${slug}`, score: 3, sources: ["hn"], byMaker: false, starGrowth: null, homeDecision: null, posts: [post(rank)],
  product: { id: rank, slug, name: slug, translationName: slug, tagline: `${slug} tagline`, taglineKo: null, taglineSource: "maker", category: "Design",
    repoUrl: `https://github.com/acme/${slug}`, ogImage: null, stars: 1563, aiLevel: 1, accessMode: "website" },
  ...extra,
});

beforeEach(() => {
  mocks.pathname = "/";
  mocks.admin.mockReset().mockResolvedValue(null);
  delete process.env.SNS_TALK_PUBLIC_ENABLED;
});

describe("화면 스위치", () => {
  it("켜기 전에는 관리자에게만 미리보기로 보인다", async () => {
    expect(talkPublicEnabled()).toBe(false);
    expect(await talkVisibility()).toEqual({ visible: false, preview: false });
    mocks.admin.mockResolvedValue({ login: "jr", exp: 0, method: "local" });
    expect(await talkVisibility()).toEqual({ visible: true, preview: true });
    process.env.SNS_TALK_PUBLIC_ENABLED = "true";
    expect(await talkVisibility()).toEqual({ visible: true, preview: false });
  });

  it("헤더 맨 앞과 모바일 탭은 켰을 때만 「SNS 화제」를 둔다", () => {
    const render = (talkEnabled: boolean) => renderToStaticMarkup(<I18nProvider locale="ko" dictionaries={{ common }} now={NOW.toISOString()}>
      <SiteHeader talkEnabled={talkEnabled} /><MobileNav talkEnabled={talkEnabled} /></I18nProvider>);
    expect(render(false)).not.toContain('href="/talk"');
    const on = render(true);
    expect(on.match(/href="\/talk"/g)).toHaveLength(2);
    // 메뉴 첫 링크가 화제다(C안)
    expect(on.slice(on.indexOf('class="navigation"')).match(/<a[^>]*href="([^"]+)"/)?.[1]).toBe("/talk");
    mocks.pathname = "/talk";
    expect(render(true)).toContain('class="active" href="/talk"');
  });
});

describe("상세 화제 띠", () => {
  const t = createTranslator("detail", detail);
  const talk: ProductTalk = { posts: [post(1), post(2, { linkTarget: "issue", title: "Crash on export", points: 40, comments: 20, kind: "link" })],
    qualifies: true, rank: 2, sources: ["hn"], starGrowth: growth, checkedAt: new Date("2026-10-18T05:30:00Z") };

  it("순위·가장 큰 글·원문 토론·이슈 토론·글 뒤 스타를 그린다", () => {
    const html = renderToStaticMarkup(<TalkBand talk={talk} t={t} locale="ko" now={NOW} preview={false} />);
    expect(html).toContain("SNS에서 화제 · 지금 2위 · 출처 1곳");
    expect(html).toContain("Hacker News 230점 · 댓글 80");
    expect(html).toContain('href="https://news.ycombinator.com/item?id=5001"');
    expect(html).toContain("이슈 토론 ↗");
    expect(html).toContain("+792");
    expect(html).toContain("GitHub 스타 · 첫 관측 뒤");
    expect(html).toContain('rel="noopener"');
  });

  it("자격 글이 없으면 그리지 않는다", () => {
    expect(renderToStaticMarkup(<TalkBand talk={{ ...talk, qualifies: false }} t={t} locale="ko" now={NOW} preview={false} />)).toBe("");
  });

  it("Bluesky 게시물은 본문 없이 반응 수와 원문 링크만 그린다", () => {
    const bsky = post(3, { source: "bluesky", externalId: "did:plc:ltjj43huonogytm4szn5hzkx/3mygbhpmh762y", title: "", points: 12, comments: 3, frontPage: false });
    const html = renderToStaticMarkup(<TalkBand talk={{ ...talk, posts: [bsky], sources: ["bluesky"] }} t={t} locale="ko" now={NOW} preview={false} />);
    expect(html).toContain("Bluesky 반응 12 · 답글 3");
    expect(html).toContain('class="talk-src talk-src-bluesky"><b>Bsky</b> 반응 12 · 답글 3');
    expect(html).toContain("Bluesky 게시물");
    expect(html).toContain('href="https://bsky.app/profile/did:plc:ltjj43huonogytm4szn5hzkx/post/3mygbhpmh762y"');
    expect(html).toContain("Bluesky에서 보기 ↗");
    expect(html).not.toContain("남이 소개한 글");
  });
});

describe("홈 대표 구획", () => {
  const t = createTranslator("browse", browse);
  const render = (props: Partial<Parameters<typeof TalkHero>[0]>) => renderToStaticMarkup(
    <I18nProvider locale="ko" dictionaries={{ labels }} now={NOW.toISOString()}>
      <TalkHero lead={null} rest={[]} sources={["hn"]} t={t} locale="ko" preview={false} {...props} />
    </I18nProvider>);

  it("허용된 1위는 크게, 나머지는 목록으로", () => {
    const html = render({ lead: entry(1, "doory", { starGrowth: growth }), rest: [entry(2, "konnect"), entry(3, "spotatui")] });
    expect(html).toContain("지금 SNS에서 화제");
    expect(html).toContain("Hacker News에서 이야기된 AI로 만든 프로젝트");
    expect(html).toContain('id="talk-lead-title"><a href="/p/doory">doory</a>');
    expect(html).toContain("첫 관측 뒤 GitHub 스타");
    expect(html.match(/class="talk-row"/g)).toHaveLength(2);
    expect(html).toContain('href="/talk"');
  });

  it("Bluesky 출처는 이름·칩을 달고 반응 수로 적는다", () => {
    const bsky = post(9, { source: "bluesky", externalId: "did:plc:ltjj43huonogytm4szn5hzkx/3mygbhpmh762y", title: "", points: 7, comments: 1 });
    const html = render({ lead: entry(1, "doory", { posts: [post(1), bsky], sources: ["hn", "bluesky"] }), sources: ["hn", "bluesky"] });
    expect(html).toContain("Hacker News·Bluesky에서 이야기된 AI로 만든 프로젝트");
    expect(html).toContain('class="talk-src talk-src-bluesky"><b>Bsky</b>반응 7 · 답글 1');
    // 집계 기준 문구는 상수와 같은 값을 말한다
    expect(browse["talk.methodThreshold"]).toContain(`Bluesky 반응(좋아요 + 재게시×2) ${TALK_THRESHOLD.bluesky.points} 이상`);
  });

  it("1위 허용 전이면 목록만, 아무것도 없으면 조용하다고 말한다", () => {
    expect(render({ rest: [entry(1, "doory")] })).not.toContain("talk-lead");
    expect(render({})).toContain("지금은 화제가 된 프로젝트가 없습니다.");
    expect(render({ preview: true })).toContain("미리보기");
  });

  it("'예시' 카드는 표시를 달고 제품·원문 링크 없이 그린다 — 실제 카드는 그대로", async () => {
    const { talkSamples } = await import("@/lib/social/talk-samples");
    const [sampleLead, ...samples] = talkSamples(4, 2, NOW, n => `예시 프로젝트 ${n}`);
    const html = render({ lead: sampleLead, rest: [entry(1, "doory"), ...samples] });
    expect(html).toContain('id="talk-lead-title">예시 프로젝트 1</h3>');
    expect(html).toContain("실제 SNS 화제 글이 모이면 이 자리에 실제 프로젝트가 올라옵니다.");
    expect(html.match(/class="talk-sample"/g)).toHaveLength(4);
    expect(html).toContain("&#x27;예시&#x27; 카드는 화면 모양을 보여 주는 견본입니다. 실제 화제가 5개 모이면 자동으로 사라집니다.");
    // 링크는 실제 카드(doory)와 '전체 보기'뿐 — 예시는 /p/ 도 원문 토론도 없다
    expect(html.match(/href="\/p\//g)).toHaveLength(1);
    expect(html).not.toContain("news.ycombinator.com");
    expect(html).not.toContain("자세히 보기");
    expect(render({ lead: entry(1, "doory"), rest: [entry(2, "konnect")] })).not.toContain("talk-sample");
  });
});

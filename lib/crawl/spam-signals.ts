/**
 * 스팸·악성 배포 의심 신호(2026-10-08, UX-03).
 *
 * GitHub 에서 도는 악성 배포 캠페인이 목록 "최신" 첫 화면에 섞였다(/p/transformer-architecture,
 * /p/codex-deepseek). 남의 레포를 베껴 README 를 틀에 찍어 다시 쓰고, 다운로드 링크를 자기 계정의
 * `<계정>.github.io` 첫 화면으로 돌린다. 프로드 공개분 37,298건을 훑어 모양을 잡았다:
 *
 * - README 첫 줄·페이지 제목이 "🤖 codex-deepseek - Run Codex on DeepSeek Models" 틀이다
 * - "Visit this link to download the application", "Free download for Windows", "Run anyway" 같은 미끼
 * - 배포 주소가 그 계정의 github.io 첫 화면이고(레포 자기 페이지가 아니다), README 의 다운로드 링크도 거기다
 * - ★0~1, 이슈 꺼짐, "형용사-명사+숫자" 계정 이름
 *
 * 하나하나는 정상 레포에도 흔하다 — 이모지 제목은 vercel 앱 README 에, github.io 첫 화면은 개인 홈페이지에,
 * "adjective-noun-1234" 는 GitHub 이 추천하는 사용자 이름에 그대로 있다. 그래서 강한 신호 둘 이상이 겹치고
 * 약한 신호도 하나 있어야(또는 강한 신호 셋) 잡는다. 약한 신호만으로는 몇 개가 모여도 잡지 않는다.
 *
 * 순수 함수다. 수집 때 이미 저장한 원본(repo_meta·page_meta)만 읽는다 — 판정·발행·검사 스크립트가 같은 답을 낸다.
 * 잡는다고 거부하지 않는다. 사람에게 넘길 뿐이다(reason=suspected_spam).
 */

export type SpamSignalKey =
  | "templated_title" | "download_lure" | "pages_root_landing" | "readme_download_to_landing"
  | "low_stars" | "issues_disabled" | "random_account";

export type SpamSignal = { key: SpamSignalKey; strength: "strong" | "weak"; detail: string };

export type SpamVerdict = {
  flagged: boolean;
  /** 강한 신호 3점, 약한 신호 1점 */
  score: number;
  /** 강한 신호 셋 이상이면 high, 둘이면 medium. 잡지 않았으면 null */
  confidence: "high" | "medium" | null;
  signals: SpamSignal[];
};

/** 기준이 바뀌면 올린다 — candidate.signals 에 같이 남아 어느 기준으로 잡았는지 되짚는다 */
export const SPAM_DETECTOR_VERSION = "2026-10-08.1";

const STRONG = 3;
const WEAK = 1;
/** 강한 둘 + 약한 하나, 또는 강한 셋 */
export const SPAM_FLAG_SCORE = 2 * STRONG + WEAK;
export const SPAM_MIN_STRONG = 2;

/**
 * "🤖 codex-deepseek - Run Codex on DeepSeek Models".
 * 이모지 + 띄어쓰기 없는 이름 하나 + " - " + 문구. 이름 없이 문장으로 시작하거나 긴 줄표(—)·반줄표(–)를 쓰는
 * 정상 README("📚 Absensiku — Sistem Absensi")는 걸리지 않는다.
 */
const TEMPLATED_TITLE = /^\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*\s*[A-Za-z0-9][\w.-]*\s+-\s+\S/u;

/**
 * 캠페인 문구. 공개분에서 틀 제목이 있는 쪽에만 거의 나오는 말만 골랐다(2026-10-08 실측, 틀 제목 있음/없음):
 * "visit this page to download" 79/1, "download the application" 114/4, "visit this link to download" 41/3.
 * "Download for Windows"(9/300)·"Run anyway"(51/268)·"Download now"(83/59) 는 서명 없는 데스크톱 앱 소개에
 * 흔해서 넣지 않는다.
 */
const LURE_PHRASES = [
  "visit this link to download",
  "visit this page to download",
  "download the application",
  "click the download button",
  "free download for windows",
];
/** README 가 저장소 안의 압축·실행 파일을 raw 주소로 바로 받게 한다 — 64/1. 정상 README 는 릴리스를 건다 */
const RAW_ARCHIVE = /github\.com\/[^\s)]+\/raw\/[^\s)]+\.(?:zip|rar|7z|exe|msi)\b/i;

const RANDOM_ACCOUNT = /^[a-z]+(?:-[a-z]+)?\d{2,4}$/i;

const text = (value: unknown) => typeof value === "string" ? value : "";

/** URL 이 `<계정>.github.io` 첫 화면인가. 하위 경로(owner.github.io/repo)는 레포 자기 페이지라 아니다 */
function pagesRootOf(url: string, owner: string): string | null {
  if (!owner) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === `${owner.toLowerCase()}.github.io` && parsed.pathname.replace(/\/+$/, "") === "" ? host : null;
  } catch {
    return null;
  }
}

export function spamSignals(document: {
  repo: string;
  repoMeta: Record<string, unknown>;
  productUrl: string | null;
  pageMeta: unknown;
}): SpamVerdict {
  const meta = document.repoMeta;
  const page = (document.pageMeta ?? {}) as Record<string, unknown>;
  const owner = text((meta.owner as { login?: unknown } | undefined)?.login) || document.repo.split("/")[0] || "";
  const repoName = (text(meta.name) || document.repo.split("/")[1] || "").toLowerCase();
  const readme = text(page.readmeSample);
  const readmeFirst = readme.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  const title = text(page.title).trim();
  const signals: SpamSignal[] = [];
  const strong = (key: SpamSignalKey, detail: string) => signals.push({ key, strength: "strong", detail: detail.slice(0, 200) });
  const weak = (key: SpamSignalKey, detail: string) => signals.push({ key, strength: "weak", detail: detail.slice(0, 200) });

  const templated = [readmeFirst, title].find(line => TEMPLATED_TITLE.test(line));
  if (templated) strong("templated_title", `틀에 찍은 제목 “${templated}”`);

  const body = [readme, text(page.textSample), text(page.description), text(page.title), text(meta.description)]
    .join("\n").toLowerCase();
  const lure = LURE_PHRASES.filter(phrase => body.includes(phrase)).map(phrase => `“${phrase}”`);
  const archive = readme.match(RAW_ARCHIVE)?.[0];
  if (archive) lure.push(`README 가 저장소 안 파일을 바로 받게 함 ${archive}`);
  if (lure.length) strong("download_lure", `다운로드 미끼 — ${lure.join(", ")}`);

  // 레포 자기 페이지 레포(<계정>.github.io)가 자기 첫 화면을 거는 것은 개인 홈페이지다
  const landing = document.productUrl ? pagesRootOf(document.productUrl, owner) : null;
  if (landing && repoName !== landing) strong("pages_root_landing", `배포 주소가 다른 레포의 ${landing} 첫 화면`);

  /**
   * README 가 다운로드를 그 github.io 첫 화면으로 보낸다. 약한 신호다 — 혼자 만든 앱이 자기 첫 화면에
   * 내려받기 페이지를 두는 것은 정상이고(실측: 소방 기록 앱·iPhone 타이머), 위의 첫 화면 신호와 같은 사실을
   * 한 번 더 세는 셈이라서다. "download" 와 그 주소가 한 문단 안에 같이 있어야 한다.
   */
  if (landing && repoName !== landing) {
    const paragraph = readme.toLowerCase().split(/\n\s*\n/)
      .find(part => part.includes(landing) && /download/.test(part));
    if (paragraph) weak("readme_download_to_landing", `README 의 다운로드 링크가 ${landing}`);
  }

  const stars = meta.stargazers_count;
  if (typeof stars === "number" && stars <= 1) weak("low_stars", `★${stars}`);
  if (meta.has_issues === false) weak("issues_disabled", "이슈 꺼짐");
  // GitHub 추천 이름(adjective-noun-1234)과 같은 모양이라 이것만으로는 아무것도 아니다
  if (RANDOM_ACCOUNT.test(owner)) weak("random_account", `계정 이름 ${owner}`);

  const strongCount = signals.filter(signal => signal.strength === "strong").length;
  const score = signals.reduce((sum, signal) => sum + (signal.strength === "strong" ? STRONG : WEAK), 0);
  const flagged = strongCount >= SPAM_MIN_STRONG && score >= SPAM_FLAG_SCORE;
  return { flagged, score, confidence: flagged ? strongCount >= 3 ? "high" : "medium" : null, signals };
}

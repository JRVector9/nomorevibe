import { decodeEntities } from "@/lib/net/normalize";

/**
 * 제품 이름 — 배포 페이지 제목에서 이름만 남긴다.
 *
 * 없는 이름을 지어내지 않는다. 제목·레포 이름·주소에 이미 있는 글자만 쓴다.
 *
 * og:title은 "이름 | 마케팅 한 줄" 형태가 흔하다. 실제 수집에서
 * "RevealUI | Build it once. Every product after starts ahead."가 통째로 이름이 됐다.
 * 구분자 앞이 이름이고 뒤는 소개다 — 소개는 이미 따로 있다.
 *
 * 앞뒤 공백이 있는 구분자만 곧바로 자른다. 그러지 않으면 e-commerce 같은 이름이 잘린다.
 * 하이픈-마이너스도 구분자다. 실데이터 451건에서 60자를 넘긴 이름 21건 중 11건이
 * "DEEPSEEKAGENTS - AI-Powered Agentic Swarms…"처럼 그것으로 갈라져 있었다. 앞뒤 공백
 * 조건이 있어 e-commerce·Well-Architected·Ready-to-use는 그대로 남는다(확인함).
 */
const SPACED_SEPARATOR = /\s+(?:[|·–—~-]|::)\s+/;

/**
 * 붙여 쓰는 구분자 — 콜론·쉼표·마침표·붙은 대시.
 *
 * 2026-09-11 실측: 45자를 넘는 이름 254개 중 상당수가 "Radiant: your whole coding stack…",
 * "Appstrate, the open-source agent runtime…", "AlgoChat. Cross-language…", "kanso—the language…"
 * 였다. 이것만으로는 이름 안에 콜론을 쓰는 제품("Vibe Coding Starter Guide: from Design to…")과
 * 가를 수 없어서, 앞쪽이 레포 이름이나 주소와 맞을 때만 자른다 — 그러면 앞쪽이 이름이라는 것이
 * 사실로 확인된다. 이니셜 뒤의 마침표("Glen E. Grant")는 구분자가 아니다.
 */
const TIGHT_SEPARATOR = /:\s|：|,\s|(?<!(?:^|\s)\p{Lu})\.\s|[—–]/u;
/** 앞쪽이 이보다 길면 이름이 아니라 문장이다 */
const HEAD_LIMIT = 40;
/** 이보다 길면 이름이 아니라 문장이다 — 그 안에서 레포 이름을 찾아 본다 */
const SENTENCE_LENGTH = 45;

/**
 * 제품 이름이 아닌 제목 — 로그인 벽·문서 첫 장·빈 템플릿.
 * 실측: Home 14개, Sign in 11개, Login 4개, Introduction 4개가 그대로 이름이 됐다.
 */
const GENERIC_TITLES = new Set([
  "home", "homepage", "index", "top", "welcome", "about", "introduction", "overview", "dashboard", "sign in", "signin",
  "sign up", "log in", "login", "entrar", "app", "react app", "vite app", "vite + react", "vite + react + ts",
  "lovable app", "untitled", "document", "frontend", "storybook", "로그인", "홈", "đăng nhập",
]);

export function isGenericTitle(name: string): boolean {
  return GENERIC_TITLES.has(name.trim().toLowerCase());
}

/** 글자와 숫자만 소문자로 — "Telegram Claude + Codex"와 "telegram-claude-codex"를 같게 본다 */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** 배포용 레포·주소에 붙는 꼬리 — auramux-releases, fitforpdf-frontend, fusionkit-docs */
const DEPLOY_SUFFIX = /[-_.](?:frontend|front|web|app|site|website|landing|docs|www|client|ui|releases?|pages?|homepage|demo|prod)$/i;

function withoutSuffix(name: string): string {
  let base = name;
  while (DEPLOY_SUFFIX.test(base)) base = base.replace(DEPLOY_SUFFIX, "");
  return base;
}

/** 주소의 첫 마디 — "fusionkit-docs.vercel.app" → fusionkit-docs, "latex.to" → latex */
function hostLabel(url: string | null): { host: string; label: string } | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return { host, label: host.split(".")[0] };
  } catch {
    return null;
  }
}

type Facts = { repo: string; host: { host: string; label: string } | null };

/**
 * 이 말이 이름이라는 근거.
 *  - exact: 레포 이름이나 주소와 같다(배포용 꼬리를 떼고도 본다)
 *  - part: 레포 이름의 일부다("WPPilot" ⊂ wordpress-mcp-elementor-wppilot)이거나 레포 이름을 품는다.
 *    hostPart 면 주소 첫 마디와도 그렇게 본다(revyy ⊂ revyy-psi.vercel.app, autonomous.ai ⊂ "Autonomous Toys")
 */
function nameMatch(text: string, facts: Facts, hostPart: boolean): "exact" | "part" | null {
  const folded = fold(text);
  if (folded.length < 3) return null;
  const exact = [facts.repo, withoutSuffix(facts.repo), facts.host?.host, facts.host?.label, facts.host && withoutSuffix(facts.host.label)];
  if (exact.some((fact) => fact && fold(fact) === folded)) return "exact";
  const partial = hostPart && facts.host ? [facts.repo, facts.host.label] : [facts.repo];
  for (const fact of partial.map(fold)) {
    if (fact.length >= 3 && fact.includes(folded)) return "part";
    if (fact.length >= 4 && folded.includes(fact)) return "part";
  }
  return null;
}

/** 문장 속에서 레포 이름과 같은 낱말 묶음 — "I open sourced IronMem" → "IronMem" */
function repoSpan(text: string, repo: string): string | null {
  const target = fold(repo);
  if (target.length < 4) return null;
  const words = text.split(/\s+/);
  for (let start = 0; start < words.length; start++) {
    for (let end = start; end < words.length; end++) {
      const span = words.slice(start, end + 1).join(" ");
      const folded = fold(span);
      if (folded === target) return span.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (folded.length > target.length) break;
    }
  }
  return null;
}

export function productName(title: string, repo: string, url: string | null = null): string {
  const repoName = repo.split("/")[1] ?? repo;
  const facts: Facts = { repo: repoName, host: hostLabel(url) };
  const clean = decodeEntities(title).replace(/\s+/g, " ").trim();

  // 앞쪽이 이름이다. 앞쪽이 "Sign in"·"Home" 같은 것이면 레포·주소와 맞는 뒤쪽을 쓴다 — "Sign in | TradeFlow WMS".
  // 앞쪽이 제대로 된 말이면 뒤쪽을 보지 않는다. "Amazon Bedrock - AWS"가 "AWS"가 되면 안 된다.
  // 주소 첫 마디와 일부만 맞는 것은 보지 않는다 — "Sign in - Google Accounts"가 accounts.google.com 과 맞는다
  const parts = clean.split(SPACED_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  let name = parts[0] ?? clean;
  if (parts.length > 1 && isGenericTitle(name)) {
    name = parts.slice(1).find((part) => !isGenericTitle(part) && nameMatch(part, facts, false)) ?? name;
  }

  const separator = TIGHT_SEPARATOR.exec(name);
  if (separator) {
    const head = name.slice(0, separator.index).replace(/[\s:：,.]+$/u, "").trim();
    // 쉼표는 목록일 수 있다 — "Xbox, PS5, Steam & Apple TV…". 레포·주소와 같을 때만 자른다
    const comma = separator[0].startsWith(",");
    const match = head.length <= HEAD_LIMIT ? nameMatch(head, facts, !comma) : null;
    if (match === "exact" || (match === "part" && !comma)) {
      // 앞쪽이 문장이면 그 안의 레포 이름만 — "Как я собрал WebDev Agent Kit" → WebDev Agent Kit.
      // 짧으면 앞쪽이 곧 이름이다 — "Asterwise MCP Server"를 "Asterwise MCP"로 줄이지 않는다
      name = head.split(/\s+/).length >= 5 ? repoSpan(head, repoName) ?? head : head;
    }
  }

  // 그래도 문장이면 그 안의 레포 이름 — "Two Prices for the Same Model: Building Claude Burst"
  if (name.length > SENTENCE_LENGTH) name = repoSpan(name, repoName) ?? name;

  // 제목이 없거나 이름이 아니면 레포 이름 — 그것도 흔한 이름이면 제목을 그대로 둔다
  if (!name || isGenericTitle(name)) {
    return isGenericTitle(repoName) ? name || repoName : repoName;
  }
  return name;
}

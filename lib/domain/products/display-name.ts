/** Preserve product branding; simplify only an exact repository full-name fallback. */
export function displayProjectName(name: string, repoUrl: string | null): string {
  if (!repoUrl) return name;
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== 'github.com' || !['https:', 'http:'].includes(url.protocol)) return name;
    const path = url.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/i, '');
    const parts = path.split('/');
    if (parts.length !== 2 || !parts.every(Boolean)) return name;
    const trimmed = name.trim();
    return trimmed.toLowerCase() === path.toLowerCase() ? trimmed.split('/')[1] : name;
  } catch { return name; }
}

/**
 * 제품 이름이 아닌 제목 — 로그인 벽·문서 첫 장·빈 템플릿·홈페이지.
 * 실측: Home 14개, Sign in 11개, Login 4개, Introduction 4개가 그대로 이름이 됐다. 2026-10-08 UX 감사(UX-33)에서
 * 인기 9위가 '首页'(중국어 '홈페이지')였다. 수집(lib/crawl/product-name.ts)과 이름 확인(reviewProductName)이 같은 목록을 쓴다.
 */
const GENERIC_NAMES = new Set([
  'home', 'homepage', 'home page', 'index', 'top', 'welcome', 'about', 'introduction', 'overview', 'dashboard', 'sign in', 'signin',
  'sign up', 'log in', 'login', 'entrar', 'app', 'react app', 'vite app', 'vite + react', 'vite + react + ts',
  'lovable app', 'untitled', 'document', 'frontend', 'storybook', '로그인', '홈', '홈페이지', 'đăng nhập', 'trang chủ',
  '首页', '首頁', '主页', '主頁', 'ホーム', 'トップページ', 'inicio', 'accueil', 'startseite',
]);

export function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(name.trim().toLowerCase());
}

/** 이름 정리 사유 — 관리자 '이름 확인 필요'가 사람이 읽는 말로 보여 준다(NAME_ISSUE_LABELS) */
export type NameIssue = 'generic' | 'slogan_tail' | 'too_long' | 'slogan' | 'emoji_prefix' | 'all_caps';
export const NAME_ISSUE_LABELS: Record<NameIssue, string> = {
  generic: '일반어 제목', slogan_tail: '구분자 뒤 슬로건', too_long: '40자 넘음', slogan: '이름이 아닌 문구', emoji_prefix: '이모지 접두', all_caps: '전부 대문자',
};
/**
 * source — 제안이 어디서 왔나. title: 제목 안의 말(구분자 앞뒤·이모지 뗀 나머지·대소문자만 고침), repo: 제목에서 못 찾아 저장소 이름으로 대신했다.
 * 저장소 이름 대신은 자주 틀린다(2026-10-09 공개분 표본: 'AgentKit: AI Agent Integrations…' → 'Authstack', 'The W App' → 'W App Web') —
 * guess: 제목 안의 말이지만 저장소 이름에 기대어 골랐거나(구분자 뒤 조각·40자 넘는 제목 속 묶음) 대소문자를 짐작했다 —
 * 2026-10-09 백필 표본에서 'Earn your first dollar online with Gumroad' → 'Gumroad', 'MicroGains || Daily-habit-tracker' →
 * 'Daily-habit-tracker', 'HAIDER ALI' → 'Haider ALI' 로 틀렸다.
 * 발행·일괄 정리는 title 만 자동으로 쓰고, guess·repo 는 관리자 '이름 확인 필요'에서 사람이 고른다.
 */
export type NameReview = { issues: NameIssue[]; proposed: string | null; source: "title" | "guess" | "repo" | null };

/** 이보다 긴 이름은 이름이 아니라 문장이다(UX-33) */
export const NAME_MAX = 40;

/** 앞에 붙은 그림 문자 — '🚀 transformer-architecture' */
const EMOJI_PREFIX = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}️‍⃣]\s*)+/u;
/**
 * 이름과 슬로건 사이의 구분자 — •·| 는 붙여 써도, 대시·가운뎃점·물결은 앞뒤에 공백이 있을 때만(e-commerce 를 자르지 않는다).
 * 'Wireshark • Go Deep'
 */
const SLOGAN_SEPARATOR = /\s*[•|｜]\s*|\s+[–·~-]\s+|\s*—\s*|\s+::\s+/;
/** 콜론은 이름 안에도 쓰인다 — 앞쪽이 저장소 이름과 맞을 때만 자른다 */
const COLON = /:\s+|：/;
/** 문구의 표지 — 이름보다 문장에 나오는 낱말 */
const FUNCTION_WORDS = new Set(['for', 'the', 'and', 'of', 'to', 'with', 'your', 'in', 'on', 'by', 'from', 'a', 'an']);
/** 저장소 이름을 다듬을 때 대문자로 두는 낱말 */
const ACRONYMS: Record<string, string> = {
  ai: 'AI', api: 'API', ui: 'UI', ux: 'UX', cli: 'CLI', sdk: 'SDK', llm: 'LLM', mcp: 'MCP', gpt: 'GPT', crm: 'CRM', erp: 'ERP',
  seo: 'SEO', pdf: 'PDF', rss: 'RSS', ios: 'iOS', css: 'CSS', html: 'HTML', sql: 'SQL', json: 'JSON', url: 'URL',
};
/** 저장소 이름이 이것뿐이면 제품 이름으로 내세울 수 없다 */
const DEPLOY_WORDS = new Set(['website', 'site', 'web', 'www', 'landing', 'docs', 'client', 'ui', 'demo', 'pages', 'portfolio', 'blog', 'public', 'src']);
/** 전부 대문자라도 두는 짧은 낱말 — 대개 약어다(AI·CRM·MCP). 흔한 짧은 낱말만 고쳐 쓴다 */
const COMMON_SHORT = new Set(['the', 'and', 'for', 'of', 'to', 'in', 'on', 'my', 'your', 'our', 'with', 'by', 'a', 'an', 'is', 'it', 'new', 'app', 'one', 'all']);

function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 저장소 주소의 owner/name — github.com 이 아니어도 /owner/name 꼴이면 */
function repoParts(repoUrl: string | null): { owner: string; name: string } | null {
  if (!repoUrl) return null;
  try {
    const parts = new URL(repoUrl).pathname.replace(/^\/|\/$/g, '').replace(/\.git$/i, '').split('/');
    return parts.length >= 2 && parts[0] && parts[1] ? { owner: parts[0], name: parts[1] } : null;
  } catch { return null; }
}

/** 이름이 저장소와 이어지는가 — 접어서 서로 품거나, 이름의 낱말(4자 이상) 하나가 저장소 이름·owner 안에 있다 */
function related(text: string, repo: { owner: string; name: string } | null): boolean {
  if (!repo) return false;
  const folded = fold(text);
  const facts = [fold(repo.name), fold(repo.owner)].filter((fact) => fact.length >= 3);
  if (facts.some((fact) => folded.includes(fact) || (folded.length >= 3 && fact.includes(folded)))) return true;
  return text.split(/[^\p{L}\p{N}]+/u).map(fold).some((word) => word.length >= 4 && facts.some((fact) => fact.includes(word)));
}

/** 문장 속에서 저장소 이름과 같은 낱말 묶음 — 'I open sourced IronMem today' → IronMem */
function repoSpan(text: string, repoName: string): string | null {
  const target = fold(repoName);
  if (target.length < 4) return null;
  const words = text.split(/\s+/);
  for (let start = 0; start < words.length; start++) {
    for (let end = start; end < words.length; end++) {
      const span = words.slice(start, end + 1).join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const folded = fold(span);
      if (folded === target) return span;
      if (folded.length > target.length) break;
    }
  }
  return null;
}

/**
 * 저장소 이름을 제품 이름으로 — 지은 이름이 아니라 저장소에 이미 있는 글자다.
 * 대소문자를 섞어 쓴 이름(DeepSeekAgents·Open-WebUI)은 그 표기를 지키고 구분자만 띄운다. 전부 소문자면 낱말 첫 글자를 올린다
 * ('linkedin-agent' → 'Linkedin Agent', 약어는 'ai-chat' → 'AI Chat'). 흔한 배포 이름·개인 github.io 는 내세우지 않는다.
 */
export function prettyRepoName(repoUrl: string | null): string | null {
  const repo = repoParts(repoUrl);
  if (!repo) return null;
  const name = repo.name;
  if (isGenericName(name) || DEPLOY_WORDS.has(name.toLowerCase()) || /\.github\.io$/i.test(name)) return null;
  const words = name.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return null;
  if (/[A-Z]/.test(name)) return words.join(' ');
  return words.map((word) => ACRONYMS[word] ?? word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * 영문자가 모두 대문자인 긴 이름 — 'LINKEDIN AGENT'. NASA·AWS CLI·MITRE ATT&CK 처럼 짧은 약어 이름은 두다.
 * 로마자 밖의 글자(베트남어 'BỘ TÀI LIỆU' 등)가 섞이면 보지 않는다 — 영문 낱말만 고쳐 써서 대소문자가 뒤섞인다.
 */
function isAllCaps(name: string): boolean {
  if (/[^A-Za-z]/.test((name.match(/\p{L}/gu) ?? []).join(""))) return false;
  const latin = name.match(/[A-Za-z]/g) ?? [];
  if (latin.length < 8 || /[a-z]/.test(name)) return false;
  return name.split(/[^A-Za-z]+/).some((word) => word.length >= 6);
}

/**
 * 저장소가 같은 이름을 섞어 쓴 대소문자로 적어 두었으면 그 대소문자 — 'DEEPSEEKAGENTS' → DeepSeekAgents.
 * 띄어쓰기·하이픈은 제목 것을 둔다 — 'ZARVIS MOBILE' 과 저장소 ZarvisMobile → 'Zarvis Mobile'(저장소 표기를 통째로 쓰면 'ZarvisMobile')
 */
function repoSpelling(name: string, repo: { owner: string; name: string } | null): string | null {
  if (!repo || fold(repo.name) !== fold(name) || !/[a-z]/.test(repo.name) || !/[A-Z]/.test(repo.name)) return null;
  const letters = [...repo.name].filter((char) => /[\p{L}\p{N}]/u.test(char));
  const spelled = [...name].map((char) => /[\p{L}\p{N}]/u.test(char) ? letters.shift() ?? char : char).join('');
  return spelled.toLowerCase() === name.toLowerCase() ? spelled : null;
}

function recase(name: string): string {
  // 첫 낱말이 아닌 for·of·the 같은 낱말은 소문자로
  return name.replace(/[A-Za-z]+/g, (word, offset: number) => {
    const lower = word.toLowerCase();
    if (offset > 0 && FUNCTION_WORDS.has(lower)) return lower;
    return word.length <= 3 && !COMMON_SHORT.has(lower) ? word : word.charAt(0) + lower.slice(1);
  });
}

/** 슬로건이 이름 자리에 선 것 — 'Flexible Open-Source ERP & CRM for SMBs', 'The AI Workspace'. 저장소와 이어지면 이름으로 본다 */
function isSlogan(name: string, repo: { owner: string; name: string } | null): boolean {
  if (!repo || related(name, repo)) return false;
  const words = name.split(/\s+/).filter(Boolean);
  const lower = words.map((word) => word.toLowerCase());
  if (words.length >= 5 && lower.slice(1).some((word) => FUNCTION_WORDS.has(word))) return true;
  return words.length >= 3 && ['the', 'your', 'a', 'an'].includes(lower[0]);
}

/**
 * 이름 정규화(2026-10-08 UX 감사 UX-33) — 크롤링한 페이지 제목이 그대로 이름이 된 것을 가리고 더 나은 이름을 낸다.
 *
 * 걸리는 것: 일반어 제목(home·首页·index·홈), 슬로건 구분자(•, |, —) 뒤가 긴 것, 40자 넘는 것, 이름이 아닌 문구,
 * 이모지 접두, 전부 대문자. 제안은 제목 앞쪽(구분자 앞)이 이름이면 그것, 아니면 저장소 이름(prettyRepoName)이다 —
 * 없는 이름을 지어내지 않는다. 걸렸지만 내세울 이름이 없으면 proposed 가 null 이다(사람이 본다). 괜찮은 이름이면 null.
 *
 * 쓰는 곳: 새 제품 발행(lib/crawl/publish.ts, normalizedProductName), 관리자 '이름 확인 필요'와 기존 제품 백필(name-review.ts).
 */
export function reviewProductName(name: string, repoUrl: string | null): NameReview | null {
  const original = name.trim();
  // owner/repo 꼴은 화면이 이미 저장소 이름으로 줄여 보인다(displayProjectName)
  if (!original || displayProjectName(original, repoUrl) !== original) return null;
  const repo = repoParts(repoUrl);
  const issues: NameIssue[] = [];
  let current = original;
  // 저장소 이름에 기대어 고르거나 대소문자를 짐작했다 — 자동으로 쓰지 않는다(NameReview guess)
  let guessed = false;

  const emoji = current.match(EMOJI_PREFIX);
  // 떼고 나면 글자가 거의 없는 이름('🐋 vs 🦞')은 그림 문자가 이름의 일부다 — 두다
  if (emoji && (current.slice(emoji[0].length).match(/\p{L}/gu) ?? []).length >= 3) {
    current = current.slice(emoji[0].length).trim();
    issues.push('emoji_prefix');
  }

  const parts = current.split(SLOGAN_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  const colon = COLON.exec(current);
  if (parts.length > 1 && [...parts[0]].length >= 2) {
    const [head, ...rest] = parts;
    if (isGenericName(head)) {
      // 'Home | Acme' — 뒤쪽이 저장소와 이어지는 이름이면 그것을 쓴다
      current = rest.find((part) => !isGenericName(part) && related(part, repo)) ?? '';
      issues.push('generic');
    } else if (rest.join(' ').split(/\s+/).length >= 2 || rest.join(' ').length >= 12) {
      // 앞쪽이 설명이고 이름이 뒤에 있는 제목도 있다 — '台灣包車旅遊・機場接送｜RelayGo 專業包車平台'. 저장소와 이어지는 쪽이 이름이다
      const named = related(head, repo) ? undefined : rest.find((part) => related(part, repo));
      current = named ? (repo && repoSpan(named, repo.name)) || named : head;
      if (named) guessed = true;
      issues.push('slogan_tail');
    }
  } else if (colon && related(current.slice(0, colon.index), repo) && current.slice(colon.index + colon[0].length).split(/\s+/).length >= 2) {
    current = current.slice(0, colon.index).trim();
    issues.push('slogan_tail');
  }

  if (!current || isGenericName(current)) {
    if (!issues.includes('generic')) issues.push('generic');
    current = '';
  } else if ([...current].length > NAME_MAX) {
    issues.push('too_long');
    current = repo ? repoSpan(current, repo.name) ?? '' : '';
    guessed = true;
  } else if (isSlogan(current, repo)) {
    issues.push('slogan');
    current = '';
  }

  if (current && isAllCaps(current)) {
    issues.push('all_caps');
    const spelled = repoSpelling(current, repo);
    if (!spelled) guessed = true;
    current = spelled ?? recase(current);
  }

  if (!issues.length) return null;
  const fromTitle = Boolean(current);
  const proposed = current || prettyRepoName(repoUrl);
  const kept = proposed && proposed !== original ? proposed.slice(0, 120) : null;
  return { issues, proposed: kept, source: kept ? (fromTitle ? (guessed ? "guess" : "title") : "repo") : null };
}

/** 발행할 이름 — 제목 안의 말로 고친 제안(title)만 쓴다. 짐작(guess)·저장소 이름 대신(repo)은 관리자 '이름 확인 필요'에서 사람이 고른다 */
export function normalizedProductName(name: string, repoUrl: string | null): string {
  const review = reviewProductName(name, repoUrl);
  return review?.source === "title" && review.proposed ? review.proposed : name;
}

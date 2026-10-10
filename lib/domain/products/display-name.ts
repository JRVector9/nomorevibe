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
  // 2026-10-11 공개분: 'Welcome back' 'About Me' 가 그대로 이름이었다
  'welcome back', 'about me', 'about us',
]);
/**
 * 제목이 문서 도구의 이름인 것 — 사이트를 Storybook 으로 띄우면 제목이 '@storybook/cli - Storybook'·'@storybook/core' 다.
 * 2026-10-11 공개분 5건(Primer CSS·react-spectrum-charts·cosmos.gl…)이 이 이름으로 올라가 있었다
 */
const GENERIC_PATTERNS = [/^@storybook\/[\w.-]+$/];

export function isGenericName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return GENERIC_NAMES.has(lower) || GENERIC_PATTERNS.some((pattern) => pattern.test(lower));
}

/** 이름 정리 사유 — 관리자 '이름 확인 필요'가 사람이 읽는 말로 보여 준다(NAME_ISSUE_LABELS) */
export type NameIssue = 'generic' | 'slogan_tail' | 'too_long' | 'slogan' | 'emoji_prefix' | 'all_caps' | 'boilerplate';
export const NAME_ISSUE_LABELS: Record<NameIssue, string> = {
  generic: '일반어 제목', slogan_tail: '구분자 뒤 슬로건', too_long: '40자 넘음', slogan: '이름이 아닌 문구', emoji_prefix: '이모지 접두', all_caps: '전부 대문자',
  boilerplate: '인사·문서 머리말',
};
/**
 * source — 제안이 어디서 왔나. title: 제목 안의 말(구분자 앞뒤·이모지 뗀 나머지·대소문자만 고침), repo: 제목에서 못 찾아 저장소 이름으로 대신했다.
 * 저장소 이름 대신은 자주 틀린다(2026-10-09 공개분 표본: 'AgentKit: AI Agent Integrations…' → 'Authstack', 'The W App' → 'W App Web') —
 * guess: 제목 안의 말이지만 저장소 이름에 기대어 골랐거나(구분자 뒤 조각·40자 넘는 제목 속 묶음) 대소문자를 짐작했다 —
 * 2026-10-09 백필 표본에서 'Earn your first dollar online with Gumroad' → 'Gumroad', 'MicroGains || Daily-habit-tracker' →
 * 'Daily-habit-tracker', 'HAIDER ALI' → 'Haider ALI' 로 틀렸다.
 * 발행·일괄 정리는 title 만 자동으로 쓰고, guess·repo 는 관리자 '이름 확인 필요'에서 사람이 고른다.
 */
export type NameReview = { issues: NameIssue[]; proposed: string | null; source: "title" | "guess" | "repo" | "readme" | null };
/** 사람 손 없이 쓰는 제안 — 제목 안의 말(title)과 저장소와 이어지는 README 첫 제목(readme). 짐작(guess)·저장소 이름 대신(repo)은 사람이 고른다 */
export const AUTOMATIC_NAME_SOURCES: ReadonlySet<NameReview["source"]> = new Set(["title", "readme"]);

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

/**
 * 저장소 이름과 굳게 이어진다 — 접어서 한쪽이 다른 쪽을 품는다(4자 이상). related 는 낱말 하나만 겹쳐도 이어진다고 봐서
 * 'Open source: IPCamLapse…'(저장소 OpenCamInterop)의 'open', 'firstworks: SQL Relay'의 owner 가 이름을 자르는 근거가 됐다.
 */
function strongRelated(text: string, repo: { owner: string; name: string } | null): boolean {
  if (!repo) return false;
  const folded = fold(text);
  const name = fold(repo.name);
  return folded.length >= 4 && name.length >= 4 && (name.includes(folded) || folded.includes(name));
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

/**
 * 인사·문서 머리말 — 2026-10-11 공개분 실측: 'Welcome to pytimer’s documentation!'(Sphinx 기본 제목) 59건, 'Welcome to Workrave' 류 28건,
 * 'About OSDCloud' 류 9건, '@fnix/lexxy-mathjax demo' 류 3건이 그대로 이름이었다.
 * 문서 생성기의 기본 제목은 틀이 정해져 있어 안의 이름을 그대로 믿는다. 나머지는 뗀 말이 저장소와 이어질 때만 자동으로 쓴다
 * ('About Time' 같은 진짜 이름을 'Time' 으로 자르지 않게, 제목 전체가 저장소 이름과 같으면 떼지 않는다).
 */
const DOCS_WELCOME = /^welcome to (?:the )?(.+?)(?:['’]s)?\s+(?:v?\d[\w.-]*\s+)?(?:(?:developer|user|api|official|online)\s+)?documentation\b/i;
/** 이름 뒤에 붙는 꾸밈말 — 'Shaka Player Demo', 'AegisFlow documentation', 'ChatUp 文档'. 앞의 수식어('official'·'live'·'web')도 같이 뗀다 */
const DESCRIPTOR = /\s+(?:(?:live|web|official|online|interactive|code|developer|user|api)\s+)?(demo|docs|documentation|playground|storybook|examples?|samples?|showcase|组件展示|組件展示|文档|ドキュメント)[!.]*$/i;
/** 꾸밈말이 저장소 이름에도 있으면 그 말은 이름의 일부다 — dotnet/docs 의 '.NET documentation', nemoclaw-community-examples */
const DESCRIPTOR_ROOTS: Record<string, string> = { documentation: 'doc', docs: 'doc', examples: 'example', example: 'example', samples: 'sample', sample: 'sample' };
const WRAPPERS = [
  /^welcome to (?:the )?(.+?)(?:\s+(?:project|website|site|homepage))?[!.]*$/i,
  /^about (?:the )?(.+)$/i,
  /^(@[\w.-]+\/[\w.-]+)\s+\S.*$/,
];

/** 저장소 이름과 글자가 같다 — 배포용 꼬리(-web·-app·-docs…)를 떼고도 본다 */
function sameAsRepo(text: string, repo: { owner: string; name: string } | null): boolean {
  if (!repo) return false;
  const folded = fold(text);
  return folded.length >= 3 && [repo.name, repo.name.replace(/[-_.](?:frontend|web|app|site|website|landing|docs|demo|ui|client|www)$/i, '')]
    .some((name) => fold(name) === folded);
}

function unwrapBoilerplate(text: string, repo: { owner: string; name: string } | null): { name: string; sure: boolean } | null {
  if (repo && fold(text) === fold(repo.name)) return null;
  // 뗀 뒤 끝에 남은 구분자·문장부호는 지운다('MUI / Playground' → MUI). 끝이 by·of 같은 낱말이면 이름 중간을 자른 것이다('Modelica by Example')
  const clean = (name: string) => name.replace(/[\s/|:·•–—-]+$/u, '').trim();
  const usable = (name: string) => fold(name).length >= 3 && !FUNCTION_WORDS.has(name.toLowerCase()) && !isGenericName(name)
    && !FUNCTION_WORDS.has(name.split(/\s+/).at(-1)!.toLowerCase());
  const docs = DOCS_WELCOME.exec(text);
  if (docs) return usable(clean(docs[1])) ? { name: clean(docs[1]), sure: true } : { name: '', sure: true };
  const descriptor = DESCRIPTOR.exec(text);
  if (descriptor) {
    const root = DESCRIPTOR_ROOTS[descriptor[1].toLowerCase()] ?? fold(descriptor[1]);
    const name = clean(text.slice(0, descriptor.index));
    if (repo && fold(repo.name).includes(root)) return null;
    // 꾸밈말을 떼는 것은 남는 말이 저장소 이름과 글자까지 같을 때만 자동이다 — "Lawson's Learning Playground"(저장소 lawson)는
    // README 가 'Lawson's Playground' 라 'Lawson's Learning' 이 틀린 이름이었다. 스코프(@fnix/)는 빼고 견준다
    return usable(name) ? { name, sure: sameAsRepo(name.replace(/^@[\w.-]+\//, ''), repo) } : null;
  }
  for (const pattern of WRAPPERS) {
    const name = clean(pattern.exec(text)?.[1] ?? '');
    if (name && usable(name)) return { name, sure: related(name, repo) };
  }
  return null;
}

/** README 머리 제목이 틀에서 온 것 — 템플릿이 쓴 제목은 제품 이름이 아니다 */
const README_BOILERPLATE = /^(?:getting started|create react app|react \+|vite \+|welcome to (?:your|the)|project (?:title|name)|readme|template|untitled|my (?:app|project)|next\.js|next-forge|nuxt|sveltekit|expo|turborepo|create t3 app|lovable|bolt|v0)\b/i;

/**
 * README 첫 제목 — 제목에 이름이 없을 때('Welcome back'·'@storybook/core') 메이커가 README 에 적은 이름.
 * 저장된 README(readmeSample·search_readme)는 마크다운 표시(#)가 빠진 글이라 글이 있는 첫 줄을 제목으로 본다. 그림·주소만 든 줄은 건너뛰고,
 * 첫 줄이 주소를 품거나 40자를 넘거나 일반어·템플릿 제목('next-forge'·'Getting Started with Create React App')이면 쓰지 않는다.
 * 'Findable — 한국 최초 Agentic GEO Platform' 처럼 구분자 뒤 슬로건은 뗀다. 저장소 이름(또는 owner)과 글자까지 같을 때만 쓴다 —
 * 두 곳이 같은 이름을 말해야 사람 없이 쓴다. 2026-10-11 공개분 미리보기에서 '이어지기만' 하는 README 첫 줄은
 * 'github.io'·'A portfolio you can talk to'·'Explore Santos ↗' 같은 것이 섞였다.
 */
export function readmeHeading(readme: string | null | undefined, repoUrl: string | null): string | null {
  if (!readme) return null;
  const repo = repoParts(repoUrl);
  for (const line of readme.split('\n').slice(0, 30)) {
    const text = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
      .replace(/^\s*#+\s*/, '').replace(/[`*_]/g, '').replace(EMOJI_PREFIX, '').trim();
    if (!/[\p{L}\p{N}]/u.test(text) || /^[=\-\s]+$/.test(text)) continue;
    if (/https?:\/\/|\(\s*\)/.test(text)) return null;
    const name = text.split(SLOGAN_SEPARATOR)[0].replace(/&nbsp;/g, ' ').replace(/[^\p{L}\p{N}).!?'"]+$/u, '').trim();
    const confirmed = sameAsRepo(name, repo) || (repo !== null && fold(name).length >= 3 && fold(name) === fold(repo.owner));
    // 'blog'·'Portfolio v1' 같은 흔한 배포 이름은 저장소와 같아도 이름으로 내세우지 않는다(prettyRepoName 과 같은 선)
    const deployName = DEPLOY_WORDS.has(name.toLowerCase().replace(/[\s_-]*v?\d+$/, ''));
    return name && [...name].length <= NAME_MAX && !isGenericName(name) && !README_BOILERPLATE.test(name) && !deployName && confirmed ? name : null;
  }
  return null;
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
export function reviewProductName(name: string, repoUrl: string | null, readme?: string | null): NameReview | null {
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

  if (!isGenericName(current)) {
    const unwrapped = unwrapBoilerplate(current, repo);
    if (unwrapped) {
      current = unwrapped.name;
      issues.push('boilerplate');
      if (!unwrapped.sure) guessed = true;
    }
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
      // 앞쪽이 저장소와 흔한 낱말 하나로만 이어지고 뒤쪽도 이어지면 어느 쪽이 이름인지 모른다 — 짐작으로 둔다.
      // 2026-10-11: 'CRM • André Vitor Fotografia' → 'CRM', 'Travel Blog & Travel Guides • Daniela and Will Travel' → 앞쪽이 틀렸다
      // (뒤쪽이 저장소 이름이라고 뒤쪽을 고르는 것도 틀린다 — 'MicroGains || Daily-habit-tracker')
      const ambiguous = !named && !strongRelated(head, repo) && rest.some((part) => related(part, repo));
      if (named || ambiguous) guessed = true;
      issues.push('slogan_tail');
    }
  } else if (colon && strongRelated(current.slice(0, colon.index), repo) && current.slice(colon.index + colon[0].length).split(/\s+/).length >= 2) {
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
  // 제목에 이름이 아예 없으면(일반어 제목) README 첫 줄이 저장소 이름과 같을 때 그 표기를, 아니면 저장소 이름(사람이 본다).
  // 슬로건·긴 제목은 README 로 대신하지 않는다 — README 첫 줄도 슬로건인 경우가 많았다
  const heading = current || !issues.includes('generic') ? null : readmeHeading(readme, repoUrl);
  const proposed = current || heading || prettyRepoName(repoUrl);
  const kept = proposed && proposed !== original ? proposed.slice(0, 120) : null;
  const source = current ? (guessed ? "guess" : "title") : heading ? "readme" : "repo";
  return { issues, proposed: kept, source: kept ? source : null };
}

/** 발행할 이름 — 제목 안의 말(title)·README 첫 제목(readme)만 쓴다. 짐작(guess)·저장소 이름 대신(repo)은 관리자 '이름 확인 필요'에서 사람이 고른다 */
export function normalizedProductName(name: string, repoUrl: string | null, readme?: string | null): string {
  const review = reviewProductName(name, repoUrl, readme);
  return review && AUTOMATIC_NAME_SOURCES.has(review.source) && review.proposed ? review.proposed : name;
}

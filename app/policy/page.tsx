import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { pageTitle } from "@/lib/copy/brand";
import { UNCLAIMED_HINT, UNCLAIMED_LABEL } from "@/lib/copy/terms";

/**
 * 게재 기준(2026-10-08 UX 감사 UX-21, 2026-10-09 운영자 결정 D1·D2·D5).
 *
 * 푸터 '게재 기준'과 상세의 요청 폼·운영자 상자가 아래 앵커로 보낸다 — #listing #ai-evidence #excluded #unclaimed #takedown #contact.
 * 앵커 이름을 바꾸면 그 링크들이 맨 위로 떨어진다.
 *
 * 문구는 지금 돌고 있는 규칙을 옮긴 것이다. 규칙을 바꾸면 여기도 고친다.
 * - 올리는 것·빼는 것: AI 심사 지침(lib/crawl/agent-review.ts REVIEW_SYSTEM_PROMPT)과 설치형 기준(lib/domain/products/access.ts),
 *   스팸 재검사(jobs/products/spam-rescan.ts), 닿지 않는 제품 가리기(repository.ts notDown)
 * - 개인 프로필: 기본 목록에서 가림(visibility.ts), 색인은 본인 확인 뒤(indexing.ts)
 * - AI 근거와 색인: indexing.ts 4번 — 흔적은 사용 주장이지 실행 증명이 아니다(상세 '무엇으로 만들었나'와 같은 말)
 * - 내려달라는 요청: 접수 즉시 noindex(indexing.ts 2번), 24시간 안 확인(takedown-view.ts TAKEDOWN_OVERDUE_HOURS)
 * 공개 이메일 주소는 두지 않는다(D5) — 연락은 사이트 안의 요청 폼으로 받는다.
 */
export const metadata: Metadata = {
  title: pageTitle("게재 기준"),
  description: "nomorevibe에 어떤 프로젝트를 올리고 어떤 것을 빼는지, 내려달라는 요청은 어떻게 처리하는지 적었습니다.",
};

const SECTIONS = [
  { id: "listing", title: "올리는 프로젝트" },
  { id: "ai-evidence", title: "AI 근거" },
  { id: "excluded", title: "올리지 않는 것" },
  { id: "unclaimed", title: UNCLAIMED_LABEL },
  { id: "takedown", title: "내려달라는 요청" },
  { id: "contact", title: "연락하기" },
] as const;

export default async function PolicyPage() {
  // 요청 때 그린다 — 정적으로 굳히면 헤더(검색어를 읽는다)가 서버 HTML 에서 빠졌다가 브라우저에서 끼어든다
  await connection();

  return (
    <main className="mx-auto max-w-[760px] px-6 pb-20 pt-10 text-[15px] leading-[1.75] text-fg">
      <h1 className="text-[28px] font-semibold tracking-tight">게재 기준</h1>
      <p className="mt-2 text-fg-2">
        어떤 프로젝트가 올라오고 어떤 것이 빠지는지, 내리고 싶을 때는 어떻게 하는지 적었습니다.
      </p>
      <nav aria-label="게재 기준 목차" className="mt-5 flex flex-wrap gap-x-4 text-[14px]">
        {SECTIONS.map((section) => (
          <a key={section.id} href={`#${section.id}`} className="inline-flex min-h-11 items-center text-accent-ink underline-offset-4 hover:underline">
            {section.title}
          </a>
        ))}
      </nav>

      <Section id="listing" title="올리는 프로젝트">
        <p>사람이 만들어 공개한 소프트웨어를 올립니다. 두 길로 들어옵니다.</p>
        <ul>
          <li>
            메이커가 AI 코딩 도구에서 <code>/nomorevibe</code> 명령으로 직접 등록한 프로젝트 —{" "}
            <Link href="/launch" className="text-accent-ink underline underline-offset-4">등록하는 법</Link>
          </li>
          <li>공개된 저장소와 사이트에서 우리가 찾아 올린 프로젝트 — 자동 규칙과 AI 심사를 거쳐 기준에 맞는 것만 공개하고, 판단이 어려운 것은 사람이 봅니다.</li>
        </ul>
        <p>이런 페이지가 기준에 맞습니다.</p>
        <ul>
          <li>웹 서비스의 첫 페이지 — 가입이나 결제가 먼저 필요해도 됩니다</li>
          <li>데스크톱·모바일 앱의 다운로드 페이지, 터미널 도구의 설치 안내</li>
          <li>브라우저·에디터 확장, 플러그인, AI 에이전트 스킬, MCP 서버</li>
          <li>라이브러리·SDK·프레임워크의 소개와 설치 안내</li>
          <li>게임, API, 그 자리에서 바로 쓰는 도구</li>
        </ul>
        <p>
          사이트 없이 저장소로만 배포하는 프로젝트는 GitHub 스타가 500개 이상이거나, 스킬·플러그인·확장처럼 설치에 필요한 파일이
          저장소에 있을 때 올립니다.
        </p>
      </Section>

      <Section id="ai-evidence" title="AI 근거">
        <p>
          저장소에서 AI 코딩 도구를 쓴 흔적을 찾습니다 — 도구별 지침 파일(CLAUDE.md, .cursor 규칙 등), 도구 설정 파일, 도구 이름이 붙은
          커밋 서명. 찾은 흔적은 상세 페이지의 ‘무엇으로 만들었나’에 근거 링크와 함께 보입니다.
        </p>
        <p>
          흔적은 그 도구를 썼다는 표시이지, 그 도구로 만들었다는 증명은 아닙니다. {UNCLAIMED_LABEL} 프로젝트는 이 흔적이 확인된 것만
          검색엔진에 노출합니다.
        </p>
      </Section>

      <Section id="excluded" title="올리지 않는 것">
        <ul>
          <li>스팸이나 악성 프로그램 배포로 보이는 페이지 — 공개한 뒤에도 매일 다시 검사해 걸리면 내립니다.</li>
          <li>
            소프트웨어가 아닌 사이트 — 회사·대행사 소개, 강의·유료 커뮤니티, 기사·블로그 글·뉴스레터, 문서 페이지, 다른 플랫폼의 소개
            페이지(Product Hunt, npm 등), 준비 중이거나 빈 페이지
          </li>
          <li>
            본인이 동의하지 않은 개인 프로필 — 이력·포트폴리오·개인 홈페이지는 본인이 등록하거나 운영자로 확인한 경우에만 목록·분야·검색에
            보입니다. 그 전에는 검색엔진에도 노출하지 않습니다.
          </li>
        </ul>
        <p>접속되지 않는 프로젝트는 다시 열릴 때까지 목록에서 가립니다.</p>
      </Section>

      <Section id="unclaimed" title={`‘${UNCLAIMED_LABEL}’이란`}>
        <p>
          {UNCLAIMED_HINT} 이름·소개·분야는 공개된 저장소와 사이트에서 가져오거나 AI가 요약한 것이라 틀릴 수 있습니다.
        </p>
        <p>
          운영자라면 프로젝트 폴더에서 <code>/nomorevibe verify</code>를 실행해 소유권을 확인하세요. 확인하면 이 표시가 사라지고 소개를
          직접 관리할 수 있습니다 —{" "}
          <Link href="/launch#verify" className="text-accent-ink underline underline-offset-4">확인하는 법</Link>
        </p>
      </Section>

      <Section id="takedown" title="내려달라는 요청">
        <p>프로젝트 상세 페이지 아래쪽의 요청 폼으로 보내 주세요. 이유는 적지 않아도 됩니다.</p>
        <ul>
          <li>요청이 들어오면 확인하기 전에도 바로 검색엔진 노출을 멈춥니다.</li>
          <li>24시간 안에 확인하고 목록과 상세 페이지에서 내립니다.</li>
          <li>장난이거나 운영자가 아닌 사람의 요청으로 보이면 그대로 둘 수 있습니다.</li>
        </ul>
      </Section>

      <Section id="contact" title="연락하기">
        <p>
          공개 이메일 주소는 두지 않습니다. 프로젝트에 관한 요청은 그 프로젝트 상세 페이지의 요청 폼으로 받습니다. 운영자라면{" "}
          <code>/nomorevibe verify</code>로 소유권을 확인한 뒤 소개를 직접 고칠 수 있습니다.
        </p>
      </Section>
    </main>
  );
}

/** 앵커 구획 — 고정 헤더에 제목이 가리지 않게 위를 띄운다 */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-10 scroll-mt-20 [&_code]:font-mono [&_code]:text-[14px] [&_code]:font-semibold [&_li]:mt-1.5 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
      <h2 id={`${id}-title`} className="text-[19px] font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

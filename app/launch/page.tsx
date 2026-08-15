import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Launch with /nomorevibe — NoMoreVibe",
  description: "배포한 서비스를 AI 코딩 툴에서 한 번의 명령으로 등록하세요.",
};

export default function LaunchPage() {
  return (
    <main className="mx-auto max-w-[1080px] px-6 pb-20">
      <section className="pb-10 pt-16 text-center">
        <span className="inline-block rounded-full border border-accent bg-accent-soft px-[22px] py-2 font-mono text-[15px] font-bold text-[#c9c2ff]">
          /nomorevibe
        </span>
        <h1 className="mt-[22px] text-[34px] font-extrabold tracking-tight">
          AI로 만들었나요? 명령 한 번으로 등록하세요.
        </h1>
        <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-[1.7] text-fg-2">
          가입 폼도, SDK도 없습니다. 제품을 만든 AI 툴 — Claude Code, Codex — 안에서 슬래시 명령
          한 번이면 끝납니다.
        </p>

        <div className="mx-auto mt-9 max-w-[680px] overflow-hidden rounded-[14px] border border-line bg-[#0a0e16] text-left shadow-2xl">
          <div className="flex items-center gap-1.5 border-b border-line bg-bg-soft px-4 py-[11px]">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ea3943]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#f6b73c]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#16c784]" />
            <span className="ml-2.5 font-mono text-[11px] text-fg-3">스킬 설치</span>
          </div>
          <div className="px-6 py-5 font-mono text-[13px] leading-8 text-fg-2">
            <span className="font-bold text-fg">
              $ curl -fsSL {process.env.NEXT_PUBLIC_SITE_URL ?? "https://nomorevibe.app"}/install.sh | sh
            </span>
            <br />
            <span className="text-up">✓</span> Claude Code 스킬 설치됨{" "}
            <span className="text-fg-3">~/.claude/skills/nomorevibe/</span>
            <br />
            <span className="text-up">✓</span> Codex 프롬프트 설치됨{" "}
            <span className="text-fg-3">~/.codex/prompts/</span>
            <br />
            <br />
            <span className="text-fg-3"># 이제 프로젝트 폴더에서:</span>
            <br />
            <span className="font-bold text-fg">/nomorevibe</span>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          {
            n: "01",
            title: "AI가 정보를 수집합니다",
            body: "배포 URL만 알려주면, 방금 코드를 짠 그 AI가 README·랜딩 페이지·프로젝트 파일을 보고 이름, 소개, 스택을 정리합니다. 확인 후 등록됩니다.",
          },
          {
            n: "02",
            title: "도메인 소유권을 검증합니다",
            body: "AI가 /.well-known/nomorevibe.txt 파일을 프로젝트에 추가해줍니다. 재배포 후 /nomorevibe verify — 검증된 제품만 공개 목록에 오릅니다.",
          },
          {
            n: "03",
            title: "확인한 것만 보여줍니다",
            body: "검증한 척하지 않습니다. '만든 AI'는 메이커 신고로 표기되고, ✓ 표시는 우리가 직접 확인한 도메인 소유권에만 붙습니다.",
          },
        ].map((s) => (
          <div key={s.n} className="rounded-[14px] border border-line bg-bg-card p-[22px]">
            <div className="font-mono text-xs font-bold text-accent">{s.n}</div>
            <h3 className="mt-2 text-[15px] font-bold">{s.title}</h3>
            <p className="mt-2 text-[12.5px] leading-[1.7] text-fg-2">{s.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}

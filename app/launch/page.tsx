import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { pageTitle } from "@/lib/copy/brand";
import { LAUNCH_TITLE } from "@/lib/copy/terms";
import { LAUNCH_COMMAND, VERIFY_COMMAND, installCommand, installScript } from "@/lib/domain/products/launch-command";
import { siteOrigin } from "@/lib/site";
import { CopyCommand } from "./CopyCommand";

export const metadata: Metadata = {
  title: pageTitle(LAUNCH_TITLE),
  description: "배포한 서비스를 AI 코딩 툴에서 한 번의 명령으로 등록하세요.",
};

/** 명령 위 한 줄 — 어디서 실행하는지 */
function StepLabel({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[13px] text-fg-2">
      <span className="mr-1.5 font-mono font-bold text-fg">{n}.</span>
      {children}
    </p>
  );
}

export default async function LaunchPage() {
  // The public origin is a deployment setting. Wait for a request so the Docker
  // build cannot freeze a local/default URL into this otherwise-static page.
  await connection();
  const origin = siteOrigin();
  const install = installCommand(origin);

  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-20 sm:px-6">
      <section className="pb-10 pt-16 text-center">
        <span className="inline-block rounded-full border border-accent bg-accent-soft px-[22px] py-2 font-mono text-[15px] font-bold text-accent">
          {LAUNCH_COMMAND}
        </span>
        <h1 className="mt-[22px] text-[34px] font-extrabold tracking-tight">
          AI로 만들었나요? 명령 한 번으로 등록하세요.
        </h1>
        <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-[1.7] text-fg-2">
          가입 폼도, SDK도 없습니다. 제품을 만든 AI 툴 — Claude Code, Codex — 안에서 슬래시 명령
          한 번이면 끝납니다.
        </p>

        <div className="surface-dark mx-auto mt-9 max-w-[680px] overflow-hidden rounded-[12px] border border-line bg-[#0a0e16] text-left shadow-2xl">
          <div className="flex items-center gap-1.5 border-b border-line bg-bg-soft px-4 py-[11px]">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ea3943]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#f6b73c]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#16c784]" />
            <span className="ml-2.5 font-mono text-[13px] text-fg-2">스킬 설치</span>
          </div>
          <div className="px-4 py-5 sm:px-6">
            <StepLabel n={1}>터미널에서 한 번 설치</StepLabel>
            <CopyCommand command={install} label="설치 명령" prompt="$" />
            {/* 출력 예시 — 명령 칸 밖에 두고 흐리게, 복사 대상이 아님을 이름으로 밝힌다 */}
            <div className="mt-3 border-l-2 border-line pl-4 font-mono text-[13px] leading-7 text-fg-2">
              <p className="font-sans">출력 예시</p>
              <p className="overflow-x-auto whitespace-nowrap">
                <span className="text-up">✓</span> Claude Code 스킬 설치됨 ~/.claude/skills/nomorevibe/
              </p>
              <p className="overflow-x-auto whitespace-nowrap">
                <span className="text-up">✓</span> Codex 프롬프트 설치됨 ~/.codex/prompts/
              </p>
            </div>
            <div className="mt-6">
              <StepLabel n={2}>프로젝트 폴더의 Claude Code·Codex에서</StepLabel>
              <CopyCommand command={LAUNCH_COMMAND} label="등록 명령" />
            </div>
          </div>
        </div>

        <details className="mx-auto mt-4 max-w-[680px] text-left text-[13px] text-fg-2">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-accent-ink">스크립트 내용 보기 (/install.sh)</summary>
          <pre className="mt-2 overflow-x-auto rounded-[10px] border border-line bg-bg-soft p-4 font-mono text-[13px] leading-6 text-fg">{installScript(origin)}</pre>
          <p className="mt-2">
            설치 명령이 내려받아 실행하는 그대로입니다.{" "}
            <a className="text-accent-ink underline underline-offset-2" href="/install.sh">원본 열기</a>
          </p>
        </details>
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
            body: `AI가 /.well-known/nomorevibe.txt 파일을 프로젝트에 추가해줍니다. 재배포 후 ${VERIFY_COMMAND} — 검증된 제품만 공개 목록에 오릅니다.`,
          },
          {
            n: "03",
            title: "확인한 것만 보여줍니다",
            body: "검증한 척하지 않습니다. '만든 AI'는 메이커 신고로 표기되고, ✓ 표시는 우리가 직접 확인한 도메인 소유권에만 붙습니다.",
          },
        ].map((s) => (
          <div key={s.n} className="rounded-[12px] border border-line bg-bg-card p-[22px]">
            <div className="font-mono text-[13px] font-bold text-accent">{s.n}</div>
            <h3 className="mt-2 text-[15px] font-bold">{s.title}</h3>
            <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">{s.body}</p>
          </div>
        ))}
      </section>

      {/* 상세 페이지 운영자 상자의 '1분 만에 확인하기'가 여기로 온다(/launch#verify) */}
      <section id="verify" aria-labelledby="verify-title" className="mt-16 scroll-mt-28">
        <h2 id="verify-title" className="text-[22px] font-bold tracking-tight">운영자 확인하기</h2>
        <p className="mt-2 max-w-[640px] text-[15px] leading-[1.7] text-fg-2">
          직접 등록했거나 우리가 찾아 올린 프로젝트를 내 것으로 확인합니다. 확인되면 ✓ 표시가 붙고 소개를 고칠 수 있습니다.
        </p>
        <ol className="mt-6 grid max-w-[680px] grid-cols-1 gap-6">
          <li>
            <StepLabel n={1}>터미널에서 스킬 설치 — 한 번만 하면 됩니다</StepLabel>
            <CopyCommand command={install} label="설치 명령" prompt="$" />
          </li>
          <li>
            <StepLabel n={2}>프로젝트 폴더의 Claude Code·Codex에서 등록 명령</StepLabel>
            <CopyCommand command={LAUNCH_COMMAND} label="등록 명령" />
            <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">
              이미 올라와 있는 프로젝트면 AI가 알아보고 확인 파일(/.well-known/nomorevibe.txt)을 만들어 줍니다. 그 파일을 넣어 재배포하세요.
            </p>
          </li>
          <li>
            <StepLabel n={3}>재배포한 뒤 확인 명령</StepLabel>
            <CopyCommand command={VERIFY_COMMAND} label="확인 명령" />
            <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">
              사이트에서 확인 파일을 읽으면 끝납니다. 수정 키는 내 컴퓨터(~/.config/nomorevibe)에만 저장됩니다.
            </p>
          </li>
        </ol>
        {/* lib/domain/products/verify.ts — 설치형은 도메인 확인을 거절한다 */}
        <p className="mt-6 max-w-[680px] text-[13px] leading-[1.7] text-fg-2">
          웹사이트 없이 저장소로 내려받는 설치형 프로젝트는 도메인으로 확인할 수 없습니다. 저장소 주인 확인은 아래 웹 확인과 함께
          준비 중이며, 그동안은{" "}
          <Link prefetch={false} className="text-accent-ink underline underline-offset-2" href="/policy#contact">문의 방법</Link>을
          따라 주세요.
        </p>
      </section>

      <section aria-labelledby="no-cli-title" className="mt-16 max-w-[680px] rounded-[12px] border border-line bg-bg-card p-[22px]">
        <h2 id="no-cli-title" className="text-[17px] font-bold">CLI를 안 쓰나요?</h2>
        <p className="mt-2 text-[14px] leading-[1.7] text-fg">
          웹에서 GitHub로 로그인해 저장소를 고르는 등록·확인을 준비하고 있습니다. 아직은 열리지 않았습니다.
        </p>
        <p className="mt-4 text-[13px] font-medium text-fg-2">그동안은</p>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-[13px] leading-[1.7] text-fg-2">
          <li>
            Cursor·Lovable·v0 등으로 만들었어도 됩니다. 프로젝트 폴더에서 Claude Code나 Codex를 한 번 열고 위 명령을 실행하세요.
            AI가 정리한 소개를 보여 주고, 확인을 받은 뒤에만 등록합니다.
          </li>
          <li>
            공개 GitHub 저장소라면 우리가 이미 찾아 올렸을 수 있습니다. 위 검색에서 이름을 찾아보고, 있다면{" "}
            <a className="text-accent-ink underline underline-offset-2" href="#verify">운영자 확인하기</a> 순서를 따르세요.
          </li>
        </ul>
      </section>
    </main>
  );
}

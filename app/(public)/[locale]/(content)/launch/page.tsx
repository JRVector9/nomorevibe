import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { pageTitle } from "@/lib/copy/brand";
import { LAUNCH_COMMAND, VERIFY_COMMAND, installCommand, installScript } from "@/lib/domain/products/launch-command";
import { siteOrigin } from "@/lib/site";
import { CopyCommand } from "./CopyCommand";
import { getRequestLocale } from "@/lib/i18n/server";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import { localizedAlternates, localizedOpenGraph } from "@/lib/i18n/metadata";
import { DEFAULT_SHARE_IMAGE, shareMetadata } from "@/lib/copy/share";
import { trackAttrs, trackViewAttrs } from "@/lib/analytics/attrs";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "launch");
  const title = pageTitle(t("metadata.title")), description = t("metadata.description");
  const share = shareMetadata({ title, description, image: { ...DEFAULT_SHARE_IMAGE, alt: title } });
  return { ...share, title, description,
    robots: { index: true, follow: true }, alternates: localizedAlternates(locale, "/launch"),
    openGraph: { ...share.openGraph, ...localizedOpenGraph(locale) } };
}

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
  const locale = await getRequestLocale();
  const [t, launch] = await Promise.all([getTranslator(locale, "launch"), getDictionary(locale, "launch")]);
  const origin = siteOrigin();
  const install = installCommand(origin);

  return (
    <I18nProvider locale={locale} dictionaries={{ launch }}>
    <main className="mx-auto max-w-[1080px] px-4 pb-20 sm:px-6">
      <section className="pb-10 pt-16 text-center">
        {/* 글자는 accent-ink — accent 는 accent-soft 바탕 위 4.0:1 로 AA 미달, accent-ink 는 라이트 4.8:1·다크 5.5:1(A11Y-02) */}
        <span className="inline-block rounded-full border border-accent bg-accent-soft px-[22px] py-2 font-mono text-[15px] font-bold text-accent-ink">
          {LAUNCH_COMMAND}
        </span>
        <h1 className="mt-[22px] text-[34px] font-extrabold tracking-tight">
          {t("hero.heading")}
        </h1>
        <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-[1.7] text-fg-2">
          {t("hero.description")}
        </p>

        <div className="surface-dark mx-auto mt-9 max-w-[680px] overflow-hidden rounded-[12px] border border-line bg-[#0a0e16] text-left shadow-2xl"
          {...trackViewAttrs("launch_step_view", { step: "install", step_index: 1 })}>
          <div className="flex items-center gap-1.5 border-b border-line bg-bg-soft px-4 py-[11px]">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ea3943]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#f6b73c]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#16c784]" />
            <span className="ml-2.5 font-mono text-[13px] text-fg-2">{t("install.title")}</span>
          </div>
          <div className="px-4 py-5 sm:px-6">
            <StepLabel n={1}>{t("install.step")}</StepLabel>
            <CopyCommand command={install} label={t("command.install")} prompt="$" analytics={trackAttrs("skill_install_copy", { command: "install_sh" })} />
            {/* 출력 예시 — 명령 칸 밖에 두고 흐리게, 복사 대상이 아님을 이름으로 밝힌다 */}
            <div className="mt-3 border-l-2 border-line pl-4 font-mono text-[13px] leading-7 text-fg-2">
              <p className="font-sans">{t("output.title")}</p>
              <p className="overflow-x-auto whitespace-nowrap">
                <span className="text-up">✓</span> {t("output.claude", { path: "~/.claude/skills/nomorevibe/" })}
              </p>
              <p className="overflow-x-auto whitespace-nowrap">
                <span className="text-up">✓</span> {t("output.codex", { path: "~/.codex/prompts/" })}
              </p>
            </div>
            <div className="mt-6">
              <StepLabel n={2}>{t("install.launchStep")}</StepLabel>
              <CopyCommand command={LAUNCH_COMMAND} label={t("command.launch")} analytics={trackAttrs("launch_command_copy", { command_kind: "launch" })} />
            </div>
          </div>
        </div>

        <details className="mx-auto mt-4 max-w-[680px] text-left text-[13px] text-fg-2">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-accent-ink" {...trackAttrs("skill_script_view", { script: "install_sh" })}>{t("script.summary")}</summary>
          <pre className="mt-2 overflow-x-auto rounded-[10px] border border-line bg-bg-soft p-4 font-mono text-[13px] leading-6 text-fg">{installScript(origin)}</pre>
          <p className="mt-2">
            {t("script.description")}{" "}
            <a className="text-accent-ink underline underline-offset-2" href="/install.sh">{t("script.original")}</a>
          </p>
        </details>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3" {...trackViewAttrs("launch_step_view", { step: "how_it_works", step_index: 2 })}>
        {[
          {
            n: "01",
            title: t("steps.collectTitle"),
            body: t("steps.collectBody"),
          },
          {
            n: "02",
            title: t("steps.domainTitle"),
            // 직접 등록한 프로젝트 이야기다 — 공개 목록 전체가 검증된 것처럼 읽히지 않게(UX-05)
            body: t("steps.domainBody", { command: VERIFY_COMMAND }),
          },
          {
            n: "03",
            title: t("steps.badgeTitle"),
            body: t("steps.badgeBody"),
          },
        ].map((s) => (
          <div key={s.n} className="rounded-[12px] border border-line bg-bg-card p-[22px]">
            <div className="font-mono text-[13px] font-bold text-accent">{s.n}</div>
            {/* h1 다음 단계라 h2 — h3 로 건너뛰면 제목 목록이 비어 보인다(A11Y-05) */}
            <h2 className="mt-2 text-[15px] font-bold">{s.title}</h2>
            <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">{s.body}</p>
          </div>
        ))}
      </section>

      {/* 상세 페이지 운영자 상자의 '1분 만에 확인하기'가 여기로 온다(/launch#verify) */}
      <section id="verify" aria-labelledby="verify-title" className="mt-16 scroll-mt-28" {...trackViewAttrs("launch_step_view", { step: "verify", step_index: 3 })}>
        <h2 id="verify-title" className="text-[22px] font-bold tracking-tight">{t("verify.heading")}</h2>
        <p className="mt-2 max-w-[640px] text-[15px] leading-[1.7] text-fg-2">
          {t("verify.description")}
        </p>
        <ol className="mt-6 grid max-w-[680px] grid-cols-1 gap-6">
          <li>
            <StepLabel n={1}>{t("verify.installStep")}</StepLabel>
            <CopyCommand command={install} label={t("command.install")} prompt="$" analytics={trackAttrs("skill_install_copy", { command: "install_sh_verify" })} />
          </li>
          <li>
            <StepLabel n={2}>{t("verify.launchStep")}</StepLabel>
            <CopyCommand command={LAUNCH_COMMAND} label={t("command.launch")} analytics={trackAttrs("launch_command_copy", { command_kind: "launch" })} />
            <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">
              {t("verify.file")}
            </p>
          </li>
          <li>
            <StepLabel n={3}>{t("verify.finishStep")}</StepLabel>
            <CopyCommand command={VERIFY_COMMAND} label={t("command.verify")} analytics={trackAttrs("launch_command_copy", { command_kind: "verify" })} />
            <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">
              {t("verify.finish")}
            </p>
          </li>
        </ol>
        {/* lib/domain/products/verify.ts — 설치형은 도메인 확인을 거절한다 */}
        <p className="mt-6 max-w-[680px] text-[13px] leading-[1.7] text-fg-2">
          {t("verify.repoOnly")}{" "}
          <Link prefetch={false} className="text-accent-ink underline underline-offset-2" href={localePath(locale, "/policy#contact")}>{t("verify.contact")}</Link>{t("verify.contactAfter")}
        </p>
      </section>

      <section aria-labelledby="no-cli-title" className="mt-16 max-w-[680px] rounded-[12px] border border-line bg-bg-card p-[22px]" {...trackViewAttrs("launch_step_view", { step: "no_cli", step_index: 4 })}>
        <h2 id="no-cli-title" className="text-[17px] font-bold">{t("noCli.heading")}</h2>
        <p className="mt-2 text-[14px] leading-[1.7] text-fg">
          {t("noCli.description")}
        </p>
        <p className="mt-4 text-[13px] font-medium text-fg-2">{t("noCli.meanwhile")}</p>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-[13px] leading-[1.7] text-fg-2">
          <li>
            {t("noCli.otherTools")}
          </li>
          <li>
            {t("noCli.discovered")}{" "}
            <a className="text-accent-ink underline underline-offset-2" href="#verify">{t("verify.heading")}</a>{t("noCli.verifyAfter")}
          </li>
        </ul>
      </section>
    </main>
    </I18nProvider>
  );
}

/** README 상자 모양 — 발췌(서버)와 전문(브라우저)이 같은 상자를 쓴다. Tailwind 가 읽도록 글자 그대로 둔다 */
export const README_SCROLL = "max-h-[min(60vh,480px)] min-w-0 max-w-[720px] overflow-y-auto border-l-2 border-line pl-[18px] pr-3 text-[15px] leading-[1.6] text-fg [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const README_BODY = `${README_SCROLL} space-y-3 [&_a]:font-medium [&_a]:text-accent-ink [&_a:hover]:underline [&_h1]:mt-5 [&_h1]:text-[20px] [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-[18px] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-[16px] [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-3 [&_pre]:whitespace-pre-wrap [&_pre]:rounded-lg [&_pre]:bg-bg-soft [&_pre]:p-3 [&_pre]:text-[13px] [&_table]:w-full [&_table]:table-fixed [&_td]:border [&_td]:border-line [&_td]:p-2 [&_th]:border [&_th]:border-line [&_th]:p-2`;

export const README_HEADING = "m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2";
export const README_LINK = "inline-flex min-h-11 items-center self-start text-[13px] text-accent-ink hover:underline";

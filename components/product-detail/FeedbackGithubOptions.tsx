"use client";

type GithubOptions = { sendToGithub: boolean; githubDisclosureConsent: boolean };

export function FeedbackGithubOptions({ selected, consent, onChange, disabled = false }: {
  selected: boolean;
  consent: boolean;
  onChange: (values: GithubOptions) => void;
  disabled?: boolean;
}) {
  return (
    <details open={selected || undefined} className="border-t border-line pt-1 text-[13px]">
      <summary
        aria-disabled={disabled || undefined}
        className="min-h-11 cursor-pointer rounded py-3 text-fg-2"
        onClick={(event) => { if (disabled) event.preventDefault(); }}
        onKeyDown={(event) => { if (disabled && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
      >
        GitHub 이슈로도 보내기
        {selected && <span> · {consent ? "선택됨" : "공개 동의 필요"}</span>}
      </summary>
      <div className="space-y-1 pb-2">
        <label className="flex min-h-11 items-start gap-3 py-2 leading-5">
          <input
            type="checkbox"
            className="mt-1 shrink-0"
            disabled={disabled}
            checked={selected}
            onChange={(event) => onChange({ sendToGithub: event.target.checked, githubDisclosureConsent: false })}
          />
          제작자가 연결한 저장소에 앱 봇의 공개 이슈로 전달합니다.
        </label>
        {selected && <label className="flex min-h-11 items-start gap-3 py-2 leading-5">
          <input
            type="checkbox"
            className="mt-1 shrink-0"
            required
            disabled={disabled}
            checked={consent}
            onChange={(event) => onChange({ sendToGithub: true, githubDisclosureConsent: event.target.checked })}
          />
          닉네임·제목·댓글·원문 링크를 앱 봇 명의의 GitHub 공개 이슈로 보내는 데 별도로 동의합니다.
        </label>}
      </div>
    </details>
  );
}

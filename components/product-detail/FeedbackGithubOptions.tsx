"use client";

import { useTranslations } from "@/lib/i18n/context";
type GithubOptions = { sendToGithub: boolean; githubDisclosureConsent: boolean };

export function FeedbackGithubOptions({ selected, consent, onChange, disabled = false }: {
  selected: boolean;
  consent: boolean;
  onChange: (values: GithubOptions) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("detail");
  return (
    <details open={selected || undefined} className="border-t border-line pt-1 text-[13px]">
      <summary
        aria-disabled={disabled || undefined}
        className="min-h-11 cursor-pointer rounded py-3 text-fg-2"
        onClick={(event) => { if (disabled) event.preventDefault(); }}
        onKeyDown={(event) => { if (disabled && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
      >
        {t("feedback.github.send")}
        {selected && <span> · {consent ? t("feedback.github.selected") : t("feedback.github.consentNeeded")}</span>}
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
          {t("feedback.github.description")}
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
          {t("feedback.github.consent")}
        </label>}
      </div>
    </details>
  );
}

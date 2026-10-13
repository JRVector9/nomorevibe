"use client";

import { useTranslations } from "@/lib/i18n/context";
import type { FeedbackView } from "@/lib/domain/feedback/contract";

export function FeedbackDeliveryStatus({ feedback, compact = false }: { feedback: FeedbackView; compact?: boolean }) {
  const t = useTranslations("detail");
  if (compact && feedback.deliveryState === "local_only" && !feedback.githubIssueUrl) return null;

  return <>
    <span>{t(`delivery.${feedback.deliveryState}`)}</span>
    {feedback.githubIssueUrl && <> · <a href={feedback.githubIssueUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{t("delivery.issue")}</a>
      {feedback.externalIssueState && <span> · {t("delivery.external", { state: t(`issue.${feedback.externalIssueState}`) })}</span>}</>}
    {!compact && feedback.lastErrorCode && <span> · {t("delivery.code", { code: feedback.lastErrorCode })}</span>}
  </>;
}

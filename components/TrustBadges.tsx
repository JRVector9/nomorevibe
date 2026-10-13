"use client";

import { useTranslations } from "@/lib/i18n/context";
import type { ProductStatus } from "@/lib/db/schema";
import type { BuilderClaim } from "@/lib/domain/products/view";

/**
 * 신뢰 근거 배지.
 *
 * 목록과 상세가 같은 문구를 써야 한다. 한쪽만 고치면 같은 제품이 화면마다
 * 다른 신뢰도로 보인다.
 */

/**
 * 상태 배지. ✓ 는 우리가 직접 확인한 도메인 소유권에만 붙는다.
 *
 * 운영자 미확인과 미검증은 다르다 — 전자는 주인이 아직 없는 것이고,
 * 후자는 주인이 등록해놓고 검증을 안 끝낸 것이다.
 */
export function StatusBadge({
  status,
  unclaimed,
  size = "sm",
}: {
  status: ProductStatus;
  unclaimed: boolean;
  size?: "sm" | "md";
}) {
  const t = useTranslations("labels");
  const md = size === "md";
  const shell = md ? "rounded-full px-2.5 py-0.5 text-[13px] border" : "text-[13px]";

  if (status === "verified") {
    return (
      <span
        className={`shrink-0 font-semibold text-up ${shell} ${md ? "border-up/40 bg-up/10" : ""}`}
        title={t("status.verifiedHint")}
      >
        ✓ {t(md ? "status.domainVerified" : "status.verified")}
      </span>
    );
  }

  const [label, tip] = unclaimed
    ? ([t("status.unclaimed"), t("status.unclaimedHint")] as const)
    : ([t("status.unverified"), t("status.unverifiedHint")] as const);

  return (
    <span
      className={`shrink-0 font-semibold text-fg-2 ${shell} ${md ? "border-line bg-bg-soft" : ""}`}
      title={tip}
    >
      {label}
    </span>
  );
}

/**
 * "만든 AI" 배지.
 *
 * 어느 쪽도 기술적으로 검증할 수 없으므로 검증한 척하지 않고 근거를 밝힌다.
 * 메이커가 신고한 것과 우리가 추정한 것은 신뢰도가 다르다.
 */
export function BuilderBadge({ builder, claim }: { builder: string; claim: BuilderClaim }) {
  const t = useTranslations("labels");
  const guessed = claim === "guessed";
  if (guessed) return <span className="rounded-full border border-line bg-bg-soft px-2 py-0.5 text-[13px] font-semibold text-fg-2"
    title={t("status.aiUnknownHint")}>{t("status.aiUnknown")}</span>;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[13px] font-semibold ${
        guessed
          ? "border border-line bg-bg-soft text-fg-2"
          : "border border-accent/35 bg-accent-soft text-accent"
      }`}
      title={
        guessed
          ? t("status.aiUnknownHint")
          : t("status.builderReportedHint")
      }
    >
      ● {builder}
      <span className="ml-1 font-normal text-fg-2">{t(guessed ? "status.aiUnknown" : "status.builderReported")}</span>
    </span>
  );
}

import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { repositoryOperator } from "@/lib/domain/products/github-owner";
import { getTranslator } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { getRequestLocale } from "@/lib/i18n/server";
import type { FollowTarget } from "@/lib/me/contract";
import { makerKey } from "@/lib/me/follow-keys";
import { FollowButton, type FollowVariant } from "./FollowButton";
import { followLabels } from "./follow-labels";

/** 서버 화면에 다는 팔로 단추 하나. 로그인 기능이 꺼져 있으면 그리지 않는다 */
export async function FollowSlot({ target, targetKey, name, variant }: { target: FollowTarget; targetKey: string; name: string; variant?: FollowVariant }) {
  if (!publicUserAuthEnabled()) return null;
  const locale: Locale = await getRequestLocale();
  const t = await getTranslator(locale, "me");
  const aria = target === "product" ? t("follow.product", { name }) : target === "maker" ? t("follow.maker", { login: name }) : t("follow.category", { category: name });
  return <FollowButton target={target} targetKey={targetKey} labels={followLabels(t, aria)} variant={variant} />;
}

/** 상세 머리의 두 자리 — 단추 줄의 프로젝트 팔로, 메타 줄 GitHub 주인 옆의 메이커 팔로. 주인은 머리가 보여 주는 계정과 같다 */
export function productFollowSlots(product: { id: number; name: string; repoUrl: string | null }, repositoryUrl: string | null) {
  if (!publicUserAuthEnabled()) return undefined;
  const owner = repositoryOperator(product.repoUrl, repositoryUrl)?.owner ?? null;
  const key = makerKey(owner?.login);
  return {
    project: <FollowSlot target="product" targetKey={String(product.id)} name={product.name} />,
    maker: owner && key ? <FollowSlot target="maker" targetKey={key} name={owner.login} variant="inline" /> : null,
  };
}

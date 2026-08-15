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
 * 미클레임과 미검증은 다르다 — 전자는 주인이 아직 없는 것이고,
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
  const md = size === "md";
  const shell = md ? "rounded-full px-2.5 py-0.5 text-[11px] border" : "text-[11px]";

  if (status === "verified") {
    return (
      <span
        className={`shrink-0 font-semibold text-up ${shell} ${md ? "border-up/40 bg-up/10" : ""}`}
        title="도메인 소유권을 NoMoreVibe가 직접 확인했습니다."
      >
        ✓ {md ? "도메인 검증됨" : "검증됨"}
      </span>
    );
  }

  const [label, tip] = unclaimed
    ? (["미클레임", "우리가 찾아서 올린 제품입니다. 아직 주인이 확인해주지 않았습니다."] as const)
    : (["미검증", "등록은 됐지만 도메인 소유권 확인이 끝나지 않았습니다."] as const);

  return (
    <span
      className={`shrink-0 font-semibold text-fg-3 ${shell} ${md ? "border-line bg-bg-soft" : ""}`}
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
  const guessed = claim === "guessed";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
        guessed
          ? "border border-line bg-bg-soft text-fg-2"
          : "border border-accent/35 bg-accent-soft text-[#b8b0ff]"
      }`}
      title={
        guessed
          ? "공개 저장소의 흔적을 보고 우리가 추정한 값입니다. 아무도 확인해주지 않았습니다."
          : "메이커가 신고한 값입니다. 기술적으로 검증할 방법은 없습니다."
      }
    >
      ● {builder}
      <span className="ml-1 font-normal text-fg-3">{guessed ? "우리 추정" : "메이커 신고"}</span>
    </span>
  );
}

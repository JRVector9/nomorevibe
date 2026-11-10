import { delegateConfidenceText, delegateOpinionText, type DelegateOpinion } from "@/lib/crawl/delegate-groups";
import { formatDetailTime } from "@/lib/format/time";
import { ReasonText } from "./ReasonText";

const tone = (opinion: DelegateOpinion) => {
  const decision = opinion.model?.decision ?? opinion.applied;
  return decision === "approve" ? "green" : decision === "reject" ? "red" : "amber";
};

/**
 * 상세의 「AI 위임 검수」 판단 — 사람 몫 위임 검수(human-deepseek-review)가 남긴 의견·확신·남긴 까닭·사유.
 * 근거 부족·확신 부족 목록에서 사람이 이것과 근거를 나란히 보고 바로 승인·반려한다. 이전 원본의 판단이면 그렇게 적는다.
 */
export function DelegateOpinionBox({ opinion }: { opinion: DelegateOpinion }) {
  const text = delegateOpinionText(opinion);
  return <div className="evidence-box" data-delegate-opinion>
    <b>{`AI 위임 검수 · ${opinion.modelName ?? "모델 —"} · ${opinion.current ? "지금 원본 기준" : "이전 원본·세대 기준 — 지금 원본은 아직 위임 판단 없음"}`}</b>
    <p><span className={`tag ${tone(opinion)}`}>{text.leaning}</span>{` ${delegateConfidenceText(opinion.confidence)} · ${text.cause}`}</p>
    <p>{opinion.reason ? <ReasonText text={opinion.reason} korean={opinion.reasonKo} limit={400} /> : "기록된 판단 사유 —"}</p>
    <p className="small muted">{`판단 ${formatDetailTime(opinion.at)}`}</p>
  </div>;
}

/** 목록 줄의 짧은 표지 — 위임 검수의 의견과 확신. 이전 원본의 판단은 줄에서 빼고 상세에서만 보인다 */
export function DelegateOpinionTag({ opinion }: { opinion: DelegateOpinion | null | undefined }) {
  if (!opinion?.current) return null;
  const text = delegateOpinionText(opinion);
  return <p className="small" data-delegate-tag>{`AI 위임 ${text.leaning} · ${delegateConfidenceText(opinion.confidence)}`}</p>;
}

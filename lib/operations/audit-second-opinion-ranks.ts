import { AUDIT_SECOND_OPINION_TASK } from "@/lib/llm/ai-tasks";
import { aiConnectionBaseUrl, aiConnectionHost, aiSameUnderlyingModel, type AiConnectionView, type AiRankChoice } from "./admin-ai-tasks";

/**
 * 감사 두 번째 의견 순위의 저장 규칙(2026-11-17, PR #988 이어서) — 순수(DB·env 를 읽지 않는다. 기본 설정은 부른 쪽이 qwenDirectConfig 로 넘긴다).
 *
 * 실행 쪽은 1순위를 이 순위가 아니라 기본 Qwen 직접 설정(qwenDirectConfig)에서 읽는다. 1순위를 기본 설정과 다르게 저장해 두면 화면이 「실행 모델이 바뀌었다」고
 * 오해하게 만들 뿐 실제 호출은 그대로라서, 경고가 아니라 거절한다(덜 위험한 쪽). 2·3순위는 변경 재판정 거절을 1순위와 같은 모델이 냈을 때만 그 항목의 두 번째
 * 의견에 쓴다(lib/crawl/rejudge-second-opinion-models.ts) — 기본 모델과 같은 모델(다른 서버라도)은 독립 의견이 아니어서 실행 쪽이 건너뛰므로 저장도 막는다.
 * 순위를 모두 비우는 것은 받는다(그때 실행 쪽은 다른 모델을 고르지 않는다 = PR #988 전과 같다).
 */
export type AuditSecondOpinionDefault = Readonly<{ baseUrl: string; model: string }> | null;

const sameBase = (a: string | null | undefined, b: string | null | undefined) => {
  const left = a ? aiConnectionBaseUrl(a) : null, right = b ? aiConnectionBaseUrl(b) : null;
  return !!left && left === right;
};

export function auditSecondOpinionRankIssues(ranks: readonly (AiRankChoice | null)[], connections: readonly Pick<AiConnectionView, "id" | "label" | "baseUrl">[],
  primary: AuditSecondOpinionDefault): string[] {
  const chosen = ranks.flatMap((row, index) => row ? [{ rank: index + 1, row }] : []);
  if (!chosen.length) return [];
  if (!primary) return ["감사 두 번째 의견의 기본 Qwen 직접 설정(AUDIT_SECOND_OPINION_URL·MODEL 또는 등록부 direct-review)을 이 프로세스가 읽지 못해 1순위를 확인할 수 없습니다. "
    + "기본 설정을 읽는 웹·워커 컨테이너에서 다시 저장하세요."];
  const issues: string[] = [];
  const defaultText = `${aiConnectionHost(aiConnectionBaseUrl(primary.baseUrl)) ?? primary.baseUrl} · ${primary.model}`;
  const first = chosen.find(entry => entry.rank === 1);
  const firstConnection = first ? connections.find(entry => entry.id === first.row.provider) : undefined;
  if (!first || first.row.model !== primary.model || !sameBase(firstConnection?.baseUrl, primary.baseUrl))
    issues.push(`1순위는 기본 Qwen 직접 설정(${defaultText})과 같은 서버·모델이어야 합니다 — 감사 두 번째 의견의 1순위는 실행 쪽이 이 순위가 아니라 기본 설정에서 읽으므로, `
      + "다르게 저장하면 실행 모델이 바뀐다고 오해하게 됩니다. 기본 모델을 바꾸려면 감사 설정(기본 Qwen 직접 설정)에서 바꾸세요.");
  for (const entry of chosen) {
    if (entry.rank === 1 || !aiSameUnderlyingModel(entry.row.model, primary.model)) continue;
    issues.push(`${entry.rank}순위: 기본 모델(${primary.model})과 같은 모델이라 독립된 두 번째 의견이 되지 않습니다. 다른 계열의 모델을 고르세요.`);
  }
  return issues;
}

/** 저장 결과에 싣는 설명 — 저장된 순위가 실행에 무엇을 하는지(화면 결과·CLI 출력). 감사 두 번째 의견이 아니면 null */
export function auditSecondOpinionSavedScope(taskId: string, ranks: readonly (AiRankChoice | null)[],
  connections: readonly Pick<AiConnectionView, "id" | "label">[]): string | null {
  if (taskId !== AUDIT_SECOND_OPINION_TASK) return null;
  const name = (row: AiRankChoice) => `${connections.find(entry => entry.id === row.provider)?.label ?? "지워진 연결"} · ${row.model}`;
  const [first, ...rest] = ranks.filter((row): row is AiRankChoice => !!row);
  if (!first) return "순위를 비웠습니다 — 변경 재판정 거절도 기본 Qwen 직접 설정 하나로만 두 번째 의견을 묻습니다(다른 모델을 고르지 않습니다).";
  return `1순위 ${name(first)}은(는) 기본 Qwen 직접 설정과 같아 실행 모델이 바뀌지 않습니다. `
    + (rest.length ? `${rest.map((row, index) => `${index + 2}순위 ${name(row)}`).join(", ")}은(는) 변경 재판정 거절을 1순위와 같은 모델이 냈을 때 그 항목의 두 번째 의견에만 씁니다.`
      : "2순위가 없어 변경 재판정 거절에 다른 모델을 고르지 않습니다.")
    + " 공개분 추가 검수와 다른 감사 의견은 그대로입니다.";
}

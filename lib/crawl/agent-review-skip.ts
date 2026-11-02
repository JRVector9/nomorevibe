/**
 * 1차 심사 틱이 들인 후보를 모두 이름 붙은 까닭(crawl.agent_review_skipped)으로 건너뛰고 호출·진전이 없을 때 돌려주는 degraded 코드.
 * 잡(lib/crawl/jobs/agent-review.ts)이 쓰고, 진행 감시(lib/operations/worker-progress-query.ts)가 job:crawl-agent-review 관측에서 읽는다.
 * 무거운 잡 모듈을 감시 쪽으로 끌어오지 않게 따로 둔다.
 */
export const AGENT_REVIEW_ALL_SKIPPED = "agent_review_all_skipped";

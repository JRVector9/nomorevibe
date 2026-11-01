/**
 * 글 짓는 잡(crawl-tagline·product-search-profile·product-search-verify)이 "엔진이 모든 항목에 대해 내려갔다"를 가르는 기준 —
 * 2026-10-31 소유자 결정 "하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다".
 *
 * 한 항목의 실패(시간 초과·429·5xx·형식 오류·입력 초과)는 그 항목의 시도로만 남고(attempts+1·retry_at), 틱은 다음 항목으로 간다.
 * 예전에는 GATEWAY_DOWN 두 번이면 틱을 접었는데, 게이트웨이 5xx 는 한 후보의 긴 글에만 나기도 했고(2026-09-20 실측) 시간 초과는 붐빔일 뿐이라
 * 둘로 "내려갔다"를 증명할 수 없었다 — 그 두 건이 나머지 수십 건의 차례를 매 틱 미뤘다.
 *
 * 틱을 접는 것은 공유 경로를 사용할 수 없거나 안전한 전송의 필수 조건을 확인할 수 없을 때다:
 *  - 설정 오류(`no_key`·`model_unavailable`): 키가 없거나 모델이 없다 — 한 번의 답으로 모든 항목에 대해 증명된다.
 *  - 필수 tokenizer 증거 없음(`tokenizer_unavailable`): 입력 초과 판정이 아니다. 이 틱의 추가 전송은 멈추고 기존 backoff 뒤 다시 확인한다.
 *    이 코드만으로 엔진 프로세스 중단을 증명하거나 재시작 권한을 주지는 않는다.
 *  - 연결 거절(`network`): 닿지 않는다 — 한 번은 한 요청의 끊김일 수 있어, 사이에 성공 없이 ENGINE_DOWN_STREAK 번 잇달아야 한다.
 * 시간 초과(`timeout`)·429(`rate_limit`)·5xx 는 여기에 없다 — 붐빔이거나 그 입력의 일이라 항목의 실패로만 남고 다음 항목을 본다.
 * 틱의 길이는 러너 예산이 막는다(tick-deadline.ts).
 */
export const ENGINE_DOWN_STREAK = 3;
const PROVEN_BY_ONE = new Set(["no_key", "model_unavailable", "tokenizer_unavailable"]);
const PROVEN_BY_STREAK = new Set(["network"]);

export class EngineDownTally {
  private streak = 0;
  /** 공유 경로의 이 틱을 미뤄야 하면 그 오류를, 항목의 실패만이면 null 을 돌려준다. 프로세스 복구 권한은 아니다. */
  failed(error: string): string | null {
    if (PROVEN_BY_ONE.has(error)) return error;
    if (!PROVEN_BY_STREAK.has(error)) { this.streak = 0; return null; }
    return ++this.streak >= ENGINE_DOWN_STREAK ? error : null;
  }
  /** 엔진이 답했다(성공이든 그 항목의 실패든) — 연결 거절 연속을 처음부터 센다 */
  answered(): void { this.streak = 0; }
}

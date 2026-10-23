export const LOCAL_MODEL_RELAY_PROTOCOL = 1;
export const LOCAL_MODEL_UPSTREAM_HOST = "127.0.0.1";
export const LOCAL_MODEL_UPSTREAM_PORT = 8000;
export const LOCAL_MODEL_RELAY_REQUEST_HEADER = "x-nmv-relay-request-id";

export type RelayTerminalObservation = {
  models: string[];
  finishReasons: string[];
  usage: Record<string, unknown> | null;
  /** 실제로 읽은 SSE [DONE]이다. 없는 값을 만들어 넣지 않는다. */
  streamDone: boolean;
  observerComplete: boolean;
};

/** HTTP 관측 기록이며 capacity의 불투명 native terminal 증인이 아니다. */
export type RelayReceipt = {
  protocol: 1;
  requestId: string;
  relayGeneration: string;
  relayRevision: string;
  deploymentRevision: string;
  requestModel: string;
  requestHash: string;
  startedAt: string;
  state: "in_flight" | "response_complete" | "indeterminate";
  endedAt: string | null;
  upstreamStatus: number | null;
  responseHash: string | null;
  responseBytes: number;
  terminal: RelayTerminalObservation | null;
  error: "upstream_error" | "upstream_timeout" | "receipt_write_failed" | null;
};

export type RelayReadinessContext = {
  relayRevision: string;
  deploymentRevision: string;
  model: string;
  indeterminate: boolean;
  activeRequestId: string | null;
  lastReceipt: RelayReceipt | null;
};

/** PR02가 실제 서버 계약 검증을 연결하는 자리다. env boolean은 받지 않는다. */
export type RelayNativeReadinessVerifier = (context: Readonly<RelayReadinessContext>) => {
  ready: boolean;
  contractHash: string | null;
  reason: string;
};

export const validRelayRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

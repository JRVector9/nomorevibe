export type RejectedRerunTarget = {
  repo: string;
  inputHash: string;
  sourceRevisionHash: string;
  candidateRevisionHash: string;
};

export type RejectedRerunSnapshot = {
  query: string;
  upperId: number;
  afterId: number;
  startedAt: string;
  total: number;
  processed: number;
  queued: number;
  skipped: number;
  skipReasons?: Record<string, number>;
};

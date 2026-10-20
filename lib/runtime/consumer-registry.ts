/**
 * 건 단위 일꾼(consumer) 등록부. consumer 는 역할 lease 없이 같은 큐를 claim 으로 나눠 맡는 프로세스다.
 * 이름 하나가 부모 역할(감독·host DB 장부·관측 키 service:<역할>:<이름>-consumer-<자리>), 감독이 띄우는 고정 자식 명령,
 * 자식 worker pool 상한을 정한다. 이 파일은 아무것도 import 하지 않는다(운영센터 화면도 읽는다).
 *
 * 새 일꾼은 여기에 한 줄을 더한다. Oracle 에서 돌리려면 같은 이름을 deploy/oracle/launch.py CONSUMERS(부모 역할),
 * lib/runtime/oracle-db-profile.ts ORACLE_CONSUMER_DB_PROFILES(DB 계정), lib/runtime/oracle-consumer-preflight.ts
 * ORACLE_CONSUMER_READINESS(준비 확인)에도 더한다. 하나라도 빠지면 Oracle 실행은 닫힌 채로 남는다.
 */
export type ConsumerParentRole = 'crawler' | 'reviewer' | 'publisher' | 'text' | 'maintenance'
  | 'translation' | 'product-health' | 'site-evidence' | 'official-news';
export type ConsumerSpec = {
  role: ConsumerParentRole;
  /** worker-supervisor 가 `node --import tsx` 뒤에 붙이는 고정 인자. 감독은 여기에 --once 만 더한다 */
  command: readonly string[];
  /** 자식 worker 의 primary pool 상한(host DB 장부 선언). 부모(감독)는 늘 1 이다 */
  workerMax: number;
};

export const CONSUMERS = {
  ai1: { role: 'reviewer', command: ['scripts/pipeline-first-consumer.ts'], workerMax: 3 },
  ai2: { role: 'reviewer', command: ['scripts/pipeline-consumer.ts', '--stage=ai2'], workerMax: 3 },
  // split-v1 제품 연결 확인(design-uptime §7.2). 부모는 uptime-ping 잡과 같은 maintenance. 자식 pool 2 = 제출(직렬) 1 + claim·제어 읽기·관측 1
  uptime: { role: 'maintenance', command: ['scripts/uptime-consumer.ts'], workerMax: 2 },
  // 제작 근거 스캔(agent_repository_claims). 수집 일꾼이 crawler 와 같은 GitHub 자격을 쓰므로 부모는 crawler 다
  'agent-scan': { role: 'crawler', command: ['scripts/agent-scan-consumer.ts'], workerMax: 3 },
} as const satisfies Record<string, ConsumerSpec>;
export type ConsumerName = keyof typeof CONSUMERS;

export function consumerNames(): ConsumerName[] {
  return Object.keys(CONSUMERS) as ConsumerName[];
}
export function consumerSpec(name: string): ConsumerSpec | undefined {
  return Object.hasOwn(CONSUMERS, name) ? CONSUMERS[name as ConsumerName] : undefined;
}
/** consumer 의 SERVICE_INSTANCE_ID 는 이 접두로 시작한다(예: ai1-consumer-m3). 감독·health·관측이 이것으로 갈래를 나눈다 */
export function consumerInstancePrefix(name: string): string {
  return `${name}-consumer-`;
}
/** 인스턴스 이름이 등록된 consumer 접두로 시작하면 그 이름. 관측·파일 경로를 고르는 데만 쓴다 — 권한이 아니다 */
export function consumerOfInstance(instanceId: string | null | undefined): ConsumerName | null {
  if (!instanceId) return null;
  return consumerNames().find(name => instanceId.startsWith(consumerInstancePrefix(name))) ?? null;
}

export const DEFAULT_ROLE_HEALTH_PATH = '/tmp/nomorevibe-role-health.json';
/**
 * role-worker 가 스스로 회복하지 못한 것으로 보는 한도. DB 선출·갱신이 이만큼 연속 실패(throw)하거나 한 호출이 이만큼 끝나지 않거나,
 * 선출된 versioned 역할의 claim 관문이 이만큼 막혀 있으면 health 가 unhealthy 다(컨테이너 재시작). 연속 실패는 role-worker 도 깨끗이 끝낸다(exit 1).
 * 2026-10-17 M3: DB 경로가 5시간 끊긴 뒤 복구됐는데 acquire 가 계속 실패해 수동 재시작했다. 5분은 lease TTL 45초·standby grace 20초·
 * pool 대기 5초·재시도 5초·선출 TX 상한(lock 5초·statement 10초)보다 충분히 길어 일시 장애로는 재시작하지 않는다.
 */
export const ROLE_STUCK_UNHEALTHY_MS = 5 * 60_000;

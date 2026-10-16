import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 배경 consumer lane(PR06c) 안에서만 켜지는 표시. 권한은 주지 않는다 — 공통 슬롯 밖 경로(control disabled 의 원 호출)를
 * 고르는 지점(readModelCapacityCallerControl)이 이 범위에서는 호출 대신 typed defer 로 끝나게 할 뿐이다.
 * 같은 프로세스의 기존 job 줄은 이 범위 밖이라 disabled 원 경로를 그대로 쓴다.
 */
const slotOnly = new AsyncLocalStorage<true>();
export function withSlotOnlyModelCapacity<T>(run: () => Promise<T>): Promise<T> { return slotOnly.run(true, run); }
export function slotOnlyModelCapacity(): boolean { return slotOnly.getStore() === true; }

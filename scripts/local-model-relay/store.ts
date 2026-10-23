import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validRelayRequestId, type RelayReceipt } from "./protocol";

export type RelayReceiptStore = {
  hasUnsettled: () => boolean;
  get: (id: string) => RelayReceipt | null;
  begin: (receipt: RelayReceipt) => void;
  finish: (receipt: RelayReceipt) => void;
};

/** active 표시는 요청 전 저장하고 정상 HTTP 종료 뒤에만 지운다. 재시작이 unknown을 풀지 않는다. */
export function fileRelayReceiptStore(directory: string): RelayReceiptStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const active = path.join(directory, "active.json");
  const file = (id: string) => {
    if (!validRelayRequestId(id)) throw new Error("invalid_request_id");
    return path.join(directory, `${id}.json`);
  };
  const write = (receipt: RelayReceipt) => {
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(receipt) + "\n", { mode: 0o600, flag: "wx", flush: true });
    renameSync(temporary, file(receipt.requestId));
  };
  return {
    hasUnsettled: () => existsSync(active),
    get: (id) => {
      const target = file(id);
      if (!existsSync(target)) return null;
      return JSON.parse(readFileSync(target, "utf8")) as RelayReceipt;
    },
    begin: (receipt) => {
      if (existsSync(file(receipt.requestId))) throw new Error("duplicate_request_id");
      writeFileSync(active, JSON.stringify({ requestId: receipt.requestId, relayGeneration: receipt.relayGeneration }), { mode: 0o600, flag: "wx", flush: true });
      write(receipt);
    },
    finish: (receipt) => {
      write(receipt);
      if (receipt.state !== "response_complete") return;
      const pending = JSON.parse(readFileSync(active, "utf8")) as { requestId?: string };
      if (pending.requestId !== receipt.requestId) throw new Error("active_request_mismatch");
      unlinkSync(active);
    },
  };
}

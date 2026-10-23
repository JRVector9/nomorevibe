import type { RelayTerminalObservation } from "./protocol";
import { StringDecoder } from "node:string_decoder";

/** 응답을 바꾸지 않고 작은 종료·usage 필드만 관측한다. 큰 본문/불완전 JSON은 증인으로 승격하지 않는다. */
export function relayResponseObserver(streaming: boolean) {
  let pending = "", observedBytes = 0, failed = false, streamDone = false;
  const decoder = new StringDecoder("utf8");
  const models = new Set<string>(), finishReasons = new Set<string>();
  let usage: Record<string, unknown> | null = null;
  const accept = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) { failed = true; return; }
    const object = value as Record<string, unknown>;
    if (typeof object.model === "string") models.add(object.model);
    if (object.usage && typeof object.usage === "object" && !Array.isArray(object.usage)) usage = object.usage as Record<string, unknown>;
    if (Array.isArray(object.choices)) for (const row of object.choices) {
      if (row && typeof row === "object" && typeof row.finish_reason === "string") finishReasons.add(row.finish_reason);
    }
  };
  const parse = (text: string) => {
    try { accept(JSON.parse(text)); } catch { failed = true; }
  };
  return {
    chunk: (chunk: Buffer) => {
      observedBytes += chunk.length;
      if (observedBytes > 1024 * 1024) { failed = true; pending = ""; return; }
      pending += decoder.write(chunk);
      if (!streaming) return;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") streamDone = true;
        else if (data) parse(data);
      }
    },
    end: (): RelayTerminalObservation => {
      pending += decoder.end();
      if (!streaming && !failed) parse(pending);
      if (streaming && pending.trim()) failed = true;
      return { models: [...models], finishReasons: [...finishReasons], usage, streamDone, observerComplete: !failed };
    },
  };
}

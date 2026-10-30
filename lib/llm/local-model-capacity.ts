import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalModelInput } from "./local-model-input";
import type { JobLease } from "@/lib/jobs/control";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { readModelCapacityCallerControl, findOwnPendingModelRequest, requestLocalModelSlot, dispatchLocalModelCapacity,
  cancelReservedModelSlot, cancelOwnPendingLocalModelRequest, markModelDispatchIndeterminate, reconcileGatewayNotStarted, reconcileLocalModelTerminal } from "./capacity-repository";
import { markUnsettledDispatch } from "./capacity-unsettled";
import { freshLocalModelScreenProof, localModelScreenProofSchema, localModelBindingSchema, localModelLogicalKey, localModelRoute,
  localModelTargetSchema, type LocalModelScreenProof, type LocalModelTarget } from "./local-model-capacity-contract";
import { localModelContractHash, localModelServingContractsSchema, resolveLocalModelServingContract,
  localModelThinkingFields, type LocalModelServingContract } from "./local-model-serving-contract";
import { modelCapacityRequestIdentitySchema, type ModelCapacityPolicy } from "./capacity";
import { requestReservedLocalModel } from "./local-model-terminal";
import { GatewayNotSentError } from "./gateway-not-started";
import { recordLocalModelWireObservation } from "./local-model-wire-observation";

type Env = Readonly<Record<string, string | undefined>>;
export type LocalModelCallContext = {
  target: LocalModelTarget; input: LocalModelInput; lease: JobLease; promptVersion: string;
  env?: Env; allowLegacy?: boolean;
  /** Assist alone may await admission with its original prepared input and caller deadline. Never retries model HTTP. */
  waitForCapacity?: boolean;
  /** Absolute admission cutoff supplied by the bounded assist job, before its dispatch headroom. */
  admissionDeadlineAt?: number;
  screenProof?: LocalModelScreenProof;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** 운영 readback으로 확인한 정확한 계약 hash만 인정한다. 설정의 모양 통과와 확인됨을 구분한다. */
export function verifiedLocalModelContract(url: string, model: string, env: Env = process.env): LocalModelServingContract | null {
  try {
    const contracts = localModelServingContractsSchema.parse(JSON.parse(env.LOCAL_MODEL_SERVING_CONTRACTS ?? "null"));
    const matches = contracts.filter(contract => contract.endpoint === url && contract.model === model);
    if (matches.length !== 1) return null;
    const contract = resolveLocalModelServingContract(matches[0].backendId, env);
    const verified: unknown = JSON.parse(env.LOCAL_MODEL_VERIFIED_CONTRACT_HASHES ?? "null");
    return contract && object(verified) && verified[contract.backendId] === localModelContractHash(contract) ? contract : null;
  } catch { return null; }
}

/** route 하나의 실제 정책 매핑을 확인한다. 전역 활성 caller 전부의 준비를 뜻하지 않는다. */
export function localModelRouteReady(policy: ModelCapacityPolicy | null, target: LocalModelTarget, contract: LocalModelServingContract,
  env: Env = process.env): boolean {
  let limits: unknown;
  try { limits = JSON.parse(env.LOCAL_MODEL_PHYSICAL_LIMITS ?? "null"); } catch { return false; }
  const limit = object(limits) ? limits[contract.physicalGroup] : undefined;
  return Boolean(policy?.routes.some(route => route.routeId === localModelRoute(target) && route.provider === "local-direct"
    && route.model === contract.model && route.providerBudgetId === contract.backendId && route.groupId === contract.physicalGroup)
    && policy.providerLimits[contract.backendId] && policy.groupLimits[contract.physicalGroup]
    && typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && policy.groupLimits[contract.physicalGroup] <= limit);
}

/** 모델 wrapper가 통신 예외를 다른 코드로 바꿔도 capacity defer는 원래 의미로 복원한다.
 * fetch를 주입하는 기존 단위 테스트와 disabled의 wire는 그대로이며, 새 작업은 allowLegacy=false다. */
export async function withLocalModelCapacity<T>(value: LocalModelCallContext,
  run: (request: typeof fetch) => Promise<T>, baseRequest?: typeof fetch): Promise<T> {
  const env = value.env ?? process.env;
  const context = { ...value, target: structuredClone(value.target), input: structuredClone(value.input), lease: structuredClone(value.lease),
    ...(value.screenProof ? { screenProof: structuredClone(value.screenProof) } : {}) };
  let deferred: ModelCapacityDeferredError | null = null;
  let controlError: unknown;
  let sent = false;
  const request = (async (urlValue: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    if (sent) throw new Error("local_model_call_reused");
    sent = true;
    const url = typeof urlValue === "string" ? urlValue : urlValue instanceof URL ? urlValue.href : urlValue.url;
    let dispatch: Awaited<ReturnType<typeof dispatchLocalModelCapacity>> = null;
    let wire = "";
    let contract: LocalModelServingContract | null = null;
    try {
      const control = await readModelCapacityCallerControl();
      if (control.mode === "disabled") {
        if (context.allowLegacy === false) throw new ModelCapacityDeferredError("disabled");
        return (baseRequest ?? fetch)(urlValue, init);
      }
      if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
      context.target = localModelTargetSchema.parse(context.target);
      if (init?.method !== "POST" || typeof init.body !== "string") throw new ModelCapacityDeferredError("provider_contract_unavailable");
      const body: unknown = JSON.parse(init.body);
      if (!object(body) || typeof body.model !== "string" || body.stream !== false || !Array.isArray(body.messages))
        throw new ModelCapacityDeferredError("provider_contract_unavailable");
      if (body.context_strategy !== undefined && body.context_strategy !== "raw")
        throw new ModelCapacityDeferredError("provider_contract_unavailable");
      contract = verifiedLocalModelContract(url, body.model, env);
      if (!contract || !localModelRouteReady(control.policy, context.target, contract, env)) throw new ModelCapacityDeferredError("provider_contract_unavailable");
      const maxOutput = body.max_tokens;
      const vision = body.messages.some(message => object(message) && Array.isArray(message.content)
        && message.content.some(part => object(part) && part.type === "image_url"));
      const isScreen = context.target.kind === "audit" && context.target.purpose === "screen";
      if (isScreen) {
        const proof = localModelScreenProofSchema.safeParse(context.screenProof);
        const images = body.messages.flatMap(message => object(message) && Array.isArray(message.content)
          ? message.content.filter(part => object(part) && part.type === "image_url") : []);
        const imageUrl = images.length === 1 && object(images[0].image_url) ? images[0].image_url.url : null;
        const screenUrl = "snapshot" in context.input ? context.input.snapshot.product.url : null;
        if (!proof.success || !freshLocalModelScreenProof(proof.data, screenUrl)
          || typeof imageUrl !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageUrl)
          || createHash("sha256").update(Buffer.from(imageUrl.slice("data:image/jpeg;base64,".length), "base64")).digest("hex") !== proof.data.screenshotHash)
          throw new ModelCapacityDeferredError("provider_contract_unavailable");
      } else if (context.screenProof) throw new ModelCapacityDeferredError("provider_contract_unavailable");
      if (!Number.isSafeInteger(maxOutput) || Number(maxOutput) < 1 || Number(maxOutput) > contract.maxOutputTokens
        || Buffer.byteLength(init.body) > contract.maxInputBytes || contract.totalTokenBound !== contract.contextWindowTokens
        || vision && !contract.capabilities.vision || body.response_format && !contract.capabilities.jsonSchema)
        throw new ModelCapacityDeferredError("provider_contract_unavailable");
      // 프롬프트·근거는 그대로 두고 검증한 backend의 실제 thinking 제어만 사용한다.
      const normalized = { ...body };
      // gateway 전용 metadata를 local OpenAI 서버·사설 relay에 보내지 않는다.
      delete normalized.context_strategy;
      delete normalized.chat_template_kwargs; delete normalized.enable_thinking; delete normalized.reasoning_effort; delete normalized.thinking_budget;
      Object.assign(normalized, localModelThinkingFields(contract));
      wire = JSON.stringify(normalized);
      if (Buffer.byteLength(wire) > contract.maxInputBytes) throw new ModelCapacityDeferredError("provider_contract_unavailable");
      const role = roleLeaseFromEnv("reviewer", env);
      if (!role) throw new ModelCapacityDeferredError("owner_unavailable");
      const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: role.instanceId, bootId: role.bootId },
        class: "background", pool: "reviewer", routeId: localModelRoute(context.target), provider: "local-direct", model: contract.model,
        workKey: `${localModelLogicalKey(context.target)}:${context.input.inputHash}` });
      const pending = await findOwnPendingModelRequest(identity);
      if (pending?.state === "dispatched" || pending?.state === "indeterminate") throw new ModelCapacityDeferredError("dispatched");
      const checked = { ...identity, requestId: pending?.requestId ?? randomUUID() };
      const wait = context.target.kind === "assist" && context.waitForCapacity === true;
      if (wait && (!init.signal || !Number.isSafeInteger(context.admissionDeadlineAt)))
        throw new ModelCapacityDeferredError("provider_contract_unavailable");
      let slot: Awaited<ReturnType<typeof requestLocalModelSlot>> | undefined;
      try {
        for (;;) {
          if (wait && (init.signal?.aborted || Date.now() >= context.admissionDeadlineAt!)) throw new ModelCapacityDeferredError("capacity");
          slot = await requestLocalModelSlot(checked, context.target);
          if (slot.kind === "granted") break;
          if (!wait || slot.reason !== "capacity") throw new ModelCapacityDeferredError(slot.reason);
          // One admission check/second per drain, well inside the unchanged 30s reservation.
          // Abort ends this wait; it never starts another model request or extends the caller budget.
          try { await delay(Math.max(1, Math.min(1000, context.admissionDeadlineAt! - Date.now())), undefined, { signal: init.signal! }); }
          catch { throw new ModelCapacityDeferredError("capacity"); }
        }
        if (wait && Date.now() >= context.admissionDeadlineAt!) throw new ModelCapacityDeferredError("capacity");
        if (init.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
        const binding = localModelBindingSchema.parse({ kind: "local_model_direct", version: 1, target: context.target,
          logicalWorkKey: localModelLogicalKey(context.target), routeId: identity.routeId, provider: "local-direct", model: contract.model,
          backendId: contract.backendId, physicalGroup: contract.physicalGroup, deploymentRevision: contract.deploymentRevision,
          inputHash: context.input.inputHash, sourceRevisionHash: context.input.sourceRevisionHash, reviewPolicyHash: context.input.policyHash,
          promptVersion: context.promptVersion, wireHash: digest(wire), servingContractHash: localModelContractHash(contract),
          totalTokenBound: contract.totalTokenBound, chargedTokens: contract.totalTokenBound,
          job: { name: context.lease.name, token: context.lease.token, requestedVersion: context.lease.requestedVersion } });
        dispatch = await dispatchLocalModelCapacity({ reservation: slot.reservation, identity, binding,
          input: context.input, job: context.lease, role, ...(isScreen ? { screenProof: context.screenProof } : {}) });
        if (!dispatch) throw new ModelCapacityDeferredError("reservation_lost");
      } catch (error) {
        try {
          if (wait) await cancelOwnPendingLocalModelRequest(checked, context.target);
          else if (slot?.kind === "granted") await cancelReservedModelSlot(slot.reservation);
        }
        catch (cleanup) { throw new AggregateError([error, cleanup], "local_model_reservation_cleanup_failed"); }
        throw error;
      }
    } catch (error) {
      if (error instanceof ModelCapacityDeferredError) deferred = error;
      else controlError = error;
      throw error;
    }
    if (!dispatch || !contract) throw new Error("local_model_dispatch_missing");
    let native: Awaited<ReturnType<typeof requestReservedLocalModel>>;
    try { native = await requestReservedLocalModel(dispatch, contract, url, { ...init, body: wire }, baseRequest); }
    catch (error) {
      // 요청 바이트 0 이 증명된 실패(엔진 다운·DNS)는 보내지 않은 호출로 정산해 칸을 바로 돌려준다; 그 밖은 전송 여부를 모른다.
      const unsent = error instanceof GatewayNotSentError ? error : null;
      try {
        if (unsent) await reconcileGatewayNotStarted(unsent.notStarted);
        else await markModelDispatchIndeterminate(dispatch, init?.signal?.aborted ? "local_abort" : "transport_unknown");
      } catch (cleanup) {
        if (unsent) await markUnsettledDispatch(dispatch);
        controlError = new AggregateError([error, cleanup], "local_model_transport_cleanup_failed");
      }
      throw unsent ? unsent.cause : error;
    }
    try {
      recordLocalModelWireObservation(native.response, digest(wire));
      if (native.terminal) await reconcileLocalModelTerminal(native.terminal);
      else {
        await markModelDispatchIndeterminate(dispatch, "transport_unknown");
        if (native.response.ok) { deferred = new ModelCapacityDeferredError("provider_contract_unavailable"); throw deferred; }
      }
    } catch (error) {
      if (native.terminal) await markUnsettledDispatch(dispatch);
      if (!(error instanceof ModelCapacityDeferredError)) controlError = error;
      throw error;
    }
    return native.response;
  }) as typeof fetch;
  try {
    const result = await run(request);
    if (controlError) throw controlError;
    if (deferred) throw deferred;
    return result;
  } catch (error) { throw controlError ?? deferred ?? error; }
}

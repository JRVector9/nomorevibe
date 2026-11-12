import { aiModelDisplayName } from "@/lib/operations/admin-ai-tasks";
import { readModelBacklog, readModelConsole } from "@/lib/operations/model-console-read";
import { listModelSampleComparisons } from "@/lib/operations/model-sample-compare-repository";
import { recommendStages } from "@/lib/operations/model-console";
import { SAMPLE_COMPARE_SUPPORTED } from "@/lib/operations/model-sample-compare";
import { ModelConsole } from "./ModelConsole";
import { ModelAddFlow, type ModelAddStep } from "../new/ModelAddFlow";
import { SampleCompare } from "../compare/SampleCompare";

/**
 * 「모델」 화면마다의 읽기 + 그리기(Suspense 안에서 기다린다). page.tsx 는 Next 가 정한 것만 내보낼 수 있어 여기 둔다 —
 * 시험은 이 함수를 그대로 기다려 그린다(저장소 모듈만 바꿔 끼운다).
 */
export async function ModelConsoleSlot({ selected, readOnly }: { selected: string | null; readOnly: boolean }) {
  return <ModelConsole data={await readModelConsole()} selected={selected} readOnly={readOnly} />;
}

export async function ModelAddSlot({ id, step, readOnly }: { id: string | null; step: ModelAddStep; readOnly: boolean }) {
  const data = await readModelConsole();
  const row = id ? data.view.rows.find(entry => entry.id === id) ?? null : null;
  const recommendations = step === 3 && row ? recommendStages(await readModelBacklog(), row.connection, SAMPLE_COMPARE_SUPPORTED, row.models[0] ?? null) : [];
  return <ModelAddFlow step={row ? step : 1} row={row} missing={!!id && !row} recommendations={recommendations} secretBox={data.secretBox} readOnly={readOnly}
    taken={data.view.rows.flatMap(entry => [entry.connection.label, aiModelDisplayName(entry.connection)])} />;
}

export async function SampleCompareSlot({ task, candidate, model, readOnly }: { task: string; candidate: string | null; model: string | null; readOnly: boolean }) {
  const [data, records] = await Promise.all([readModelConsole(), listModelSampleComparisons(task, 5).catch(() => null)]);
  return <SampleCompare task={task} rows={data.view.rows} candidate={candidate} model={model} records={records} readOnly={readOnly} />;
}

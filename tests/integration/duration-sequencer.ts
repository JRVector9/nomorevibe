import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { planShards, readDurations } from "../../scripts/integration-shards.mjs";

/**
 * `--shard=i/n` 을 파일 시간 기록으로 나눈다(scripts/integration-shards.mjs).
 * 묶음 안 실행 순서는 vitest 기본 그대로다. `--shard` 없이 돌리면 이 클래스는 순서에 관여하지 않는다.
 */
export class DurationSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const relative = (spec: TestSpecification) => path.relative(root, spec.moduleId).split(path.sep).join("/");
    const plan = planShards(files.map(relative), readDurations(root), shard.count);
    const mine = plan[shard.index - 1];
    console.info(`[integration-shard] ${shard.index}/${shard.count}: ${mine.files.length} files, ~${Math.round(mine.seconds)}s recorded`
      + ` (all shards: ${plan.map(item => Math.round(item.seconds)).join("/")}s)`);
    const chosen = new Set(mine.files);
    return files.filter(spec => chosen.has(relative(spec)));
  }
}
